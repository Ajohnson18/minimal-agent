export type CompletionRelay = "auto" | "always" | "silent";
export type CompletionRelevance = "user" | "internal";

export interface CompletionPolicy {
  relay: CompletionRelay;
  relevance: CompletionRelevance;
  reason?: string;
}

export type SystemEventKind =
  | 'exec.completion'
  | 'subagent.completion'
  | 'cursor.completion'
  | 'cron.fired';

export interface BaseSystemEventPayload {
  text: string;
  completionPolicy?: CompletionPolicy;
}

export interface ExecCompletionPayload extends BaseSystemEventPayload {
  command?: string;
  processSessionId?: string;
  exitCode?: number | null;
  status?: string;
  outputSeq?: {
    last?: number;
    stdout?: number;
    stderr?: number;
  };
}

export interface SubagentCompletionDescriptor {
  runId: string;
  outcome: "completed" | "failed" | "timeout";
  summary: string;
  childSessionId?: string;
  childSessionKey?: string;
  fullResultPath?: string;
  durationMs?: number;
  toolsUsed?: string[];
}

export interface SubagentCompletionPayload extends BaseSystemEventPayload {
  subagentRunId?: string;
  announceMode?: 'silent' | 'brief' | 'full';
  outcome?: 'completed' | 'failed' | 'timeout';
  summary?: string;
  childSessionId?: string;
  childSessionKey?: string;
  fullResultPath?: string;
  durationMs?: number;
  toolsUsed?: string[];
}

export interface CursorCompletionPayload extends BaseSystemEventPayload {
  workflow?: string;
}

export interface CronFiredPayload extends BaseSystemEventPayload {
  jobId?: string;
  jobName?: string;
}

export interface SystemEventPayloadMap {
  'exec.completion': ExecCompletionPayload;
  'subagent.completion': SubagentCompletionPayload;
  'cursor.completion': CursorCompletionPayload;
  'cron.fired': CronFiredPayload;
}

export type SystemEventPayload<K extends SystemEventKind> = SystemEventPayloadMap[K];

export interface TypedSystemEvent<K extends SystemEventKind = SystemEventKind> {
  id: string;
  sessionId: string;
  sessionKey?: string;
  kind: K;
  payload: SystemEventPayload<K>;
  eventKey?: string;
  createdAt: Date;
  processed: boolean;
  processedAt: Date | null;
  claimToken?: string;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export function normalizeSystemEventKind(raw: string | undefined): SystemEventKind {
  const normalized = (raw ?? '').trim().toLowerCase();

  if (
    normalized === 'exec.completion' ||
    normalized === 'subagent.completion' ||
    normalized === 'cursor.completion' ||
    normalized === 'cron.fired'
  ) {
    return normalized;
  }

  throw new Error(`Unsupported system event kind: ${raw ?? ''}`);
}

export function resolveCompletionPolicy(
  payload: BaseSystemEventPayload | undefined,
): CompletionPolicy {
  const policy = payload?.completionPolicy;
  return {
    relay: policy?.relay ?? "auto",
    relevance: policy?.relevance ?? "user",
    ...(typeof policy?.reason === "string" && policy.reason.trim().length > 0
      ? { reason: policy.reason.trim() }
      : {}),
  };
}

export function isRelaySuppressed(payload: BaseSystemEventPayload | undefined): boolean {
  const policy = resolveCompletionPolicy(payload);
  if (policy.relay === "silent") {
    return true;
  }
  return policy.relay === "auto" && policy.relevance === "internal";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCompletionPolicy(raw: unknown): CompletionPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const relay =
    raw["relay"] === "auto" || raw["relay"] === "always" || raw["relay"] === "silent"
      ? raw["relay"]
      : undefined;
  const relevance =
    raw["relevance"] === "user" || raw["relevance"] === "internal"
      ? raw["relevance"]
      : undefined;
  if (!relay || !relevance) return undefined;
  const reason = normalizeText(raw["reason"]);
  return {
    relay,
    relevance,
    ...(reason ? { reason } : {}),
  };
}

export function validateSystemEventPayload<K extends SystemEventKind>(
  kind: K,
  payload: unknown,
): SystemEventPayloadMap[K] {
  const base = isObject(payload) ? { ...payload } : {};
  const text = normalizeText(base["text"]);
  const completionPolicy = normalizeCompletionPolicy(base["completionPolicy"]);

  const normalized: Record<string, unknown> = {
    text,
    ...(completionPolicy ? { completionPolicy } : {}),
  };

  switch (kind) {
    case "exec.completion": {
      const command = normalizeText(base["command"]);
      const processSessionId = normalizeText(base["processSessionId"]);
      const status = normalizeText(base["status"]);
      const exitCode = typeof base["exitCode"] === "number" ? base["exitCode"] : null;
      const outputSeqRaw = isObject(base["outputSeq"]) ? base["outputSeq"] : null;
      const outputSeq = outputSeqRaw
        ? {
            ...(typeof outputSeqRaw["last"] === "number" ? { last: outputSeqRaw["last"] } : {}),
            ...(typeof outputSeqRaw["stdout"] === "number"
              ? { stdout: outputSeqRaw["stdout"] }
              : {}),
            ...(typeof outputSeqRaw["stderr"] === "number"
              ? { stderr: outputSeqRaw["stderr"] }
              : {}),
          }
        : undefined;
      if (command) normalized["command"] = command;
      if (processSessionId) normalized["processSessionId"] = processSessionId;
      if (status) normalized["status"] = status;
      if (exitCode !== null) normalized["exitCode"] = exitCode;
      if (outputSeq && Object.keys(outputSeq).length > 0) normalized["outputSeq"] = outputSeq;
      break;
    }
    case "subagent.completion": {
      const subagentRunId = normalizeText(base["subagentRunId"]);
      const announceMode =
        base["announceMode"] === "silent" ||
        base["announceMode"] === "brief" ||
        base["announceMode"] === "full"
          ? base["announceMode"]
          : undefined;
      const outcome =
        base["outcome"] === "completed" ||
        base["outcome"] === "failed" ||
        base["outcome"] === "timeout"
          ? base["outcome"]
          : undefined;
      const summary = normalizeText(base["summary"]);
      const childSessionId = normalizeText(base["childSessionId"]);
      const childSessionKey = normalizeText(base["childSessionKey"]);
      const fullResultPath = normalizeText(base["fullResultPath"]);
      const durationMs = typeof base["durationMs"] === "number" ? base["durationMs"] : undefined;
      const toolsUsedRaw = Array.isArray(base["toolsUsed"]) ? base["toolsUsed"] : undefined;
      const toolsUsed = toolsUsedRaw?.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      if (subagentRunId) normalized["subagentRunId"] = subagentRunId;
      if (announceMode) normalized["announceMode"] = announceMode;
      if (outcome) normalized["outcome"] = outcome;
      if (summary) normalized["summary"] = summary;
      if (childSessionId) normalized["childSessionId"] = childSessionId;
      if (childSessionKey) normalized["childSessionKey"] = childSessionKey;
      if (fullResultPath) normalized["fullResultPath"] = fullResultPath;
      if (Number.isFinite(durationMs)) normalized["durationMs"] = Math.max(0, durationMs as number);
      if (toolsUsed && toolsUsed.length > 0) normalized["toolsUsed"] = toolsUsed;
      break;
    }
    case "cursor.completion": {
      const workflow = normalizeText(base["workflow"]);
      if (workflow) normalized["workflow"] = workflow;
      break;
    }
    case "cron.fired": {
      const jobId = normalizeText(base["jobId"]);
      const jobName = normalizeText(base["jobName"]);
      if (jobId) normalized["jobId"] = jobId;
      if (jobName) normalized["jobName"] = jobName;
      break;
    }
  }

  return normalized as unknown as SystemEventPayloadMap[K];
}
