import { randomUUID } from "node:crypto";
import type { Block, KnownBlock } from "@slack/web-api";
import { createLogger } from "../lib/logger.js";
import { getSlackApp } from "../lib/slack/app.js";
import type { ExecSecurity } from "../lib/exec-approvals.js";
import { resolveAllowAlwaysPatterns } from "../lib/exec-approvals.js";
import {
  authorizeSlackApprovalResolver,
  authorizeUserApprovalResolver,
} from "./exec-approval-auth.js";
import {
  ExecApprovalManager,
  type ManagedExecApprovalDecision,
  type ManagedExecApprovalOutcome,
  type ManagedExecApprovalRecord,
  type ManagedExecApprovalRequest,
} from "./exec-approval-manager.js";
import {
  createExecApprovalRecord,
  getSessionRoutingContext,
  listExecAllowlistPatterns,
  markExecAllowlistPatternsUsed,
  type SessionRoutingContext,
  updateExecApprovalRecord,
  upsertExecAllowlistPatterns,
} from "./exec-approval-store.js";

const log = createLogger("agent", { component: "exec-approval" });

export type ExecApprovalAsk = "on-miss" | "always";
export type ExecApprovalHost = "sandbox" | "gateway" | "node";
export type ExecApprovalDecision = ManagedExecApprovalDecision;

export interface ExecApprovalRequest {
  sessionId: string;
  command: string;
  cwd: string;
  host: ExecApprovalHost;
  security: ExecSecurity;
  ask: ExecApprovalAsk;
  timeoutMs?: number;
  userId?: string;
  agentId?: string;
  resolvedPath?: string;
}

export interface ExecApprovalDecisionResult {
  approvalId: string;
  approved: boolean;
  decision: ExecApprovalDecision | "timeout" | "error";
  reason?: string;
  resolvedBy?: string;
}

export interface ExecApprovalNotifier {
  name: string;
  supports: (session: SessionRoutingContext) => boolean;
  sendPrompt: (params: {
    approvalId: string;
    request: ExecApprovalRequest;
    session: SessionRoutingContext;
    expiresAtMs: number;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export const EXEC_APPROVAL_ACTION_ID = "exec_approval_decision";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MIN_APPROVAL_TIMEOUT_MS = 5_000;
const MAX_APPROVAL_TIMEOUT_MS = 1_800_000;
const APPROVAL_RESULT_RETENTION_MS = 30_000;
const COMMAND_PREVIEW_MAX = 220;
const CWD_PREVIEW_MAX = 140;

const manager = new ExecApprovalManager();
const approvalNotifiers: ExecApprovalNotifier[] = [createSlackExecApprovalNotifier()];
const decisionResultPromises = new Map<string, Promise<ExecApprovalDecisionResult>>();

function clampTimeoutMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  const rounded = Math.floor(value);
  if (rounded < MIN_APPROVAL_TIMEOUT_MS) return MIN_APPROVAL_TIMEOUT_MS;
  if (rounded > MAX_APPROVAL_TIMEOUT_MS) return MAX_APPROVAL_TIMEOUT_MS;
  return rounded;
}

function normalizeCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function shorten(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function sanitizeInlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

function toDecisionResult(
  approvalId: string,
  outcome: ManagedExecApprovalOutcome,
): ExecApprovalDecisionResult {
  if (outcome.decision === "allow-once" || outcome.decision === "allow-always") {
    return {
      approvalId,
      approved: true,
      decision: outcome.decision,
      reason: outcome.reason,
      resolvedBy: outcome.resolvedBy ?? undefined,
    };
  }

  if (outcome.decision === "deny") {
    return {
      approvalId,
      approved: false,
      decision: "deny",
      reason: outcome.reason ?? "denied by approver",
      resolvedBy: outcome.resolvedBy ?? undefined,
    };
  }

  if (outcome.timedOut) {
    return {
      approvalId,
      approved: false,
      decision: "timeout",
      reason: outcome.reason ?? "approval timed out",
      resolvedBy: outcome.resolvedBy ?? undefined,
    };
  }

  return {
    approvalId,
    approved: false,
    decision: "error",
    reason: outcome.reason ?? "approval flow failed",
    resolvedBy: outcome.resolvedBy ?? undefined,
  };
}

async function recordResolvedOutcome(params: {
  record: ManagedExecApprovalRecord;
  result: ExecApprovalDecisionResult;
}): Promise<void> {
  const { record, result } = params;
  const resolvedAtMs = Date.now();

  if (result.decision === "allow-always" && record.request.userId) {
    const patterns = resolveAllowAlwaysPatterns({
      command: record.request.command,
      cwd: record.request.cwd,
      resolvedPath: record.request.resolvedPath,
    });

    await upsertExecAllowlistPatterns({
      userId: record.request.userId,
      agentId: record.request.agentId ?? "main",
      patterns,
      approvalId: record.id,
      lastUsedCommand: record.request.command,
      lastResolvedPath: record.request.resolvedPath ?? undefined,
      metadata: {
        source: "approval-allow-always",
      },
    });
  }

  await updateExecApprovalRecord({
    id: record.id,
    status:
      result.decision === "timeout"
        ? "expired"
        : result.decision === "error"
          ? "error"
          : "resolved",
    decision:
      result.decision === "allow-once" ||
      result.decision === "allow-always" ||
      result.decision === "deny"
        ? result.decision
        : null,
    reason: result.reason,
    resolvedBy: result.resolvedBy,
    resolvedAtMs,
  });
}

function buildSlackApprovalBlocks(params: {
  approvalId: string;
  request: ExecApprovalRequest;
  expiresAtMs: number;
}): Array<Block | KnownBlock> {
  const commandPreview = sanitizeInlineCode(
    shorten(normalizeCommandKey(params.request.command), COMMAND_PREVIEW_MAX),
  );
  const cwdPreview = sanitizeInlineCode(
    shorten(params.request.cwd || process.cwd(), CWD_PREVIEW_MAX),
  );
  const approvalShortId = params.approvalId.slice(0, 8);
  const expiresIso = new Date(params.expiresAtMs).toISOString();

  const lines = [
    "*Exec approval required*",
    `ID: \`${approvalShortId}\``,
    `Command: \`${commandPreview}\``,
    `CWD: \`${cwdPreview}\``,
    `Host: \`${params.request.host}\``,
    `Security: \`${params.request.security}\``,
    `Ask mode: \`${params.request.ask}\``,
  ];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Expires: ${expiresIso}`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: EXEC_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Approve once" },
          style: "primary",
          value: encodeExecApprovalActionValue({
            approvalId: params.approvalId,
            decision: "allow-once",
          }),
        },
        {
          type: "button",
          action_id: EXEC_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Always allow" },
          value: encodeExecApprovalActionValue({
            approvalId: params.approvalId,
            decision: "allow-always",
          }),
        },
        {
          type: "button",
          action_id: EXEC_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          value: encodeExecApprovalActionValue({
            approvalId: params.approvalId,
            decision: "deny",
          }),
        },
      ],
    },
  ];
}

type SlackPromptTarget = {
  channelId: string;
  threadTs?: string;
};

async function resolveSlackPromptTarget(
  externalId: string,
): Promise<SlackPromptTarget | null> {
  const parts = externalId.split(":");
  if (parts[0] !== "slack") {
    return null;
  }

  if (parts[1] === "dm") {
    const userId = parts[2]?.trim();
    if (!userId) {
      return null;
    }
    const opened = await getSlackApp().client.conversations.open({ users: userId });
    const channelId = opened.channel?.id?.trim();
    if (!channelId) {
      return null;
    }
    return { channelId };
  }

  const channelId = parts[1]?.trim();
  const threadTs = parts[2]?.trim();
  if (!channelId) {
    return null;
  }

  return {
    channelId,
    threadTs: threadTs && !threadTs.startsWith("dm:") ? threadTs : undefined,
  };
}

function createSlackExecApprovalNotifier(): ExecApprovalNotifier {
  return {
    name: "slack",
    supports: (session) =>
      session.source === "slack" &&
      typeof session.externalId === "string" &&
      session.externalId.startsWith("slack:"),
    sendPrompt: async ({ approvalId, request, session, expiresAtMs }) => {
      const externalId = session.externalId?.trim();
      if (!externalId) {
        return { ok: false, reason: "missing Slack externalId for approval prompt" };
      }

      const target = await resolveSlackPromptTarget(externalId);
      if (!target) {
        return { ok: false, reason: "could not resolve Slack target for approval prompt" };
      }

      const shortId = approvalId.slice(0, 8);
      const preview = shorten(normalizeCommandKey(request.command), 90);
      const text = `Exec approval required (${shortId}): ${preview}`;
      const blocks = buildSlackApprovalBlocks({ approvalId, request, expiresAtMs });

      await getSlackApp().client.chat.postMessage({
        channel: target.channelId,
        text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
        blocks,
        mrkdwn: true,
      });

      return { ok: true };
    },
  };
}

export function registerExecApprovalNotifier(notifier: ExecApprovalNotifier): void {
  approvalNotifiers.unshift(notifier);
}

export function encodeExecApprovalActionValue(input: {
  approvalId: string;
  decision: ExecApprovalDecision;
}): string {
  return JSON.stringify({
    approvalId: input.approvalId,
    decision: input.decision,
  });
}

export function decodeExecApprovalActionValue(raw: unknown): {
  approvalId: string;
  decision: ExecApprovalDecision;
} | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      approvalId?: unknown;
      decision?: unknown;
    };
    const approvalId =
      typeof parsed.approvalId === "string" ? parsed.approvalId.trim() : "";
    const decision = parsed.decision;
    if (!approvalId) {
      return null;
    }
    if (
      decision !== "allow-once" &&
      decision !== "allow-always" &&
      decision !== "deny"
    ) {
      return null;
    }
    return { approvalId, decision };
  } catch {
    return null;
  }
}

export type ExecApprovalPendingHandle = {
  approvalId: string;
  createdAtMs: number;
  expiresAtMs: number;
  decisionPromise: Promise<ExecApprovalDecisionResult>;
};

export type ExecApprovalPendingResult =
  | { ok: true; pending: ExecApprovalPendingHandle }
  | { ok: false; result: ExecApprovalDecisionResult };

export async function requestExecApprovalPending(
  request: ExecApprovalRequest,
  signal?: AbortSignal,
): Promise<ExecApprovalPendingResult> {
  const session = await getSessionRoutingContext(request.sessionId);
  if (!session) {
    return {
      ok: false,
      result: {
        approvalId: "",
        approved: false,
        decision: "error",
        reason: `session ${request.sessionId} not found`,
      },
    };
  }

  const notifier = approvalNotifiers.find((candidate) => candidate.supports(session));

  if (!notifier) {
    return {
      ok: false,
      result: {
        approvalId: "",
        approved: false,
        decision: "error",
        reason: `no approval notifier available for session source "${session.source}"`,
      },
    };
  }

  const approvalId = randomUUID();
  const timeoutMs = clampTimeoutMs(request.timeoutMs);
  const agentId = request.agentId?.trim() || "main";

  const managedRequest: ManagedExecApprovalRequest = {
    sessionId: request.sessionId,
    userId: request.userId?.trim() || session.userId,
    agentId,
    command: request.command,
    cwd: request.cwd,
    host: request.host,
    security: request.security,
    ask: request.ask,
    resolvedPath: request.resolvedPath,
  };

  const record = manager.create(managedRequest, timeoutMs, approvalId);
  const outcomePromise = manager.register(record, timeoutMs);

  await createExecApprovalRecord({
    id: record.id,
    sessionId: record.request.sessionId,
    userId: record.request.userId,
    agentId,
    command: record.request.command,
    cwd: record.request.cwd,
    host: record.request.host,
    security: record.request.security,
    ask: record.request.ask,
    expiresAtMs: record.expiresAtMs,
    metadata: {
      notifier: notifier.name,
    },
  });

  if (signal) {
    if (signal.aborted) {
      manager.fail(approvalId, "tool call aborted");
    } else {
      signal.addEventListener(
        "abort",
        () => {
          manager.fail(approvalId, "tool call aborted");
        },
        { once: true },
      );
    }
  }

  const decisionPromise = outcomePromise.then(async (outcome) => {
    const decisionResult = toDecisionResult(record.id, outcome);
    await recordResolvedOutcome({ record, result: decisionResult });
    return decisionResult;
  });

  decisionResultPromises.set(approvalId, decisionPromise);
  void decisionPromise.finally(() => {
    setTimeout(() => {
      decisionResultPromises.delete(approvalId);
    }, APPROVAL_RESULT_RETENTION_MS).unref();
  });

  try {
    const sendResult = await notifier.sendPrompt({
      approvalId,
      request,
      session,
      expiresAtMs: record.expiresAtMs,
    });

    if (!sendResult.ok) {
      manager.fail(approvalId, sendResult.reason);
    } else {
      log.info(
        {
          approvalId,
          sessionId: request.sessionId,
          source: session.source,
          notifier: notifier.name,
          ask: request.ask,
          host: request.host,
          security: request.security,
          expiresAtMs: record.expiresAtMs,
        },
        "Exec approval prompt sent",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        approvalId,
        sessionId: request.sessionId,
        notifier: notifier.name,
        err: reason,
      },
      "Failed to deliver exec approval prompt",
    );
    manager.fail(approvalId, `failed to deliver approval prompt: ${reason}`);
  }

  return {
    ok: true,
    pending: {
      approvalId,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      decisionPromise,
    },
  };
}

export async function requestExecApproval(
  request: ExecApprovalRequest,
  signal?: AbortSignal,
): Promise<ExecApprovalDecisionResult> {
  const pendingResult = await requestExecApprovalPending(request, signal);
  if (!pendingResult.ok) {
    return pendingResult.result;
  }
  return pendingResult.pending.decisionPromise;
}

export async function waitForExecApprovalDecision(
  approvalId: string,
): Promise<ExecApprovalDecisionResult | null> {
  const key = approvalId.trim();
  if (!key) {
    return null;
  }
  const promise = decisionResultPromises.get(key);
  if (!promise) {
    return null;
  }
  return promise;
}

export function resolveExecApprovalDecision(input: {
  approvalId: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string;
}): { ok: true } | { ok: false; reason: string } {
  const approvalId = input.approvalId.trim();
  if (!approvalId) {
    return { ok: false, reason: "missing approval id" };
  }

  const settled = manager.resolve(
    approvalId,
    input.decision,
    input.resolvedBy,
    input.decision === "deny" ? "denied by approver" : undefined,
  );

  if (!settled) {
    return { ok: false, reason: "approval is not pending (already resolved or expired)" };
  }

  return { ok: true };
}

export async function resolveExecApprovalDecisionBySlackUser(input: {
  approvalId: string;
  decision: ExecApprovalDecision;
  slackUserId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auth = await authorizeSlackApprovalResolver({
    approvalId: input.approvalId,
    slackUserId: input.slackUserId,
  });
  if (!auth.ok) {
    return { ok: false, reason: auth.reason ?? "not authorized" };
  }

  return resolveExecApprovalDecision({
    approvalId: input.approvalId,
    decision: input.decision,
    resolvedBy: auth.resolvedBy,
  });
}

export async function resolveExecApprovalDecisionByUserId(input: {
  approvalId: string;
  decision: ExecApprovalDecision;
  userId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auth = await authorizeUserApprovalResolver({
    approvalId: input.approvalId,
    userId: input.userId,
  });
  if (!auth.ok) {
    return { ok: false, reason: auth.reason ?? "not authorized" };
  }

  return resolveExecApprovalDecision({
    approvalId: input.approvalId,
    decision: input.decision,
    resolvedBy: auth.resolvedBy,
  });
}

export async function getExecAllowlistForUser(params: {
  userId?: string | null;
  agentId?: string;
  baseAllowlist?: string[];
}): Promise<string[]> {
  const merged = new Set<string>();
  for (const pattern of params.baseAllowlist ?? []) {
    if (pattern.trim()) {
      merged.add(pattern.trim());
    }
  }

  if (!params.userId) {
    return Array.from(merged);
  }

  const persisted = await listExecAllowlistPatterns(
    params.userId,
    params.agentId?.trim() || "main",
  );
  for (const pattern of persisted) {
    if (pattern.trim()) {
      merged.add(pattern.trim());
    }
  }

  return Array.from(merged);
}

export async function recordExecAllowlistUsage(params: {
  userId?: string | null;
  agentId?: string;
  patterns: string[];
  command: string;
  resolvedPath?: string;
}): Promise<void> {
  if (!params.userId) {
    return;
  }

  await markExecAllowlistPatternsUsed({
    userId: params.userId,
    agentId: params.agentId,
    patterns: params.patterns,
    command: params.command,
    resolvedPath: params.resolvedPath,
  });
}

// Deprecated: allow-always now persists to DB allowlist and is resolved via getExecAllowlistForUser().
export function isExecApprovalAlwaysAllowed(_sessionId: string, _command: string): boolean {
  return false;
}

export function resetExecApprovalServiceForTests(): void {
  manager.reset();
  decisionResultPromises.clear();
}
