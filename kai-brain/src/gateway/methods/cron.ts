/**
 * Cron Methods
 *
 * RPC handlers for scheduled job management.
 */
import {
  cronService,
  type ScheduleKind,
  type CreateJobParams,
} from "../services/cron.js";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { createLogger } from "../../lib/logger.js";
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from "../services/session-identity.js";

const log = createLogger("gateway", { method: "cron" });

export interface CronListParams {
  sessionKey?: string;
  includeDisabled?: boolean;
}

export interface CronJobInfo {
  id: string;
  sessionKey: string;
  name: string;
  description?: string;
  scheduleKind: string;
  scheduleValue: string;
  timezone?: string;
  payload: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  lastRunAt?: number;
  lastRunStatus?: string;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
}

export interface CronListResult {
  jobs: CronJobInfo[];
}

export interface CronAddParams {
  sessionKey: string;
  /**
   * @deprecated Ignored when gateway auth context is present.
   */
  userId?: string;
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

export interface CronAddResult {
  job: CronJobInfo;
}

export interface CronUpdateParams {
  jobId: string;
  name?: string;
  description?: string;
  scheduleKind?: ScheduleKind;
  scheduleValue?: string;
  timezone?: string;
  payload?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
}

export interface CronUpdateResult {
  job: CronJobInfo;
}

export interface CronRemoveParams {
  jobId: string;
}

export interface CronRemoveResult {
  deleted: boolean;
}

export interface CronRunParams {
  jobId: string;
}

export interface CronRunResult {
  triggered: boolean;
}

async function isSessionOwnedByUser(sessionId: string, userId: string): Promise<boolean> {
  const [session] = await db
    .select({ id: avaSessions.id })
    .from(avaSessions)
    .where(and(eq(avaSessions.id, sessionId), eq(avaSessions.userId, userId)))
    .limit(1);
  return !!session;
}

async function resolveCronSessionId(params: {
  sessionKey?: string;
  authUserId?: string;
}): Promise<string | RpcError | null> {
  const rawSessionKey = params.sessionKey?.trim();

  if (!rawSessionKey) {
    return null;
  }

  if (params.authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: params.authUserId,
      sessionKey: rawSessionKey,
    });
    if (!identity) {
      return createError(ErrorCodes.NOT_FOUND, `Session ${rawSessionKey} not found`);
    }
    return identity.sessionId;
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: rawSessionKey,
  });
  if (!identity) {
    return createError(ErrorCodes.NOT_FOUND, `Session ${rawSessionKey} not found`);
  }

  return identity.sessionId;
}

async function assertJobOwnership(jobId: string, authUserId?: string): Promise<RpcError | null> {
  if (!authUserId) {
    return null;
  }
  const job = await cronService.getJob(jobId);
  if (!job) {
    return createError(ErrorCodes.NOT_FOUND, `Job ${jobId} not found`);
  }
  if (job.userId !== authUserId) {
    return createError(ErrorCodes.UNAUTHORIZED, "Not authorized for this job");
  }
  return null;
}

async function jobToInfo(
  job: Awaited<ReturnType<typeof cronService.getJob>>
): Promise<CronJobInfo | null> {
  if (!job) return null;
  const identity = await resolveGatewaySessionIdentity({
    sessionId: job.sessionId,
  });
  if (!identity) return null;
  return {
    id: job.id,
    sessionKey: identity.sessionKey,
    name: job.name,
    description: job.description ?? undefined,
    scheduleKind: job.scheduleKind,
    scheduleValue: job.scheduleValue,
    timezone: job.timezone ?? undefined,
    payload: job.payload,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    lastRunAt: job.lastRunAt?.getTime(),
    lastRunStatus: job.lastRunStatus ?? undefined,
    nextRunAt: job.nextRunAt?.getTime(),
    runCount: parseInt(job.runCount || "0", 10),
    createdAt: job.createdAt?.getTime() ?? Date.now(),
  };
}

export async function cronList(
  params: CronListParams,
  authUserId?: string,
): Promise<CronListResult | RpcError> {
  const requestedSessionId = (params as { sessionId?: string }).sessionId;
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }
  try {
    const resolvedSessionId = await resolveCronSessionId({
      sessionKey: params.sessionKey,
      authUserId,
    });
    if (resolvedSessionId && typeof resolvedSessionId !== "string") {
      return resolvedSessionId;
    }

    if (authUserId && resolvedSessionId) {
      const owned = await isSessionOwnedByUser(resolvedSessionId, authUserId);
      if (!owned) {
        return createError(ErrorCodes.NOT_FOUND, `Session not found`);
      }
    }

    const jobs = await cronService.listJobs(
      resolvedSessionId ?? undefined,
      params.includeDisabled,
      authUserId,
    );
    const mapped = await Promise.all(jobs.map((j) => jobToInfo(j)));
    return {
      jobs: mapped.filter((job): job is CronJobInfo => job !== null),
    };
  } catch (error) {
    log.error({ err: error, sessionKey: params.sessionKey }, "Failed to list cron jobs");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list cron jobs");
  }
}

export async function cronAdd(
  params: CronAddParams,
  authUserId?: string,
): Promise<CronAddResult | RpcError> {
  const { sessionKey, userId: requestedUserId, name, scheduleKind, scheduleValue, payload } =
    params;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;
  const userId = authUserId ?? requestedUserId;

  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  if (
    !sessionKey ||
    !userId ||
    !name ||
    !scheduleKind ||
    !scheduleValue ||
    !payload
  ) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionKey, userId, name, scheduleKind, scheduleValue, and payload are required"
    );
  }

  // Validate schedule kind
  if (!["at", "every", "cron"].includes(scheduleKind)) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'scheduleKind must be "at", "every", or "cron"'
    );
  }

  try {
    const resolvedSessionId = await resolveCronSessionId({
      sessionKey,
      authUserId,
    });
    if (typeof resolvedSessionId !== "string") {
      return (
        resolvedSessionId ??
        createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`)
      );
    }

    if (authUserId) {
      const owned = await isSessionOwnedByUser(resolvedSessionId, authUserId);
      if (!owned) {
        return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
      }
    }

    const job = await cronService.createJob({
      ...params,
      sessionId: resolvedSessionId,
      userId,
    } as CreateJobParams);
    const jobInfo = await jobToInfo(job);
    if (!jobInfo) {
      return createError(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to resolve session key for cron job",
      );
    }
    return { job: jobInfo };
  } catch (error) {
    log.error({ err: error, sessionKey }, "Failed to create cron job");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to create cron job");
  }
}

export async function cronUpdate(
  params: CronUpdateParams,
  authUserId?: string,
): Promise<CronUpdateResult | RpcError> {
  const { jobId, ...updates } = params;

  if (!jobId) {
    return createError(ErrorCodes.INVALID_PARAMS, "jobId is required");
  }

  try {
    const ownershipError = await assertJobOwnership(jobId, authUserId);
    if (ownershipError) {
      return ownershipError;
    }

    const job = await cronService.updateJob(jobId, updates);
    if (!job) {
      return createError(ErrorCodes.NOT_FOUND, `Job ${jobId} not found`);
    }
    const jobInfo = await jobToInfo(job);
    if (!jobInfo) {
      return createError(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to resolve session key for cron job",
      );
    }
    return { job: jobInfo };
  } catch (error) {
    log.error({ err: error, jobId }, "Failed to update cron job");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to update cron job");
  }
}

export async function cronRemove(
  params: CronRemoveParams,
  authUserId?: string,
): Promise<CronRemoveResult | RpcError> {
  const { jobId } = params;

  if (!jobId) {
    return createError(ErrorCodes.INVALID_PARAMS, "jobId is required");
  }

  try {
    const ownershipError = await assertJobOwnership(jobId, authUserId);
    if (ownershipError) {
      return ownershipError;
    }

    const deleted = await cronService.deleteJob(jobId);
    return { deleted };
  } catch (error) {
    log.error({ err: error, jobId }, "Failed to remove cron job");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to remove cron job");
  }
}

export async function cronRun(
  params: CronRunParams,
  authUserId?: string,
): Promise<CronRunResult | RpcError> {
  const { jobId } = params;

  if (!jobId) {
    return createError(ErrorCodes.INVALID_PARAMS, "jobId is required");
  }

  try {
    const ownershipError = await assertJobOwnership(jobId, authUserId);
    if (ownershipError) {
      return ownershipError;
    }

    const triggered = await cronService.triggerJob(jobId);
    if (!triggered) {
      return createError(ErrorCodes.NOT_FOUND, `Job ${jobId} not found`);
    }
    return { triggered };
  } catch (error) {
    log.error({ err: error, jobId }, "Failed to run cron job");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to run cron job");
  }
}
