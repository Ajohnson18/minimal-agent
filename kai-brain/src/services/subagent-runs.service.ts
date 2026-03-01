import { and, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { avaSubagentRuns } from "../db/schema/subagent-runs.js";
import { createLogger } from "../lib/logger.js";
import {
  sessionKeyResolverService,
  type SessionIdentity,
} from "./session-key-resolver.service.js";

const log = createLogger("subagent");
const DB_SUBAGENT_RUNS_ENABLED =
  process.env.AVA_TEST_DB_SUBAGENT_RUNS === "1" ||
  (process.env.AVA_TEST_MODE !== "1" && process.env.NODE_ENV !== "test");
let disabledReason: string | null = DB_SUBAGENT_RUNS_ENABLED ? null : "test-mode-disabled";

export type SubagentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "killed";

export type SubagentAnnounceMode = "full" | "brief" | "silent";

export interface SubagentRunRecord {
  runId: string;
  parentSessionId: string;
  parentSessionKey?: string;
  childSessionId?: string;
  childSessionKey?: string;
  userId: string;
  mode: "run" | "session";
  task: string;
  type: string;
  depth: number;
  status: SubagentRunStatus;
  announceMode?: SubagentAnnounceMode;
  announceSummary?: string;
  result?: string;
  error?: string;
  toolsUsed: string[];
  deliveryContext?: Record<string, unknown>;
  requesterIsSubagent?: boolean;
  announceTriggered?: boolean;
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  endedReason?: string;
  suppressAnnounceReason?: string;
  startedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
}

interface ListSubagentRunOptions {
  limit?: number;
  includeRunning?: boolean;
}

function asDate(value: number | undefined): Date | null {
  if (!Number.isFinite(value)) return null;
  return new Date(Math.floor(value as number));
}

function asTs(value: Date | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeToolsUsed(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function mapRow(row: typeof avaSubagentRuns.$inferSelect): SubagentRunRecord {
  return {
    runId: row.runId,
    parentSessionId: row.parentSessionId,
    ...(row.parentSessionKey ? { parentSessionKey: row.parentSessionKey } : {}),
    ...(row.childSessionId ? { childSessionId: row.childSessionId } : {}),
    ...(row.childSessionKey ? { childSessionKey: row.childSessionKey } : {}),
    userId: row.userId,
    mode: (row.mode === "session" ? "session" : "run") as "run" | "session",
    task: row.task,
    type: row.type,
    depth: row.depth,
    status: row.status as SubagentRunStatus,
    ...(row.announceMode ? { announceMode: row.announceMode as SubagentAnnounceMode } : {}),
    ...(row.announceSummary ? { announceSummary: row.announceSummary } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    toolsUsed: normalizeToolsUsed(row.toolsUsed),
    ...(row.deliveryContext && Object.keys(row.deliveryContext).length > 0
      ? { deliveryContext: row.deliveryContext as Record<string, unknown> }
      : {}),
    requesterIsSubagent: row.requesterIsSubagent,
    announceTriggered: row.announceTriggered,
    cleanupHandled: row.cleanupHandled,
    ...(asTs(row.cleanupCompletedAt) ? { cleanupCompletedAt: asTs(row.cleanupCompletedAt) } : {}),
    announceRetryCount: row.announceRetryCount,
    ...(asTs(row.lastAnnounceRetryAt)
      ? { lastAnnounceRetryAt: asTs(row.lastAnnounceRetryAt) }
      : {}),
    ...(row.endedReason ? { endedReason: row.endedReason } : {}),
    ...(row.suppressAnnounceReason
      ? { suppressAnnounceReason: row.suppressAnnounceReason }
      : {}),
    startedAt: asTs(row.startedAt) ?? Date.now(),
    ...(asTs(row.endedAt) ? { endedAt: asTs(row.endedAt) } : {}),
    ...(row.metadata && Object.keys(row.metadata).length > 0
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
  };
}

async function resolveSessionKey(sessionId: string): Promise<string | undefined> {
  const identity = await sessionKeyResolverService.resolveBySessionId(sessionId);
  return identity?.sessionKey;
}

function isRelationMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01";
}

function disablePersistence(reason: string): void {
  if (disabledReason) return;
  disabledReason = reason;
  log.warn({ reason }, "Disabling subagent run DB persistence");
}

function isPersistenceDisabled(): boolean {
  return disabledReason !== null;
}

async function resolveChildSessionKey(childSessionId: string | undefined): Promise<string | undefined> {
  if (!childSessionId) return undefined;
  const identity: SessionIdentity | null =
    await sessionKeyResolverService.resolveBySessionId(childSessionId);
  return identity?.sessionKey;
}

export class SubagentRunsService {
  async upsertRun(input: SubagentRunRecord): Promise<void> {
    if (isPersistenceDisabled()) return;

    const runId = input.runId.trim();
    if (!runId) return;

    const parentSessionKey =
      input.parentSessionKey ?? (await resolveSessionKey(input.parentSessionId));
    const childSessionKey =
      input.childSessionKey ?? (await resolveChildSessionKey(input.childSessionId));

    try {
      await db
        .insert(avaSubagentRuns)
        .values({
          runId,
          parentSessionId: input.parentSessionId,
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
          ...(childSessionKey ? { childSessionKey } : {}),
          userId: input.userId,
          mode: input.mode ?? "run",
          task: input.task,
          type: input.type,
          depth: input.depth,
          status: input.status,
          announceMode: input.announceMode ?? "full",
          ...(input.announceSummary ? { announceSummary: input.announceSummary } : {}),
          ...(input.result ? { result: input.result } : {}),
          ...(input.error ? { error: input.error } : {}),
          toolsUsed: input.toolsUsed,
          ...(input.deliveryContext ? { deliveryContext: input.deliveryContext } : {}),
          requesterIsSubagent: input.requesterIsSubagent ?? false,
          announceTriggered: input.announceTriggered ?? false,
          cleanupHandled: input.cleanupHandled ?? false,
          ...(input.cleanupCompletedAt
            ? { cleanupCompletedAt: asDate(input.cleanupCompletedAt) }
            : {}),
          announceRetryCount: input.announceRetryCount ?? 0,
          ...(input.lastAnnounceRetryAt
            ? { lastAnnounceRetryAt: asDate(input.lastAnnounceRetryAt) }
            : {}),
          ...(input.endedReason ? { endedReason: input.endedReason } : {}),
          ...(input.suppressAnnounceReason
            ? { suppressAnnounceReason: input.suppressAnnounceReason }
            : {}),
          startedAt: asDate(input.startedAt) ?? new Date(),
          ...(input.endedAt ? { endedAt: asDate(input.endedAt) } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [avaSubagentRuns.runId],
          set: {
            parentSessionId: input.parentSessionId,
            ...(parentSessionKey ? { parentSessionKey } : {}),
            ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
            ...(childSessionKey ? { childSessionKey } : {}),
            userId: input.userId,
            mode: input.mode ?? "run",
            task: input.task,
            type: input.type,
            depth: input.depth,
            status: input.status,
            announceMode: input.announceMode ?? "full",
            announceSummary: input.announceSummary ?? null,
            result: input.result ?? null,
            error: input.error ?? null,
            toolsUsed: input.toolsUsed,
            deliveryContext: input.deliveryContext ?? {},
            requesterIsSubagent: input.requesterIsSubagent ?? false,
            announceTriggered: input.announceTriggered ?? false,
            cleanupHandled: input.cleanupHandled ?? false,
            cleanupCompletedAt: asDate(input.cleanupCompletedAt),
            announceRetryCount: input.announceRetryCount ?? 0,
            lastAnnounceRetryAt: asDate(input.lastAnnounceRetryAt),
            endedReason: input.endedReason ?? null,
            suppressAnnounceReason: input.suppressAnnounceReason ?? null,
            startedAt: asDate(input.startedAt) ?? new Date(),
            endedAt: asDate(input.endedAt),
            metadata: input.metadata ?? {},
            updatedAt: new Date(),
          },
        });
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return;
      }
      log.error({ err: error, runId }, "Failed to upsert subagent run");
    }
  }

  async getRun(runId: string): Promise<SubagentRunRecord | null> {
    if (isPersistenceDisabled()) return null;

    const normalized = runId.trim();
    if (!normalized) return null;

    try {
      const [row] = await db
        .select()
        .from(avaSubagentRuns)
        .where(eq(avaSubagentRuns.runId, normalized))
        .limit(1);
      return row ? mapRow(row) : null;
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return null;
      }
      throw error;
    }
  }

  async listRunsForParent(
    parentSessionId: string,
    opts: ListSubagentRunOptions = {},
  ): Promise<SubagentRunRecord[]> {
    if (isPersistenceDisabled()) return [];

    const normalizedParent = parentSessionId.trim();
    if (!normalizedParent) return [];

    const limit = Number.isFinite(opts.limit)
      ? Math.max(1, Math.floor(opts.limit as number))
      : 100;

    const conditions = [
      eq(avaSubagentRuns.parentSessionId, normalizedParent),
    ];
    if (!opts.includeRunning) {
      conditions.push(ne(avaSubagentRuns.status, "running"));
    }

    try {
      const rows = await db
        .select()
        .from(avaSubagentRuns)
        .where(and(...conditions))
        .orderBy(desc(avaSubagentRuns.startedAt))
        .limit(limit);

      return rows.map(mapRow);
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return [];
      }
      throw error;
    }
  }

  async listRecentRuns(limit = 500): Promise<SubagentRunRecord[]> {
    if (isPersistenceDisabled()) return [];

    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 500;

    try {
      const rows = await db
        .select()
        .from(avaSubagentRuns)
        .orderBy(desc(avaSubagentRuns.updatedAt))
        .limit(safeLimit);
      return rows.map(mapRow);
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return [];
      }
      throw error;
    }
  }

  async markRunningRunsFailedOnStartup(
    reason = "process-restart",
  ): Promise<SubagentRunRecord[]> {
    if (isPersistenceDisabled()) return [];

    const now = new Date();
    try {
      const updated = await db
        .update(avaSubagentRuns)
        .set({
          status: "failed",
          error: "Process restarted during execution",
          endedReason: reason,
          endedAt: now,
          cleanupHandled: false,
          announceTriggered: false,
          updatedAt: now,
        })
        .where(eq(avaSubagentRuns.status, "running"))
        .returning();

      return updated.map(mapRow);
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return [];
      }
      throw error;
    }
  }

  async pruneOldArchivedRuns(maxAgeMs: number): Promise<number> {
    if (isPersistenceDisabled()) return 0;

    const cutoff = new Date(Date.now() - Math.max(0, Math.floor(maxAgeMs)));
    try {
      const deleted = await db
        .delete(avaSubagentRuns)
        .where(
          and(
            lt(avaSubagentRuns.updatedAt, cutoff),
            or(
              eq(avaSubagentRuns.status, "completed"),
              eq(avaSubagentRuns.status, "failed"),
              eq(avaSubagentRuns.status, "timeout"),
              eq(avaSubagentRuns.status, "killed"),
            ),
          ),
        )
        .returning({ id: avaSubagentRuns.id });

      return deleted.length;
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return 0;
      }
      throw error;
    }
  }

  async hydrateSessionKeys(runIds: string[]): Promise<void> {
    if (isPersistenceDisabled()) return;

    const normalized = runIds
      .map((runId) => runId.trim())
      .filter((runId) => runId.length > 0);
    if (normalized.length === 0) return;

    let rows: Array<{
      runId: string;
      parentSessionId: string;
      childSessionId: string | null;
      parentSessionKey: string | null;
      childSessionKey: string | null;
    }> = [];
    try {
      rows = await db
        .select({
          runId: avaSubagentRuns.runId,
          parentSessionId: avaSubagentRuns.parentSessionId,
          childSessionId: avaSubagentRuns.childSessionId,
          parentSessionKey: avaSubagentRuns.parentSessionKey,
          childSessionKey: avaSubagentRuns.childSessionKey,
        })
        .from(avaSubagentRuns)
        .where(inArray(avaSubagentRuns.runId, normalized));
    } catch (error) {
      if (isRelationMissingError(error)) {
        disablePersistence("missing-table");
        return;
      }
      throw error;
    }

    for (const row of rows) {
      const parentSessionKey =
        row.parentSessionKey ?? (await resolveSessionKey(row.parentSessionId));
      const childSessionKey =
        row.childSessionKey ??
        (await resolveChildSessionKey(row.childSessionId ?? undefined));

      if (!parentSessionKey && !childSessionKey) continue;

      await db
        .update(avaSubagentRuns)
        .set({
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(childSessionKey ? { childSessionKey } : {}),
          updatedAt: new Date(),
        })
        .where(eq(avaSubagentRuns.runId, row.runId));
    }
  }
}

export const subagentRunsService = new SubagentRunsService();
