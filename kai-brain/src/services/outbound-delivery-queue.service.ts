import { and, eq, inArray, isNull, or, sql, lte, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { avaOutboundDeliveryJobs } from "../db/schema/outbound-delivery-jobs.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("agent");

export type OutboundDeliveryJobStatus =
  | "pending"
  | "sending"
  | "sent"
  | "retry"
  | "dead";

export interface OutboundDeliveryJob {
  id: string;
  status: OutboundDeliveryJobStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  expiresAt: Date | null;
  sessionId?: string;
  routeSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  reason?: string;
  lastError?: string;
  providerMeta?: Record<string, unknown>;
  claimedBy?: string;
  claimedAt?: Date;
  claimExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueOutboundJobInput {
  sessionId?: string;
  routeSnapshot?: Record<string, unknown>;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  reason?: string;
  expiresAt?: Date;
  nextAttemptAt?: Date;
}

const DEFAULT_CLAIM_TTL_SECONDS = 60;

function mapRow(row: Record<string, unknown>): OutboundDeliveryJob {
  return {
    id: String(row.id),
    status: row.status as OutboundDeliveryJobStatus,
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
    nextAttemptAt: (row.nextAttemptAt ?? row.next_attempt_at) as Date,
    expiresAt: (row.expiresAt ?? row.expires_at) as Date | null,
    sessionId:
      typeof row.sessionId === "string"
        ? row.sessionId
        : typeof row.session_id === "string"
          ? row.session_id
          : undefined,
    routeSnapshot: (row.routeSnapshot ??
      row.route_snapshot ??
      {}) as Record<string, unknown>,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    idempotencyKey:
      typeof row.idempotencyKey === "string"
        ? row.idempotencyKey
        : typeof row.idempotency_key === "string"
          ? row.idempotency_key
          : undefined,
    reason:
      typeof row.reason === "string"
        ? row.reason
        : undefined,
    lastError:
      typeof row.lastError === "string"
        ? row.lastError
        : typeof row.last_error === "string"
          ? row.last_error
          : undefined,
    providerMeta: (row.providerMeta ??
      row.provider_meta ??
      {}) as Record<string, unknown>,
    claimedBy:
      typeof row.claimedBy === "string"
        ? row.claimedBy
        : typeof row.claimed_by === "string"
          ? row.claimed_by
          : undefined,
    claimedAt: (row.claimedAt ?? row.claimed_at) as Date | undefined,
    claimExpiresAt: (row.claimExpiresAt ??
      row.claim_expires_at) as Date | undefined,
    createdAt: (row.createdAt ?? row.created_at) as Date,
    updatedAt: (row.updatedAt ?? row.updated_at) as Date,
  };
}

export class OutboundDeliveryQueueService {
  async enqueueOutboundJob(input: EnqueueOutboundJobInput): Promise<OutboundDeliveryJob> {
    const values: typeof avaOutboundDeliveryJobs.$inferInsert = {
      status: "pending",
      attemptCount: 0,
      expiresAt: input.expiresAt ?? null,
      sessionId: input.sessionId?.trim() || null,
      routeSnapshot: input.routeSnapshot ?? {},
      payload: input.payload,
      idempotencyKey: input.idempotencyKey?.trim() || null,
      reason: input.reason?.slice(0, 120) || null,
      updatedAt: new Date(),
    };

    // Keep DB clock as source-of-truth to avoid app/DB clock skew.
    if (input.nextAttemptAt) {
      values.nextAttemptAt = input.nextAttemptAt;
    }

    const [inserted] = await db
      .insert(avaOutboundDeliveryJobs)
      .values(values)
      .returning();

    return mapRow(inserted as unknown as Record<string, unknown>);
  }

  async claimReadyJobs(
    workerId: string,
    limit = 20,
    claimTtlSeconds = DEFAULT_CLAIM_TTL_SECONDS,
  ): Promise<OutboundDeliveryJob[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const ttl = Math.max(5, Math.floor(claimTtlSeconds));
    const normalizedWorkerId = workerId.trim() || randomUUID();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttl * 1000);

    const result = await db.execute(sql`
      WITH picked AS (
        SELECT id
        FROM ava_outbound_delivery_jobs
        WHERE status IN ('pending', 'retry')
          AND next_attempt_at <= ${now}
          AND (expires_at IS NULL OR expires_at > ${now})
          AND (claim_expires_at IS NULL OR claim_expires_at < ${now})
        ORDER BY created_at ASC
        LIMIT ${safeLimit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ava_outbound_delivery_jobs j
      SET status = 'sending',
          claimed_by = ${normalizedWorkerId},
          claimed_at = ${now},
          claim_expires_at = ${claimExpiresAt},
          updated_at = ${now}
      FROM picked
      WHERE j.id = picked.id
      RETURNING j.*;
    `);

    const rows = ((result as unknown as { rows?: unknown[] }).rows ??
      []) as Array<Record<string, unknown>>;
    return rows.map((row) => mapRow(row));
  }

  async markJobSent(
    jobId: string,
    providerMeta?: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(avaOutboundDeliveryJobs)
      .set({
        status: "sent",
        providerMeta: providerMeta ?? {},
        lastError: null,
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(avaOutboundDeliveryJobs.id, jobId));
  }

  async markJobRetry(
    jobId: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await db
      .update(avaOutboundDeliveryJobs)
      .set({
        status: "retry",
        attemptCount: sql`${avaOutboundDeliveryJobs.attemptCount} + 1`,
        lastError: error.slice(0, 2000),
        nextAttemptAt,
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(avaOutboundDeliveryJobs.id, jobId));
  }

  async markJobDead(jobId: string, error: string): Promise<void> {
    await db
      .update(avaOutboundDeliveryJobs)
      .set({
        status: "dead",
        lastError: error.slice(0, 2000),
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(avaOutboundDeliveryJobs.id, jobId));
  }

  async recoverStuckJobs(workerId: string): Promise<number> {
    const now = new Date();
    const recovered = await db
      .update(avaOutboundDeliveryJobs)
      .set({
        status: "retry",
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastError: `Recovered stale sending claim by ${workerId}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(avaOutboundDeliveryJobs.status, "sending"),
          lte(avaOutboundDeliveryJobs.claimExpiresAt, now),
        ),
      )
      .returning({ id: avaOutboundDeliveryJobs.id });

    if (recovered.length > 0) {
      log.info({ count: recovered.length }, "Recovered stale outbound jobs");
    }

    return recovered.length;
  }

  async cancelPendingForSession(sessionId: string): Promise<number> {
    const target = sessionId.trim();
    if (!target) return 0;

    const cancelled = await db
      .update(avaOutboundDeliveryJobs)
      .set({
        status: "dead",
        lastError: "Session archived/deleted before delivery",
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(avaOutboundDeliveryJobs.sessionId, target),
          inArray(avaOutboundDeliveryJobs.status, ["pending", "retry", "sending"]),
        ),
      )
      .returning({ id: avaOutboundDeliveryJobs.id });

    return cancelled.length;
  }

  async hasPendingJobs(): Promise<boolean> {
    const [row] = await db
      .select({ id: avaOutboundDeliveryJobs.id })
      .from(avaOutboundDeliveryJobs)
      .where(
        and(
          inArray(avaOutboundDeliveryJobs.status, ["pending", "retry", "sending"]),
          or(
            isNull(avaOutboundDeliveryJobs.expiresAt),
            gt(avaOutboundDeliveryJobs.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  async getNextReadyDelayMs(): Promise<number | null> {
    const [next] = await db
      .select({ nextAttemptAt: avaOutboundDeliveryJobs.nextAttemptAt })
      .from(avaOutboundDeliveryJobs)
      .where(
        and(
          inArray(avaOutboundDeliveryJobs.status, ["pending", "retry"]),
          or(
            isNull(avaOutboundDeliveryJobs.expiresAt),
            gt(avaOutboundDeliveryJobs.expiresAt, new Date()),
          ),
        ),
      )
      .orderBy(avaOutboundDeliveryJobs.nextAttemptAt)
      .limit(1);

    if (!next?.nextAttemptAt) {
      return null;
    }
    return Math.max(0, next.nextAttemptAt.getTime() - Date.now());
  }

  async dropExpiredJobs(): Promise<number> {
    const deleted = await db
      .delete(avaOutboundDeliveryJobs)
      .where(
        and(
          inArray(avaOutboundDeliveryJobs.status, ["pending", "retry", "sending"]),
          lte(avaOutboundDeliveryJobs.expiresAt, new Date()),
        ),
      )
      .returning({ id: avaOutboundDeliveryJobs.id });
    return deleted.length;
  }
}

export const outboundDeliveryQueueService = new OutboundDeliveryQueueService();
