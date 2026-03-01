import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  avaExecAllowlistEntries,
  avaExecApprovals,
  type ExecApprovalDecision,
  type ExecApprovalStatus,
} from "../db/schema/exec-approvals.js";
import { avaSessions } from "../db/schema/sessions.js";
import { avaUserIdentities, avaUsers, type UserRole } from "../db/schema/users.js";

export interface SessionRoutingContext {
  id: string;
  source: string;
  externalId: string | null;
  userId: string;
}

export interface ExecApprovalDbRecordInput {
  id: string;
  sessionId: string;
  userId?: string | null;
  agentId?: string | null;
  command: string;
  cwd: string;
  host: string;
  security: string;
  ask: string;
  expiresAtMs: number;
  metadata?: Record<string, unknown>;
}

export async function createExecApprovalRecord(input: ExecApprovalDbRecordInput): Promise<void> {
  await db.insert(avaExecApprovals).values({
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId ?? null,
    agentId: input.agentId?.trim() || "main",
    command: input.command,
    cwd: input.cwd,
    host: input.host,
    security: input.security,
    ask: input.ask,
    status: "pending",
    expiresAt: new Date(input.expiresAtMs),
    metadata: input.metadata ?? {},
  });
}

export async function updateExecApprovalRecord(params: {
  id: string;
  status: ExecApprovalStatus;
  decision?: ExecApprovalDecision | null;
  reason?: string | null;
  resolvedBy?: string | null;
  resolvedAtMs?: number;
}): Promise<void> {
  await db
    .update(avaExecApprovals)
    .set({
      status: params.status,
      decision: params.decision ?? null,
      reason: params.reason ?? null,
      resolvedBy: params.resolvedBy ?? null,
      resolvedAt:
        typeof params.resolvedAtMs === "number" ? new Date(params.resolvedAtMs) : null,
    })
    .where(eq(avaExecApprovals.id, params.id));
}

export async function getSessionRoutingContext(
  sessionId: string,
): Promise<SessionRoutingContext | null> {
  const [session] = await db
    .select({
      id: avaSessions.id,
      source: avaSessions.source,
      externalId: avaSessions.externalId,
      userId: avaSessions.userId,
    })
    .from(avaSessions)
    .where(eq(avaSessions.id, sessionId))
    .limit(1);

  if (!session) return null;
  return session;
}

export async function getSessionOwnerUserId(sessionId: string): Promise<string | null> {
  const [session] = await db
    .select({ userId: avaSessions.userId })
    .from(avaSessions)
    .where(eq(avaSessions.id, sessionId))
    .limit(1);
  return session?.userId ?? null;
}

export async function listExecAllowlistPatterns(
  userId: string,
  agentId = "main",
): Promise<string[]> {
  const rows = await db
    .select({ pattern: avaExecAllowlistEntries.pattern })
    .from(avaExecAllowlistEntries)
    .where(
      and(
        eq(avaExecAllowlistEntries.userId, userId),
        eq(avaExecAllowlistEntries.agentId, agentId),
      ),
    )
    .orderBy(desc(avaExecAllowlistEntries.createdAt));

  return rows.map((row) => row.pattern);
}

export async function upsertExecAllowlistPatterns(params: {
  userId: string;
  agentId?: string;
  patterns: string[];
  approvalId?: string;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const agentId = params.agentId?.trim() || "main";
  const now = new Date();
  const uniquePatterns = Array.from(
    new Set(
      params.patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0),
    ),
  );

  for (const pattern of uniquePatterns) {
    await db
      .insert(avaExecAllowlistEntries)
      .values({
        userId: params.userId,
        agentId,
        pattern,
        createdByApprovalId: params.approvalId ?? null,
        lastUsedAt: now,
        lastUsedCommand: params.lastUsedCommand ?? null,
        lastResolvedPath: params.lastResolvedPath ?? null,
        metadata: params.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [
          avaExecAllowlistEntries.userId,
          avaExecAllowlistEntries.agentId,
          avaExecAllowlistEntries.pattern,
        ],
        set: {
          lastUsedAt: now,
          lastUsedCommand: params.lastUsedCommand ?? null,
          lastResolvedPath: params.lastResolvedPath ?? null,
          metadata: params.metadata ?? {},
        },
      });
  }
}

export async function markExecAllowlistPatternsUsed(params: {
  userId: string;
  agentId?: string;
  patterns: string[];
  command: string;
  resolvedPath?: string;
}): Promise<void> {
  const agentId = params.agentId?.trim() || "main";
  const patterns = Array.from(
    new Set(
      params.patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0),
    ),
  );
  if (patterns.length === 0) {
    return;
  }

  await db
    .update(avaExecAllowlistEntries)
    .set({
      lastUsedAt: new Date(),
      lastUsedCommand: params.command,
      lastResolvedPath: params.resolvedPath ?? null,
    })
    .where(
      and(
        eq(avaExecAllowlistEntries.userId, params.userId),
        eq(avaExecAllowlistEntries.agentId, agentId),
        inArray(avaExecAllowlistEntries.pattern, patterns),
      ),
    );
}

export interface ResolvableUser {
  id: string;
  role: UserRole;
}

export async function getUserBySlackExternalId(slackUserId: string): Promise<ResolvableUser | null> {
  const [row] = await db
    .select({
      id: avaUsers.id,
      role: avaUsers.role,
    })
    .from(avaUserIdentities)
    .innerJoin(avaUsers, eq(avaUserIdentities.userId, avaUsers.id))
    .where(
      and(
        eq(avaUserIdentities.provider, "slack"),
        eq(avaUserIdentities.externalId, slackUserId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function getUserRoleById(userId: string): Promise<UserRole | null> {
  try {
    const [row] = await db
      .select({ role: avaUsers.role })
      .from(avaUsers)
      .where(eq(avaUsers.id, userId))
      .limit(1);
    return row?.role ?? null;
  } catch {
    // Some call-sites can provide non-UUID user IDs from legacy session records.
    // Treat these as non-privileged instead of throwing.
    return null;
  }
}

export async function getExecApprovalRecord(
  approvalId: string,
): Promise<{
  id: string;
  sessionId: string;
  userId: string | null;
  agentId: string;
  command: string;
  status: ExecApprovalStatus;
  decision: ExecApprovalDecision | null;
} | null> {
  const [row] = await db
    .select({
      id: avaExecApprovals.id,
      sessionId: avaExecApprovals.sessionId,
      userId: avaExecApprovals.userId,
      agentId: avaExecApprovals.agentId,
      command: avaExecApprovals.command,
      status: avaExecApprovals.status,
      decision: avaExecApprovals.decision,
    })
    .from(avaExecApprovals)
    .where(eq(avaExecApprovals.id, approvalId))
    .limit(1);

  return row ?? null;
}
