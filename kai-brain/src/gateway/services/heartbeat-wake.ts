import { createLogger } from "../../lib/logger.js";
import {
  classifyHeartbeatReason,
  describeHeartbeatReason,
  shouldRetryHeartbeatSkip,
  type HeartbeatWakeReason,
  type HeartbeatRetryCause,
  type HeartbeatWakeReasonInput,
} from "../../core/heartbeat-reason.js";

const log = createLogger("agent");

const MAX_CONSECUTIVE_NO_DELIVERY_FAILURES = 5;

let stopSessionHeartbeatFn: ((sessionId: string) => void) | null = null;

export function setStopSessionHeartbeatCallback(fn: (sessionId: string) => void): void {
  stopSessionHeartbeatFn = fn;
}

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string };

export type HeartbeatWakeHandler = (opts: {
  reason?: HeartbeatWakeReason;
  sessionId?: string;
}) => Promise<HeartbeatRunResult>;

type WakeTimerKind = "normal" | "retry";

type PendingWakeReason = {
  reason: HeartbeatWakeReason;
  priority: number;
  requestedAt: number;
  sessionId: string;
};

const pendingWakes = new Map<string, PendingWakeReason>();
const retryAttemptsBySession = new Map<string, number>();

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let timerKind: WakeTimerKind | null = null;

function normalizeSessionId(sessionId?: string): string | undefined {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
  return trimmed || undefined;
}

function queuePendingWakeReason(opts?: {
  reason?: HeartbeatWakeReasonInput;
  requestedAt?: number;
  sessionId?: string;
}) {
  const requestedAt = opts?.requestedAt ?? Date.now();
  const classified = classifyHeartbeatReason(opts?.reason);
  const sessionId = normalizeSessionId(opts?.sessionId);
  if (!sessionId) {
    return;
  }

  const next: PendingWakeReason = {
    reason: classified,
    priority: classified.priority,
    requestedAt,
    sessionId,
  };

  const previous = pendingWakes.get(sessionId);
  if (!previous) {
    pendingWakes.set(sessionId, next);
    return;
  }

  if (next.priority > previous.priority) {
    pendingWakes.set(sessionId, next);
    return;
  }

  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    pendingWakes.set(sessionId, next);
  }
}

function shouldRetrySkippedReason(reason: string): boolean {
  return shouldRetryHeartbeatSkip(reason);
}

function toRetryCause(reason: string): HeartbeatRetryCause {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized === "queue-busy" ||
    normalized === "no-delivery-target" ||
    normalized === "delivery-failed" ||
    normalized === "heartbeat-error" ||
    normalized === "invalid-control-envelope" ||
    normalized === "session-not-deliverable" ||
    normalized === "service-not-running"
  ) {
    return normalized;
  }
  return "unknown";
}

function clearRetryState(sessionId?: string): void {
  if (!sessionId) return;
  retryAttemptsBySession.delete(sessionId);
}

function registerRetryAndGetDelayMs(sessionId: string): {
  attempt: number;
  delayMs: number;
} {
  const attempt = (retryAttemptsBySession.get(sessionId) ?? 0) + 1;
  retryAttemptsBySession.set(sessionId, attempt);
  const idx = Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1);
  const delayMs = RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  return { attempt, delayMs };
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs)
    ? Math.max(0, coalesceMs)
    : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;

  if (timer) {
    // Keep retry cooldown as a hard minimum.
    if (timerKind === "retry") {
      return;
    }

    // Existing timer fires sooner; keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }

    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
  }

  timerDueAt = dueAt;
  timerKind = kind;

  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;

    const active = handler;
    if (!active) {
      return;
    }

    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const pendingBatch = Array.from(pendingWakes.values());
    pendingWakes.clear();

    running = true;
    try {
      for (const pendingWake of pendingBatch) {
        const result = await active({
          reason: pendingWake.reason,
          sessionId: pendingWake.sessionId,
        });

        if (result.status === "ran") {
          clearRetryState(pendingWake.sessionId);
          continue;
        }

        if (
          result.status === "skipped" &&
          shouldRetrySkippedReason(result.reason)
        ) {
          const { attempt, delayMs } = registerRetryAndGetDelayMs(
            pendingWake.sessionId,
          );
          
          const retryCause = toRetryCause(result.reason);
          if (retryCause === "no-delivery-target" && attempt > MAX_CONSECUTIVE_NO_DELIVERY_FAILURES) {
            log.warn(
              {
                metric: "heartbeat_terminated",
                sessionId: pendingWake.sessionId,
                reason: "consecutive-no-delivery-target-failures",
                failureCount: attempt,
                threshold: MAX_CONSECUTIVE_NO_DELIVERY_FAILURES,
              },
              "Terminating heartbeat after consecutive no-delivery-target failures",
            );
            clearRetryState(pendingWake.sessionId);
            if (stopSessionHeartbeatFn) {
              stopSessionHeartbeatFn(pendingWake.sessionId);
            }
            continue;
          }
          
          queuePendingWakeReason({
            reason: {
              kind: "retry",
              retryCause,
              source: "queue",
            },
            sessionId: pendingWake.sessionId,
          });
          schedule(delayMs, "retry");
          log.info(
            {
              metric: "heartbeat_wake_retry",
              sessionId: pendingWake.sessionId,
              reason: describeHeartbeatReason(pendingWake.reason),
              skippedReason: result.reason,
              retryAttempt: attempt,
              retryDelayMs: delayMs,
            },
            "Heartbeat wake retry scheduled",
          );
          continue;
        }

        clearRetryState(pendingWake.sessionId);
      }
    } catch (error) {
      let minRetryDelay = Number.POSITIVE_INFINITY;
      for (const pendingWake of pendingBatch) {
        const { delayMs } = registerRetryAndGetDelayMs(pendingWake.sessionId);
        queuePendingWakeReason({
          reason: {
            kind: "retry",
            retryCause: "heartbeat-error",
            source: "runtime",
          },
          sessionId: pendingWake.sessionId,
        });
        if (delayMs < minRetryDelay) {
          minRetryDelay = delayMs;
        }
      }
      const retryDelay = Number.isFinite(minRetryDelay)
        ? minRetryDelay
        : DEFAULT_RETRY_MS;
      schedule(retryDelay, "retry");
      log.warn(
        { err: error, metric: "heartbeat_wake_retry", retryDelayMs: retryDelay },
        "Heartbeat wake handler failed; retry scheduled",
      );
    } finally {
      running = false;
      if (pendingWakes.size > 0 || scheduled) {
        schedule(delay, "normal");
      }
    }
  }, delay);

  timer.unref?.();
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer bound to the active generation.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  const hadPendingWakes = pendingWakes.size > 0;
  handler = next;

  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  timerKind = null;
  running = false;
  scheduled = false;
  retryAttemptsBySession.clear();
  if (!next) {
    pendingWakes.clear();
  }

  if (handler && hadPendingWakes) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }

  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestHeartbeatNow(opts?: {
  reason?: HeartbeatWakeReasonInput;
  coalesceMs?: number;
  sessionId?: string;
}) {
  const sessionId = normalizeSessionId(opts?.sessionId);
  if (!sessionId) {
    return;
  }

  const reason = classifyHeartbeatReason(opts?.reason);

  if (reason.kind !== "retry") {
    clearRetryState(sessionId);
  }

  queuePendingWakeReason({
    reason,
    sessionId,
  });

  log.debug(
    {
      metric: "heartbeat_wake_requested",
      sessionId,
      reason: describeHeartbeatReason(reason),
      coalesceMs: opts?.coalesceMs ?? DEFAULT_COALESCE_MS,
    },
    "Heartbeat wake requested",
  );

  if (pendingWakes.size > 1) {
    log.debug(
      {
        metric: "heartbeat_wake_coalesced",
        sessionId,
        pending: pendingWakes.size,
      },
      "Heartbeat wake coalesced",
    );
  }

  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

export function hasPendingHeartbeatWake(): boolean {
  return pendingWakes.size > 0 || Boolean(timer) || scheduled;
}

export function resetHeartbeatWakeStateForTests(): void {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  timerKind = null;
  pendingWakes.clear();
  retryAttemptsBySession.clear();
  scheduled = false;
  running = false;
  handlerGeneration += 1;
  handler = null;
  stopSessionHeartbeatFn = null;
}
