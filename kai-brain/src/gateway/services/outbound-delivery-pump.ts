import { randomUUID } from "node:crypto";
import { createLogger } from "../../lib/logger.js";
import {
  resolveDeliveryRoute,
  routeDelivery,
  type DeliveryRouteResolution,
} from "./delivery-router.js";
import { outboundDeliveryQueueService } from "../../services/outbound-delivery-queue.service.js";
import { canDeliverToSession } from "./session-lifecycle-guard.js";

const log = createLogger("agent");

const MAX_ATTEMPTS = 7;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;
const DEFAULT_COALESCE_MS = 150;
const RETRY_COALESCE_MS = 1_000;

export type OutboundPumpRunResult =
  | { status: "ran"; processed: number }
  | { status: "skipped"; reason: string };

export type OutboundPumpHandler = (opts: {
  reason?: string;
}) => Promise<OutboundPumpRunResult>;

let handler: OutboundPumpHandler | null = runOutboundPumpInternal;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let running = false;
let queuedReason: string | undefined;
let needsAnotherRun = false;

function resolveBackoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return BACKOFF_MS[0];
  const idx = Math.min(attemptCount - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

async function resolveJobTarget(job: {
  sessionId?: string;
  routeSnapshot: Record<string, unknown>;
}): Promise<DeliveryRouteResolution | null> {
  const snapshotExternalId =
    typeof job.routeSnapshot.externalId === "string"
      ? job.routeSnapshot.externalId
      : undefined;
  return resolveDeliveryRoute({
    sessionId: job.sessionId,
    preferredExternalId: snapshotExternalId,
  });
}

async function runOutboundPumpInternal(
  opts: { reason?: string } = {},
): Promise<OutboundPumpRunResult> {
  const workerId = `outbound-pump:${process.pid}:${randomUUID()}`;
  await outboundDeliveryQueueService.recoverStuckJobs(workerId);
  await outboundDeliveryQueueService.dropExpiredJobs();

  const claimed = await outboundDeliveryQueueService.claimReadyJobs(workerId, 20);
  if (claimed.length === 0) {
    const nextDelay = await outboundDeliveryQueueService.getNextReadyDelayMs();
    if (nextDelay !== null) {
      wakeOutboundPump("retry", Math.max(50, nextDelay));
    }
    return { status: "skipped", reason: "no-jobs" };
  }

  let processed = 0;
  for (const job of claimed) {
    processed += 1;
    const content = typeof job.payload.content === "string" ? job.payload.content : "";
    if (!content.trim()) {
      await outboundDeliveryQueueService.markJobDead(job.id, "empty-payload");
      continue;
    }

    if (job.sessionId) {
      const canDeliver = await canDeliverToSession(job.sessionId);
      if (!canDeliver) {
        await outboundDeliveryQueueService.markJobDead(
          job.id,
          "session-not-deliverable",
        );
        continue;
      }
    }

    const route = await resolveJobTarget(job);
    if (!route) {
      await outboundDeliveryQueueService.markJobDead(job.id, "no-delivery-target");
      continue;
    }

    const routed = await routeDelivery({
      sessionId: route.sessionId,
      targetOverride: route.target,
      content,
      idempotencyKey: job.idempotencyKey ?? undefined,
      idempotencyOwner: job.id,
      durability: "direct",
      reason: opts.reason ?? "outbound-pump",
    });

    if (routed.status === "sent") {
      await outboundDeliveryQueueService.markJobSent(job.id, {
        deliveredBy: workerId,
      });
      continue;
    }

    if (routed.status === "suppressed") {
      await outboundDeliveryQueueService.markJobSent(job.id, {
        duplicate: true,
        reason: routed.reason,
      });
      continue;
    }

    if (routed.reason === "no-delivery-target") {
      await outboundDeliveryQueueService.markJobDead(job.id, "no-delivery-target");
      continue;
    }

    const nextAttemptCount = job.attemptCount + 1;
    if (nextAttemptCount >= MAX_ATTEMPTS) {
      await outboundDeliveryQueueService.markJobDead(job.id, "delivery-retries-exhausted");
      continue;
    }

    const backoffMs = resolveBackoffMs(nextAttemptCount);
    const nextAttemptAt = new Date(Date.now() + backoffMs);
    await outboundDeliveryQueueService.markJobRetry(
      job.id,
      "delivery-failed",
      nextAttemptAt,
    );
  }

  // Schedule follow-up for queued retries/pending jobs.
  const nextDelay = await outboundDeliveryQueueService.getNextReadyDelayMs();
  if (nextDelay !== null) {
    wakeOutboundPump("retry", Math.max(50, nextDelay));
  }

  return { status: "ran", processed };
}

function schedulePump(delayMs: number): void {
  const safeDelay = Number.isFinite(delayMs)
    ? Math.max(0, Math.floor(delayMs))
    : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + safeDelay;

  if (timer) {
    if (timerDueAt !== null && timerDueAt <= dueAt) {
      return;
    }
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
  }

  timerDueAt = dueAt;
  timer = setTimeout(() => {
    timer = null;
    timerDueAt = null;
    void drainPump();
  }, safeDelay);
  timer.unref?.();
}

async function drainPump(): Promise<void> {
  const activeHandler = handler;
  if (!activeHandler) {
    return;
  }

  if (running) {
    needsAnotherRun = true;
    return;
  }

  const reason = queuedReason;
  queuedReason = undefined;
  running = true;

  try {
    const result = await activeHandler({ reason });
    if (result.status === "skipped" && result.reason === "queue-busy") {
      wakeOutboundPump("retry", RETRY_COALESCE_MS);
    }
  } catch (error) {
    log.warn(
      { err: error },
      "Outbound pump run failed; scheduling retry",
    );
    wakeOutboundPump("retry", RETRY_COALESCE_MS);
  } finally {
    running = false;
    if (needsAnotherRun || queuedReason) {
      needsAnotherRun = false;
      if (!timer) {
        schedulePump(DEFAULT_COALESCE_MS);
      }
    }
  }
}

export function setOutboundPumpHandler(
  next: OutboundPumpHandler | null,
): () => void {
  handler = next;
  return () => {
    if (handler === next) {
      handler = null;
    }
  };
}

export function wakeOutboundPump(reason = "wake", coalesceMs = DEFAULT_COALESCE_MS): void {
  queuedReason = reason;
  schedulePump(coalesceMs);
}

export async function runOutboundPumpOnce(opts?: {
  reason?: string;
}): Promise<OutboundPumpRunResult> {
  if (!handler) {
    return { status: "skipped", reason: "no-handler" };
  }
  return handler({ reason: opts?.reason });
}

export function hasPendingOutboundPumpWake(): boolean {
  return running || Boolean(timer) || Boolean(queuedReason) || needsAnotherRun;
}

export async function waitForOutboundPumpIdle(opts?: {
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const pollMs = opts?.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [pendingWake, pendingJobs] = await Promise.all([
      Promise.resolve(hasPendingOutboundPumpWake()),
      outboundDeliveryQueueService.hasPendingJobs(),
    ]);

    if (!pendingWake && !pendingJobs) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return false;
}

export function resetOutboundPumpForTests(): void {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  running = false;
  queuedReason = undefined;
  needsAnotherRun = false;
  handler = runOutboundPumpInternal;
}
