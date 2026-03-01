/**
 * Subagent Registry
 *
 * Tracks async subagent runs with:
 * - DB-authoritative durability + in-memory coordination cache
 * - Announce flow trigger on completion (direct-first delivery + fallback)
 * - Cascade stop (killing parent stops children)
 * - Concurrency limits
 */
import { queueAnnounce } from "../subagent-announce.js";
import { createLogger } from "../../lib/logger.js";
import {
  subagentRunsService,
  type SubagentRunRecord,
} from "../../services/subagent-runs.service.js";
import type { SubagentFlowMode } from "../subagent-flow-mode.js";

const log = createLogger("subagent");

export type SubagentStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "killed";

export type AnnounceMode = "full" | "brief" | "silent";

export interface SubagentRun {
  id: string;
  userId: string;
  task: string;
  type: string;
  parentSessionId: string;
  sessionId: string;
  childSessionKey?: string;
  depth: number;
  mode?: "run" | "session";
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  toolsUsed: string[];
  /** Abort controller for cancellation (not persisted) */
  abortController?: AbortController;
  /** Spawn promise for in-flight coordination (not persisted) */
  spawnPromise?: Promise<unknown>;
  /** Whether child session should be cleaned up after completion */
  cleanup?: boolean;
  /** Callback when subagent finishes (not persisted) */
  onComplete?: (run: SubagentRun) => void;
  /** Channel delivery context for announce routing */
  deliveryContext?: {
    externalId: string;
  };
  /** Whether announce has been triggered for this run */
  announceTriggered?: boolean;
  /** Controls how results are announced: full (summary), brief (one-liner), silent (no delivery) */
  announceMode?: AnnounceMode;
  /** Self-generated summary from the subagent's announce step */
  announceSummary?: string;
  /** Scratch artifact path with full results and metadata. */
  fullResultPath?: string;
  /** Whether announce cleanup has completed */
  cleanupHandled?: boolean;
  /** Completion timestamp for cleanup lifecycle */
  cleanupCompletedAt?: number;
  /** Number of announce retries attempted */
  announceRetryCount?: number;
  /** Timestamp of last announce retry attempt */
  lastAnnounceRetryAt?: number;
  /** Final reason for ending the run lifecycle */
  endedReason?: string;
  /** Reason announce was suppressed/abandoned */
  suppressAnnounceReason?: string;
  /** Dispatch phase trail for announce attempts (direct-first + fallback). */
  announceDeliveryPhases?: Array<{
    phase: string;
    outcome: string;
    attemptedAt: number;
    reason?: string;
    routeFailureReason?: string;
    routeCandidateChain?: string[];
  }>;
  /**
   * Whether the requester session is itself a subagent session.
   * nested subagents should not directly deliver to external channels
   * and must route through parent/session announce flow.
   */
  requesterIsSubagent?: boolean;
  /** Orchestration flow mode that spawned this run. */
  flowMode?: SubagentFlowMode;
  /** Additional durable metadata for orchestration and observability. */
  metadata?: Record<string, unknown>;
}

type RunReferences = {
  sessionKey?: string;
  fullResultPath?: string;
};

import { getConfig } from "../../lib/config-loader.js";
const MAX_GLOBAL_CONCURRENT = getConfig().subagents.maxConcurrent;
const MAX_ARCHIVED_RUNS = getConfig().subagents.maxArchived;
const ARCHIVE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ANNOUNCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const ANNOUNCE_MAX_RETRIES = 3;
const ANNOUNCE_BASE_DELAY_MS = 1000;
const ANNOUNCE_MAX_DELAY_MS = 8000;

const runs = new Map<string, SubagentRun>();
const announceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sweeperInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let restorePromise: Promise<void> | null = null;

function normalizeRunDefaults(run: SubagentRun): SubagentRun {
  if (!run.userId) run.userId = "unknown";
  if (!run.mode) run.mode = "run";
  if (!run.announceMode) run.announceMode = "full";
  if (typeof run.announceTriggered !== "boolean") run.announceTriggered = false;
  if (typeof run.cleanupHandled !== "boolean") run.cleanupHandled = false;
  if (typeof run.announceRetryCount !== "number") run.announceRetryCount = 0;
  return run;
}

function toRunRecord(run: SubagentRun): SubagentRunRecord {
  return {
    runId: run.id,
    parentSessionId: run.parentSessionId,
    ...(run.sessionId ? { childSessionId: run.sessionId } : {}),
    ...(run.childSessionKey ? { childSessionKey: run.childSessionKey } : {}),
    userId: run.userId,
    mode: run.mode ?? "run",
    task: run.task,
    type: run.type,
    depth: run.depth,
    status: run.status,
    announceMode: run.announceMode,
    announceSummary: run.announceSummary,
    result: run.result,
    error: run.error,
    toolsUsed: run.toolsUsed,
    deliveryContext: run.deliveryContext,
    requesterIsSubagent: run.requesterIsSubagent,
    announceTriggered: run.announceTriggered,
    cleanupHandled: run.cleanupHandled,
    cleanupCompletedAt: run.cleanupCompletedAt,
    announceRetryCount: run.announceRetryCount,
    lastAnnounceRetryAt: run.lastAnnounceRetryAt,
    endedReason: run.endedReason,
    suppressAnnounceReason: run.suppressAnnounceReason,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    metadata: {
      ...(run.metadata ?? {}),
      ...(run.flowMode ? { flowMode: run.flowMode } : {}),
      ...(run.fullResultPath ? { fullResultPath: run.fullResultPath } : {}),
      ...(run.announceDeliveryPhases
        ? { announceDeliveryPhases: run.announceDeliveryPhases }
        : {}),
    },
  };
}

function fromRunRecord(record: SubagentRunRecord): SubagentRun {
  return {
    id: record.runId,
    userId: record.userId,
    task: record.task,
    type: record.type,
    parentSessionId: record.parentSessionId,
    sessionId: record.childSessionId ?? "",
    ...(record.childSessionKey ? { childSessionKey: record.childSessionKey } : {}),
    depth: record.depth,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    result: record.result,
    error: record.error,
    toolsUsed: record.toolsUsed,
    deliveryContext:
      record.deliveryContext &&
      typeof record.deliveryContext["externalId"] === "string"
        ? { externalId: record.deliveryContext["externalId"] as string }
        : undefined,
    announceTriggered: record.announceTriggered,
    announceMode: record.announceMode,
    announceSummary: record.announceSummary,
    cleanupHandled: record.cleanupHandled,
    cleanupCompletedAt: record.cleanupCompletedAt,
    announceRetryCount: record.announceRetryCount,
    lastAnnounceRetryAt: record.lastAnnounceRetryAt,
    endedReason: record.endedReason,
    suppressAnnounceReason: record.suppressAnnounceReason,
    requesterIsSubagent: record.requesterIsSubagent,
    ...(typeof record.metadata?.fullResultPath === "string"
      ? { fullResultPath: record.metadata.fullResultPath }
      : {}),
    ...(Array.isArray(record.metadata?.announceDeliveryPhases)
      ? {
          announceDeliveryPhases:
            record.metadata.announceDeliveryPhases as SubagentRun["announceDeliveryPhases"],
        }
      : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    ...(typeof record.metadata?.flowMode === "string"
      ? { flowMode: record.metadata.flowMode as SubagentFlowMode }
      : {}),
  };
}

function persistRun(run: SubagentRun): void {
  const normalized = normalizeRunDefaults(run);
  void subagentRunsService.upsertRun(toRunRecord(normalized));
}

async function restoreFromDatabase(): Promise<void> {
  try {
    const recovered = await subagentRunsService.markRunningRunsFailedOnStartup(
      "process-restart",
    );
    if (recovered.length > 0) {
      log.info(
        { recovered: recovered.length },
        "Recovered running subagent runs from DB after restart",
      );
    }

    const restored = await subagentRunsService.listRecentRuns(
      Math.max(200, MAX_ARCHIVED_RUNS * 4),
    );

    for (const row of restored) {
      if (runs.has(row.runId)) continue;
      const run = normalizeRunDefaults(fromRunRecord(row));
      runs.set(run.id, run);

      if (!run.cleanupHandled && run.status !== "running") {
        scheduleAnnounceRetry(run.id, "resume", 0);
      }
    }

    if (runs.size > 0) {
      startSweeper();
    }
  } catch (error) {
    log.error({ err: error }, "Failed to restore subagent runs from DB");
  }
}

/**
 * Initialize registry: restore from DB on first use.
 */
export function initRegistry(): void {
  if (initialized) return;
  initialized = true;
  restorePromise = restoreFromDatabase();
}

export async function waitForRegistryReady(): Promise<void> {
  await restorePromise;
}

function startSweeper(): void {
  if (sweeperInterval) return;
  sweeperInterval = setInterval(() => {
    const cutoff = Date.now() - ARCHIVE_TTL_MS;
    for (const [id, run] of runs) {
      if (run.status !== "running" && run.endedAt && run.endedAt < cutoff) {
        clearAnnounceRetry(id);
        runs.delete(id);
      }
    }
    void subagentRunsService.pruneOldArchivedRuns(ARCHIVE_TTL_MS);
    if (runs.size === 0 && sweeperInterval) {
      clearInterval(sweeperInterval);
      sweeperInterval = null;
    }
  }, SWEEPER_INTERVAL_MS);
  sweeperInterval.unref();
}

function clearAnnounceRetry(runId: string): void {
  const timer = announceRetryTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  announceRetryTimers.delete(runId);
}

function scheduleAnnounceRetry(
  runId: string,
  trigger: string,
  delayMs: number,
): void {
  clearAnnounceRetry(runId);

  const timer = setTimeout(
    () => {
      announceRetryTimers.delete(runId);
      void handleAnnounceCleanup(runId, trigger);
    },
    Math.max(0, delayMs),
  );
  timer.unref?.();
  announceRetryTimers.set(runId, timer);
}

function nextAnnounceRetryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  return Math.min(
    ANNOUNCE_BASE_DELAY_MS * 2 ** exponent,
    ANNOUNCE_MAX_DELAY_MS,
  );
}

function hasRunningDescendants(run: SubagentRun): boolean {
  if (!run.sessionId) return false;
  for (const candidate of runs.values()) {
    if (
      candidate.parentSessionId === run.sessionId &&
      candidate.status === "running"
    ) {
      return true;
    }
  }
  return false;
}

function markCleanupHandled(run: SubagentRun): void {
  clearAnnounceRetry(run.id);
  run.cleanupHandled = true;
  run.cleanupCompletedAt = Date.now();
  persistRun(run);
}

function markAnnounceSuppressed(run: SubagentRun, reason: string): void {
  if (!run.suppressAnnounceReason) {
    run.suppressAnnounceReason = reason;
  }
  markCleanupHandled(run);
}

function isRunAnnounceExpired(run: SubagentRun): boolean {
  if (!run.endedAt) return false;
  return Date.now() - run.endedAt > ANNOUNCE_EXPIRY_MS;
}

function shouldGiveUpAnnounce(run: SubagentRun): boolean {
  return (run.announceRetryCount ?? 0) >= ANNOUNCE_MAX_RETRIES;
}

async function handleAnnounceCleanup(
  runId: string,
  trigger: string,
): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;
  normalizeRunDefaults(run);

  if (run.status === "running") return;
  if (run.cleanupHandled) return;

  if (run.suppressAnnounceReason) {
    markCleanupHandled(run);
    return;
  }

  if (isRunAnnounceExpired(run)) {
    log.warn(
      {
        metric: "subagent_announce_giveup",
        runId: run.id,
        retryCount: run.announceRetryCount,
      },
      "Subagent announce expired before completion",
    );
    markAnnounceSuppressed(run, "announce-expired");
    return;
  }

  if (hasRunningDescendants(run)) {
    scheduleAnnounceRetry(run.id, "descendants-active", ANNOUNCE_BASE_DELAY_MS);
    return;
  }

  run.announceTriggered = true;
  persistRun(run);

  log.info(
    {
      metric: "subagent_announce_attempt",
      runId: run.id,
      status: run.status,
      trigger,
      retryCount: run.announceRetryCount ?? 0,
    },
    "Attempting subagent announce cleanup",
  );

  const outcome = await queueAnnounce(run);
  if (outcome !== "failed") {
    if (outcome === "suppressed" && !run.suppressAnnounceReason) {
      run.suppressAnnounceReason = "announce-suppressed";
    }
    markCleanupHandled(run);
    return;
  }

  run.announceRetryCount = (run.announceRetryCount ?? 0) + 1;
  run.lastAnnounceRetryAt = Date.now();

  if (shouldGiveUpAnnounce(run)) {
    log.warn(
      {
        metric: "subagent_announce_giveup",
        runId: run.id,
        retryCount: run.announceRetryCount,
      },
      "Subagent announce retry limit reached",
    );
    markAnnounceSuppressed(run, "announce-retries-exhausted");
    return;
  }

  const delayMs = nextAnnounceRetryDelayMs(run.announceRetryCount);
  persistRun(run);
  scheduleAnnounceRetry(run.id, "retry", delayMs);
  log.info(
    {
      metric: "subagent_announce_retry",
      runId: run.id,
      retryCount: run.announceRetryCount,
      delayMs,
    },
    "Scheduled subagent announce retry",
  );
}

function boundArchivedRuns(): void {
  const archived = Array.from(runs.values()).filter(
    (r) => r.status !== "running",
  );
  if (archived.length <= MAX_ARCHIVED_RUNS) return;
  archived.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  const toEvict = archived.length - MAX_ARCHIVED_RUNS;
  for (let i = 0; i < toEvict; i++) {
    clearAnnounceRetry(archived[i].id);
    runs.delete(archived[i].id);
  }
}

// --- Announce Flow ---

function triggerAnnounce(run: SubagentRun): void {
  if (run.cleanupHandled) return;
  if (run.status === "running") return;
  if (run.status === "killed") {
    markAnnounceSuppressed(run, "killed");
    return;
  }

  run.announceTriggered = true;
  persistRun(run);
  void handleAnnounceCleanup(run.id, "trigger");
}

function finalizeRunTransition(run: SubagentRun, endedReason: string): void {
  run.endedReason = endedReason;
  run.announceTriggered = false;
  run.cleanupHandled = false;
  run.cleanupCompletedAt = undefined;
  run.announceRetryCount = 0;
  run.lastAnnounceRetryAt = undefined;
  run.suppressAnnounceReason = undefined;
  run.announceDeliveryPhases = undefined;
}

function notifyCompletion(run: SubagentRun): void {
  if (!run.onComplete) return;
  try {
    run.onComplete(run);
  } catch {
    // ignore callback errors
  }
}

// --- Public API ---

export function canSpawn(): boolean {
  initRegistry();
  const running = Array.from(runs.values()).filter(
    (r) => r.status === "running",
  );
  return running.length < MAX_GLOBAL_CONCURRENT;
}

export function getRunningCount(): number {
  return Array.from(runs.values()).filter((r) => r.status === "running").length;
}

export function registerRun(run: SubagentRun): void {
  initRegistry();
  normalizeRunDefaults(run);
  runs.set(run.id, run);
  startSweeper();
  persistRun(run);
}

export function getRun(id: string): SubagentRun | undefined {
  return runs.get(id);
}

export async function getRunDurable(id: string): Promise<SubagentRun | undefined> {
  const inMemory = runs.get(id);
  if (inMemory) return inMemory;

  const persisted = await subagentRunsService.getRun(id);
  if (!persisted) return undefined;
  return normalizeRunDefaults(fromRunRecord(persisted));
}

function applyRunReferences(run: SubagentRun, references?: RunReferences): void {
  if (!references) return;
  const sessionKey = references.sessionKey?.trim();
  if (sessionKey) {
    run.childSessionKey = sessionKey;
  }
  const fullResultPath = references.fullResultPath?.trim();
  if (fullResultPath) {
    run.fullResultPath = fullResultPath;
  }
}

export function completeRun(
  id: string,
  result: string,
  toolsUsed: string[],
  announceSummary?: string,
  references?: RunReferences,
): void {
  const run = runs.get(id);
  if (!run || run.status !== "running") return;

  run.status = "completed";
  run.endedAt = Date.now();
  run.result = result;
  run.toolsUsed = toolsUsed;
  run.announceSummary = announceSummary;
  applyRunReferences(run, references);
  finalizeRunTransition(run, "completed");
  boundArchivedRuns();
  persistRun(run);

  notifyCompletion(run);
  triggerAnnounce(run);
}

export function failRun(id: string, error: string, references?: RunReferences): void {
  const run = runs.get(id);
  if (!run || run.status !== "running") return;

  run.status = "failed";
  run.endedAt = Date.now();
  run.error = error;
  applyRunReferences(run, references);
  finalizeRunTransition(run, "failed");
  boundArchivedRuns();
  persistRun(run);

  notifyCompletion(run);
  triggerAnnounce(run);
}

export function timeoutRun(id: string, references?: RunReferences): void {
  const run = runs.get(id);
  if (!run || run.status !== "running") return;

  run.status = "timeout";
  run.endedAt = Date.now();
  run.error = `Subagent timed out after ${Math.round((Date.now() - run.startedAt) / 1000)}s`;
  applyRunReferences(run, references);
  finalizeRunTransition(run, "timeout");
  boundArchivedRuns();
  persistRun(run);

  notifyCompletion(run);
  triggerAnnounce(run);
}

export function killRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== "running") return false;

  // Cascade: kill all children first
  const children = getChildRuns(run.sessionId);
  for (const child of children) {
    if (child.status === "running") {
      killRun(child.id);
    }
  }

  clearAnnounceRetry(run.id);
  run.abortController?.abort();
  run.status = "killed";
  run.endedAt = Date.now();
  run.error = "Killed by parent or user";
  run.endedReason = "killed";
  run.suppressAnnounceReason = "killed";
  run.cleanupHandled = true;
  run.cleanupCompletedAt = Date.now();
  run.announceTriggered = true;
  persistRun(run);

  notifyCompletion(run);
  return true;
}

export function killAllForParent(parentSessionId: string): number {
  let killed = 0;
  for (const run of runs.values()) {
    if (run.parentSessionId === parentSessionId && run.status === "running") {
      killRun(run.id);
      killed++;
    }
  }
  return killed;
}

export function getChildRuns(parentSessionId: string): SubagentRun[] {
  return Array.from(runs.values()).filter(
    (r) => r.parentSessionId === parentSessionId,
  );
}

export function listRuns(parentSessionId: string): {
  running: SubagentRun[];
  completed: SubagentRun[];
} {
  const forParent = Array.from(runs.values()).filter(
    (r) => r.parentSessionId === parentSessionId,
  );

  return {
    running: forParent
      .filter((r) => r.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt),
    completed: forParent
      .filter((r) => r.status !== "running")
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)),
  };
}

export async function listRunsDurable(parentSessionId: string): Promise<{
  running: SubagentRun[];
  completed: SubagentRun[];
}> {
  const persisted = await subagentRunsService.listRunsForParent(parentSessionId, {
    limit: Math.max(200, MAX_ARCHIVED_RUNS * 4),
    includeRunning: true,
  });

  const merged = new Map<string, SubagentRun>();
  for (const run of persisted) {
    merged.set(run.runId, normalizeRunDefaults(fromRunRecord(run)));
  }
  for (const run of runs.values()) {
    if (run.parentSessionId !== parentSessionId) continue;
    merged.set(run.id, normalizeRunDefaults(run));
  }

  const values = Array.from(merged.values()).filter(
    (run) => run.parentSessionId === parentSessionId,
  );
  return {
    running: values
      .filter((run) => run.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt),
    completed: values
      .filter((run) => run.status !== "running")
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)),
  };
}

export function formatRunStatus(run: SubagentRun): string {
  const duration = run.endedAt
    ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - run.startedAt) / 1000)}s (running)`;

  const lines = [
    `**ID:** ${run.id}`,
    `**Task:** ${run.task.slice(0, 100)}${run.task.length > 100 ? "..." : ""}`,
    `**Type:** ${run.type} | **Depth:** ${run.depth}`,
    `**Status:** ${run.status} | **Duration:** ${duration}`,
  ];

  if (run.toolsUsed.length > 0) {
    lines.push(`**Tools used:** ${run.toolsUsed.join(", ")}`);
  }

  if (run.error) {
    lines.push(`**Error:** ${run.error}`);
  }
  if (run.childSessionKey) {
    lines.push(`**Session key:** ${run.childSessionKey}`);
  }
  if (run.fullResultPath) {
    lines.push(`**Full result path:** ${run.fullResultPath}`);
  }
  if (run.announceDeliveryPhases && run.announceDeliveryPhases.length > 0) {
    const phaseText = run.announceDeliveryPhases
      .map((entry) =>
        `${entry.phase}=${entry.outcome}${entry.reason ? `(${entry.reason})` : ""}`,
      )
      .join(", ");
    lines.push(`**Announce phases:** ${phaseText}`);
  }

  return lines.join("\n");
}

/**
 * Test-only reset for subagent registry singleton state.
 */
export function resetSubagentRegistryForTests(): void {
  runs.clear();
  for (const timer of announceRetryTimers.values()) {
    clearTimeout(timer);
  }
  announceRetryTimers.clear();

  // Keep registry in initialized mode to avoid auto-restoring persisted runs
  // from DB when tests call registerRun().
  initialized = true;
  restorePromise = null;

  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
