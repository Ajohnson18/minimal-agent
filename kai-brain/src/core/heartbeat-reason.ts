import type { SystemEventKind } from "./system-events.js";

export type HeartbeatWakeReasonKind =
  | "interval"
  | "retry"
  | "event"
  | "agent_message"
  | "steer"
  | "manual"
  | "error"
  | "unknown";

export type HeartbeatWakeSource =
  | "exec"
  | "subagent"
  | "cursor"
  | "cron"
  | "agent"
  | "queue"
  | "runtime"
  | "user"
  | "system";

export type HeartbeatRetryCause =
  | "queue-busy"
  | "no-delivery-target"
  | "delivery-failed"
  | "heartbeat-error"
  | "invalid-control-envelope"
  | "session-not-deliverable"
  | "service-not-running"
  | "unknown";

export interface HeartbeatWakeReasonInput {
  kind: HeartbeatWakeReasonKind;
  eventKind?: SystemEventKind;
  source?: HeartbeatWakeSource;
  retryCause?: HeartbeatRetryCause;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatWakeReason extends HeartbeatWakeReasonInput {
  priority: number;
  key: string;
}

const PRIORITY_BY_KIND: Record<HeartbeatWakeReasonKind, number> = {
  retry: 0,
  interval: 1,
  unknown: 2,
  manual: 2,
  error: 2,
  event: 3,
  agent_message: 3,
  steer: 3,
};

const RETRYABLE_SKIP_REASONS = new Set<string>([
  "queue-busy",
  "no-delivery-target",
  "delivery-failed",
  "heartbeat-error",
]);

function normalizeKind(kind: HeartbeatWakeReasonKind | undefined): HeartbeatWakeReasonKind {
  if (
    kind === "interval" ||
    kind === "retry" ||
    kind === "event" ||
    kind === "agent_message" ||
    kind === "steer" ||
    kind === "manual" ||
    kind === "error" ||
    kind === "unknown"
  ) {
    return kind;
  }
  return "manual";
}

function normalizeSource(source: HeartbeatWakeSource | undefined): HeartbeatWakeSource | undefined {
  if (
    source === "exec" ||
    source === "subagent" ||
    source === "cursor" ||
    source === "cron" ||
    source === "agent" ||
    source === "queue" ||
    source === "runtime" ||
    source === "user" ||
    source === "system"
  ) {
    return source;
  }
  return undefined;
}

function normalizeRetryCause(
  retryCause: HeartbeatRetryCause | undefined,
): HeartbeatRetryCause | undefined {
  if (
    retryCause === "queue-busy" ||
    retryCause === "no-delivery-target" ||
    retryCause === "delivery-failed" ||
    retryCause === "heartbeat-error" ||
    retryCause === "invalid-control-envelope" ||
    retryCause === "session-not-deliverable" ||
    retryCause === "service-not-running" ||
    retryCause === "unknown"
  ) {
    return retryCause;
  }
  return undefined;
}

function normalizeEventKind(eventKind: string | undefined): SystemEventKind | undefined {
  if (
    eventKind === "exec.completion" ||
    eventKind === "subagent.completion" ||
    eventKind === "cursor.completion" ||
    eventKind === "cron.fired"
  ) {
    return eventKind;
  }
  return undefined;
}

function buildReasonKey(reason: {
  kind: HeartbeatWakeReasonKind;
  eventKind?: SystemEventKind;
  retryCause?: HeartbeatRetryCause;
}): string {
  if (reason.kind === "event") {
    return `event:${reason.eventKind ?? "unknown"}`;
  }
  if (reason.kind === "retry") {
    return `retry:${reason.retryCause ?? "unknown"}`;
  }
  return reason.kind;
}

export function classifyHeartbeatReason(
  input: HeartbeatWakeReasonInput | undefined,
): HeartbeatWakeReason {
  const kind = normalizeKind(input?.kind);
  const eventKind = kind === "event" ? normalizeEventKind(input?.eventKind) : undefined;
  const retryCause = kind === "retry" ? normalizeRetryCause(input?.retryCause) : undefined;
  const source = normalizeSource(input?.source);
  const metadata = input?.metadata;

  return {
    kind,
    priority: PRIORITY_BY_KIND[kind],
    key: buildReasonKey({ kind, eventKind, retryCause }),
    ...(eventKind ? { eventKind } : {}),
    ...(source ? { source } : {}),
    ...(retryCause ? { retryCause } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function describeHeartbeatReason(reason: HeartbeatWakeReasonInput | undefined): string {
  const classified = classifyHeartbeatReason(reason);
  if (classified.kind === "event" && classified.eventKind) {
    return `event:${classified.eventKind}`;
  }
  if (classified.kind === "retry" && classified.retryCause) {
    return `retry:${classified.retryCause}`;
  }
  return classified.kind;
}

export function shouldRetryHeartbeatSkip(reason: string | undefined): boolean {
  const normalized = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (!normalized) return false;
  return RETRYABLE_SKIP_REASONS.has(normalized);
}
