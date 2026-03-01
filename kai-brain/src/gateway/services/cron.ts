/**
 * Cron Service
 *
 * Timer-based scheduler for automated agent execution.
 */
import { Cron } from "croner";
import { db } from "../../db/client.js";
import {
  avaCronJobs,
  type CronJob,
  type NewCronJob,
} from "../../db/schema/cron.js";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { queueService } from "./queue.js";
import { runtime } from "../runtime.js";
import type { CronFiredEvent } from "../protocol/events.js";
import { cronLogger as log } from "../../lib/logger.js";
import { resolveGatewaySessionIdentity } from "./session-identity.js";
import { getConfig } from "../../lib/config-loader.js";

export type ScheduleKind = "at" | "every" | "cron";

export interface CreateJobParams {
  sessionId: string;
  userId: string;
  name: string;
  description?: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  timezone?: string;
  payload: string;
  deleteAfterRun?: boolean;
  source?: string;
  sourceMetadata?: Record<string, unknown>;
}

export interface UpdateJobParams {
  name?: string;
  description?: string;
  scheduleKind?: ScheduleKind;
  scheduleValue?: string;
  timezone?: string;
  payload?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
}

// Maximum setTimeout delay (2^31 - 1 ms, ~24.8 days)
const MAX_TIMEOUT_MS = 2147483647;
const CRON_CLAIM_LEASE_SECONDS = 300;
const CRON_MAX_CONCURRENT_RUNS = Math.max(1, getConfig().cron.maxConcurrentRuns);

export async function runCronJobsBounded<T extends { sessionId: string }>(
  jobs: T[],
  maxConcurrentRuns: number,
  executeJob: (job: T) => Promise<void>,
): Promise<void> {
  if (jobs.length === 0) return;

  const maxConcurrent = Math.max(1, Math.floor(maxConcurrentRuns));
  const jobsBySession = new Map<string, T[]>();
  for (const job of jobs) {
    const bucket = jobsBySession.get(job.sessionId);
    if (bucket) bucket.push(job);
    else jobsBySession.set(job.sessionId, [job]);
  }

  const sessionQueues = Array.from(jobsBySession.values());
  let cursor = 0;
  const workerCount = Math.min(maxConcurrent, sessionQueues.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= sessionQueues.length) break;
      const sessionJobs = sessionQueues[currentIndex] ?? [];
      for (const job of sessionJobs) {
        await executeJob(job);
      }
    }
  });

  await Promise.all(workers);
}

class CronService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeCronInstances = new Map<string, Cron>();

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("Cron service started");

    // Initialize next run times for all enabled jobs
    this.initializeJobs().then(() => {
      this.armTimer();
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Stop all active cron instances
    for (const cron of this.activeCronInstances.values()) {
      cron.stop();
    }
    this.activeCronInstances.clear();

    log.info("Cron service stopped");
  }

  /**
   * Create a new scheduled job
   */
  async createJob(params: CreateJobParams): Promise<CronJob> {
    const nextRunAt = this.computeNextRun(
      params.scheduleKind,
      params.scheduleValue,
      params.timezone
    );

    const [job] = await db
      .insert(avaCronJobs)
      .values({
        sessionId: params.sessionId,
        userId: params.userId,
        name: params.name,
        description: params.description,
        scheduleKind: params.scheduleKind,
        scheduleValue: params.scheduleValue,
        timezone: params.timezone || "UTC",
        payload: params.payload,
        deleteAfterRun: params.deleteAfterRun || false,
        source: params.source || "agent",
        sourceMetadata: params.sourceMetadata,
        nextRunAt,
      })
      .returning();

    // Re-arm timer if this job is sooner than current next
    this.armTimer();

    return job;
  }

  /**
   * Update an existing job
   */
  async updateJob(
    jobId: string,
    params: UpdateJobParams
  ): Promise<CronJob | null> {
    const updates: Partial<NewCronJob> = { ...params, updatedAt: new Date() };

    // Recompute next run if schedule changed
    if (params.scheduleKind || params.scheduleValue || params.timezone) {
      const existing = await this.getJob(jobId);
      if (existing) {
        const kind = params.scheduleKind || existing.scheduleKind;
        const value = params.scheduleValue || existing.scheduleValue;
        const tz = params.timezone || existing.timezone || "UTC";
        updates.nextRunAt = this.computeNextRun(
          kind as ScheduleKind,
          value,
          tz
        );
      }
    }

    const [job] = await db
      .update(avaCronJobs)
      .set(updates)
      .where(eq(avaCronJobs.id, jobId))
      .returning();

    this.armTimer();
    return job || null;
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const result = await db
      .delete(avaCronJobs)
      .where(eq(avaCronJobs.id, jobId));
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get a job by ID
   */
  async getJob(jobId: string): Promise<CronJob | null> {
    const [job] = await db
      .select()
      .from(avaCronJobs)
      .where(eq(avaCronJobs.id, jobId))
      .limit(1);
    return job || null;
  }

  /**
   * List jobs for a session
   */
  async listJobs(
    sessionId?: string,
    includeDisabled = false,
    userId?: string,
  ): Promise<CronJob[]> {
    const conditions = [];
    if (sessionId) {
      conditions.push(eq(avaCronJobs.sessionId, sessionId));
    }
    if (userId) {
      conditions.push(eq(avaCronJobs.userId, userId));
    }
    if (!includeDisabled) {
      conditions.push(eq(avaCronJobs.enabled, true));
    }

    return db
      .select()
      .from(avaCronJobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(avaCronJobs.nextRunAt);
  }

  /**
   * Manually trigger a job
   */
  async triggerJob(jobId: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job) return false;

    await this.executeJob(job);
    return true;
  }

  /**
   * Compute next run time for a schedule
   */
  private computeNextRun(
    kind: ScheduleKind,
    value: string,
    timezone?: string
  ): Date | null {
    const now = Date.now();

    switch (kind) {
      case "at": {
        // value is an ISO timestamp or ms since epoch
        const atMs = value.includes("T")
          ? new Date(value).getTime()
          : parseInt(value, 10);
        if (isNaN(atMs) || atMs <= now) return null;
        return new Date(atMs);
      }

      case "every": {
        // value is interval in ms
        const intervalMs = parseInt(value, 10);
        if (isNaN(intervalMs) || intervalMs <= 0) return null;
        return new Date(now + intervalMs);
      }

      case "cron": {
        // value is a cron expression
        try {
          const cron = new Cron(value, { timezone: timezone || "UTC" });
          const next = cron.nextRun();
          return next;
        } catch {
          return null;
        }
      }

      default:
        return null;
    }
  }

  /**
   * Initialize next run times for all enabled jobs on startup
   */
  private async initializeJobs(): Promise<void> {
    const jobs = await db
      .select()
      .from(avaCronJobs)
      .where(eq(avaCronJobs.enabled, true));

    for (const job of jobs) {
      if (!job.nextRunAt) {
        const nextRun = this.computeNextRun(
          job.scheduleKind as ScheduleKind,
          job.scheduleValue,
          job.timezone || "UTC"
        );
        if (nextRun) {
          await db
            .update(avaCronJobs)
            .set({ nextRunAt: nextRun })
            .where(eq(avaCronJobs.id, job.id));
        }
      }
    }
  }

  /**
   * Arm the timer for the next job
   */
  private armTimer(): void {
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Find next job to run
    this.findNextJob().then((job) => {
      if (!job || !job.nextRunAt) return;

      const now = Date.now();
      const delay = Math.max(job.nextRunAt.getTime() - now, 0);
      const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);

      this.timer = setTimeout(() => {
        this.onTimer();
      }, clampedDelay);

      // Don't keep process alive for timer
      this.timer.unref?.();
    });
  }

  private async claimDueJobs(limit: number): Promise<CronJob[]> {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const result = await db.execute(sql`
      WITH due AS (
        SELECT id
        FROM ava_cron_jobs
        WHERE enabled = true
          AND next_run_at IS NOT NULL
          AND next_run_at <= now()
        ORDER BY next_run_at ASC, id ASC
        LIMIT ${boundedLimit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ava_cron_jobs AS j
      SET next_run_at = now() + (${CRON_CLAIM_LEASE_SECONDS} * interval '1 second'),
          updated_at = now()
      FROM due
      WHERE j.id = due.id
      RETURNING j.*;
    `);

    const rows = ((result as unknown as { rows?: unknown[] }).rows ?? []) as CronJob[];
    return rows;
  }

  /**
   * Timer callback - find and execute due jobs
   */
  private async onTimer(): Promise<void> {
    if (!this.running) return;

    try {
      const batchSize = Math.max(CRON_MAX_CONCURRENT_RUNS * 4, CRON_MAX_CONCURRENT_RUNS);
      const dueJobs = await this.claimDueJobs(batchSize);
      if (dueJobs.length > 0) {
        log.info(
          {
            claimed: dueJobs.length,
            maxConcurrentRuns: CRON_MAX_CONCURRENT_RUNS,
          },
          "Claimed due cron jobs",
        );
      }
      await runCronJobsBounded(
        dueJobs,
        CRON_MAX_CONCURRENT_RUNS,
        async (job) => this.executeJob(job),
      );
    } catch (error) {
      log.error({ err: error }, "Cron timer error");
    } finally {
      // Re-arm timer for next job
      this.armTimer();
    }
  }

  /**
   * Execute a scheduled job
   */
  private async executeJob(job: CronJob): Promise<void> {
    log.info({ jobId: job.id, jobName: job.name }, "Executing cron job");

    try {
      const sessionIdentity = await resolveGatewaySessionIdentity({
        sessionId: job.sessionId,
      });
      const sessionKey = sessionIdentity?.sessionKey ?? job.sessionId;

      // Broadcast event
      const firedAt = Date.now();
      const event: CronFiredEvent = {
        event: "cron.fired",
        payload: {
          jobId: job.id,
          sessionKey,
          firedAt,
        },
      };
      runtime.broadcast(event, job.sessionId);

      // Enqueue the message for agent execution in ISOLATED mode
      // This runs the task without conversation history to avoid confusion
      await queueService.enqueue(job.sessionId, job.userId, job.payload, {
        source: "cron",
        mode: "isolated", // Run without conversation history
        sourceMetadata: {
          jobId: job.id,
          jobName: job.name,
          ...(job.sourceMetadata as Record<string, unknown> | null),
        },
      });

      // Update job status
      const runCount = parseInt(job.runCount || "0", 10) + 1;
      const nextRunAt = this.computeNextRun(
        job.scheduleKind as ScheduleKind,
        job.scheduleValue,
        job.timezone || "UTC"
      );

      if (job.deleteAfterRun || !nextRunAt) {
        // Delete one-shot jobs
        await db.delete(avaCronJobs).where(eq(avaCronJobs.id, job.id));
      } else {
        // Update for next run
        await db
          .update(avaCronJobs)
          .set({
            lastRunAt: new Date(),
            lastRunStatus: "success",
            lastRunError: null,
            nextRunAt,
            runCount: String(runCount),
            updatedAt: new Date(),
          })
          .where(eq(avaCronJobs.id, job.id));
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error({ jobId: job.id, err: errorMessage }, "Cron job failed");

      if (job.deleteAfterRun) {
        await db.delete(avaCronJobs).where(eq(avaCronJobs.id, job.id));
        return;
      }

      const runCount = parseInt(job.runCount || "0", 10) + 1;
      const nextRunAt = this.computeNextRun(
        job.scheduleKind as ScheduleKind,
        job.scheduleValue,
        job.timezone || "UTC"
      );

      // Update job with error and schedule next attempt.
      await db
        .update(avaCronJobs)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: "error",
          lastRunError: errorMessage,
          nextRunAt,
          runCount: String(runCount),
          updatedAt: new Date(),
        })
        .where(eq(avaCronJobs.id, job.id));
    }
  }

  /**
   * Find the next job to run
   */
  private async findNextJob(): Promise<CronJob | null> {
    const [job] = await db
      .select()
      .from(avaCronJobs)
      .where(
        and(eq(avaCronJobs.enabled, true), isNotNull(avaCronJobs.nextRunAt))
      )
      .orderBy(avaCronJobs.nextRunAt)
      .limit(1);

    return job || null;
  }
}

export const cronService = new CronService();
