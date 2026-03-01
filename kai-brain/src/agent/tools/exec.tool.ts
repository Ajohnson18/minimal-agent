/**
 * Exec Tool
 *
 * Shell command execution with background/yield, PTY, env vars, onUpdate streaming.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getConfig } from "../../lib/config-loader.js";
import { buildExecEnv } from "../../lib/exec-security.js";
import type { UserCredentials } from "../../db/schema/users.js";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import {
  createEmptySession,
  addSession,
  appendOutput,
  drainSession,
  markExited,
  markBackgrounded,
  type SessionStdin,
} from "./process-registry.js";
import { queueSystemEvent } from "../../gateway/services/system-events.js";
import { wakeHeartbeat } from "../../gateway/services/heartbeat.service.js";
import { execInContainer } from "../../sandbox/container-manager.js";
import {
  evaluateShellAllowlist,
  resolveSafeBins,
  type ExecSecurity,
} from "../../lib/exec-approvals.js";
import {
  requestExecApproval,
  requestExecApprovalPending,
  getExecAllowlistForUser,
  recordExecAllowlistUsage,
  type ExecApprovalDecisionResult,
  type ExecApprovalRequest,
} from "../../services/exec-approval.service.js";
import type { CompletionPolicy } from "../../core/system-events.js";


type ExecHost = "sandbox" | "gateway" | "node";
type ExecAsk = "off" | "on-miss" | "always";
type ExecCompletionPolicy = CompletionPolicy;

const SECURITY_RANK: Record<ExecSecurity, number> = {
  deny: 0,
  allowlist: 1,
  full: 2,
};

function minSecurity(configured: ExecSecurity, requested: ExecSecurity): ExecSecurity {
  return SECURITY_RANK[requested] < SECURITY_RANK[configured] ? requested : configured;
}

function normalizeExecHost(value?: string): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

function normalizeExecSecurity(value?: string): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

function normalizeExecAsk(value?: string): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

function formatWarnings(warnings: string[]): string {
  return warnings.length > 0 ? `${warnings.join("\n")}\n\n` : "";
}

function mergePathPrepend(existing: string | undefined, prepend: string[]): string | undefined {
  if (prepend.length === 0) {
    return existing;
  }
  const currentParts = (existing ?? "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...prepend, ...currentParts]) {
    if (seen.has(part)) continue;
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}

function resolveEnvOverrides(
  env:
    | Array<{ key: string; value: string }>
    | Record<string, string>
    | undefined,
): Array<{ key: string; value: string }> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function hasScriptPtySupport(): boolean {
  if (process.platform === "win32") return false;
  const result = spawnSync("sh", ["-lc", "command -v script >/dev/null 2>&1"]);
  return result.status === 0;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}


/**
 * Detect likely shell env var injection in Python/Node heredoc or -c script bodies.
 * Returns the matched variable reference string, or null if clean.
 */
function detectEnvVarInjection(command: string): string | null {
  // Only check commands that embed script bodies via heredoc or -c
  const isHeredoc = /<<['"]?(\w+)['"]?/.test(command);
  const isInlineScript = /\b(python3?|node|ruby|perl)\s+.*-c\s/.test(command);
  if (!isHeredoc && !isInlineScript) return null;

  // Look for unescaped $VAR or ${VAR} patterns (skip $( subshells and $' quoting)
  const match = command.match(/\$(?!\(|')(\{?\w{2,}\}?)/);
  return match ? `$${match[1]}` : null;
}

function normalizeTrustedDir(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return normalized.length === 0 ? path.sep : normalized;
}

function isPathWithinTrustedDir(
  resolvedPath: string,
  trustedDirs: string[],
): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  return trustedDirs.some((dir) => {
    const normalizedDir = normalizeTrustedDir(dir);
    return (
      normalizedPath === normalizedDir ||
      normalizedPath.startsWith(`${normalizedDir}${path.sep}`)
    );
  });
}

function detectCommandObfuscationSignals(command: string): string[] {
  const signals: string[] = [];
  const lower = command.toLowerCase();

  if (/\beval\b/.test(lower)) {
    signals.push("eval");
  }
  if (
    /\bbase64\b/.test(lower) &&
    /(\|\s*(bash|sh)\b|>\s*\/tmp\/|decode)/.test(lower)
  ) {
    signals.push("base64-shell");
  }
  if (/\bpython(?:3)?\b[^\n;|&]*\b-c\b[^\n]*(exec|compile)\s*\(/i.test(command)) {
    signals.push("python-exec-inline");
  }
  if (/\bnode\b[^\n;|&]*\b-e\b[^\n]*(eval|Function\s*\()/i.test(command)) {
    signals.push("node-eval-inline");
  }
  if (/\bxxd\b[^\n;|&]*-r\b|\bopenssl\b[^\n;|&]*enc\b/i.test(command)) {
    signals.push("binary-decode");
  }

  return Array.from(new Set(signals));
}

function normalizeCompletionPolicyInput(
  policy: {
    relay?: "auto" | "always" | "silent";
    relevance?: "user" | "internal";
    reason?: string;
  } | undefined,
): {
  relay?: "auto" | "always" | "silent";
  relevance?: "user" | "internal";
  reason?: string;
} {
  if (!policy) {
    return {};
  }
  const relay =
    policy.relay === "auto" || policy.relay === "always" || policy.relay === "silent"
      ? policy.relay
      : undefined;
  const relevance =
    policy.relevance === "user" || policy.relevance === "internal"
      ? policy.relevance
      : undefined;
  const reason = typeof policy.reason === "string" ? policy.reason.trim() : "";
  return {
    ...(relay ? { relay } : {}),
    ...(relevance ? { relevance } : {}),
    ...(reason ? { reason } : {}),
  };
}

function resolveExecCompletionPolicy(params: {
  perCallPolicy:
    | {
        relay?: "auto" | "always" | "silent";
        relevance?: "user" | "internal";
        reason?: string;
      }
    | undefined;
  sessionSource?: string | null;
}): ExecCompletionPolicy {
  const normalizedPerCall = normalizeCompletionPolicyInput(params.perCallPolicy);
  const normalizedSessionSource = (params.sessionSource ?? "").trim().toLowerCase();
  const defaultRelevance = normalizedSessionSource === "subagent" ? "internal" : "user";

  return {
    relay: normalizedPerCall.relay ?? "auto",
    relevance: normalizedPerCall.relevance ?? defaultRelevance,
    ...(normalizedPerCall.reason ? { reason: normalizedPerCall.reason } : {}),
  };
}

const ExecSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory (defaults to cwd)" })
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (kills process on expiry)" })
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before auto-backgrounding (default 10000). Set to 0 for immediate background.",
    })
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background immediately (equivalent to yieldMs=0)" })
  ),
  pty: Type.Optional(
    Type.Boolean({ description: "Run in pseudo-terminal (for interactive CLIs)" })
  ),
  completionPolicy: Type.Optional(
    Type.Object({
      relay: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("always"),
          Type.Literal("silent"),
        ]),
      ),
      relevance: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("internal")]),
      ),
      reason: Type.Optional(Type.String()),
    }),
  ),
  env: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          key: Type.String(),
          value: Type.String(),
        }),
        { description: "Custom environment variables (legacy format)" },
      ),
      Type.Record(Type.String(), Type.String()),
    ])
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Request elevated exec mode (requires configured security=full).",
    }),
  ),
  host: Type.Optional(
    Type.Unsafe<ExecHost>({
      type: "string",
      enum: ["sandbox", "gateway", "node"],
      description: "Exec host. sandbox uses Docker container when available.",
    }),
  ),
  security: Type.Optional(
    Type.Unsafe<ExecSecurity>({
      type: "string",
      enum: ["deny", "allowlist", "full"],
      description: "Per-call security mode override (can only make policy stricter).",
    }),
  ),
  ask: Type.Optional(
    Type.Unsafe<ExecAsk>({
      type: "string",
      enum: ["off", "on-miss", "always"],
      description: "Approval mode. on-miss prompts on allowlist misses; always prompts every time.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node (currently unsupported in this build).",
    }),
  ),
});

type ExecArgs = Static<typeof ExecSchema>;

export function createExecTool(options?: {
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sessionSource?: string | null;
  userCredentials?: UserCredentials | null;
  sandboxContainer?: string;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execAskFallback?: ExecSecurity;
  execAllowlist?: string[];
  execNode?: string;
  execPathPrepend?: string[];
  execSafeBins?: string[];
  execSafeBinTrustedDirs?: string[];
  execBackgroundMs?: number;
  execTimeoutSec?: number;
  deliveryExternalId?: string;
  accountId?: string;
  approvalRunningNoticeMs?: number;
  approvalRequester?: (
    request: ExecApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ExecApprovalDecisionResult>;
  approvalRequesterPending?: (
    request: ExecApprovalRequest,
    signal?: AbortSignal,
  ) => ReturnType<typeof requestExecApprovalPending>;
  alwaysAllowedChecker?: (sessionId: string, command: string) => boolean;
}): ToolDefinition {
  const userId = options?.userId;
  const agentId = options?.agentId ?? "main";
  const parentSessionId = options?.sessionId;
  const sessionSource = options?.sessionSource;
  const userCredentials = options?.userCredentials;
  const sandboxContainer = options?.sandboxContainer;
  const execHost = options?.execHost ?? (sandboxContainer ? "sandbox" : "gateway");
  const execSecurity = options?.execSecurity ?? "full";
  const execAsk = options?.execAsk ?? "off";
  const execAskFallback = options?.execAskFallback ?? "deny";
  const execAllowlist = options?.execAllowlist ?? [];
  const execNode = options?.execNode;
  const execPathPrepend = options?.execPathPrepend ?? [];
  const execSafeBins = resolveSafeBins(options?.execSafeBins);
  const execSafeBinTrustedDirs = (
    options?.execSafeBinTrustedDirs ??
    getConfig().tools.exec.safeBinTrustedDirs
  ).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const defaultBackgroundMs = options?.execBackgroundMs ?? getConfig().tools.exec.yieldMs;
  const defaultTimeoutSec = options?.execTimeoutSec ?? 1_800;
  const approvalRunningNoticeMs = options?.approvalRunningNoticeMs ?? 10_000;
  const approvalRequester = options?.approvalRequester ?? requestExecApproval;
  const approvalRequesterPending =
    options?.approvalRequesterPending ??
    (options?.approvalRequester
      ? async (request: ExecApprovalRequest, signal?: AbortSignal) => {
          const startedAtMs = Date.now();
          const approvalId = randomUUID();
          return {
            ok: true as const,
            pending: {
              approvalId,
              createdAtMs: startedAtMs,
              expiresAtMs: startedAtMs + 120_000,
              decisionPromise: options.approvalRequester!(request, signal),
            },
          };
        }
      : requestExecApprovalPending);

  return {
    name: "exec",
    label: "Exec",
    description: `Run shell commands. Supports background execution with auto-yield, PTY mode, and custom env vars.

By default, waits up to 10s for completion. If the command is still running, it auto-backgrounds and returns a sessionId.
Use background=true to background immediately. Use the process tool to manage backgrounded sessions.
Use pty=true for interactive CLIs that need a terminal.
Use host/security for exec routing and policy overrides.
Use completionPolicy to control background completion relays: relay=always|silent|auto, relevance=user|internal.

Examples:
- Quick command: exec(command="ls -la")
- Long task: exec(command="npm install", background=true)
- Interactive: exec(command="python3 -i", pty=true, background=true)`,
    parameters: ExecSchema,
    execute: async (
      _toolCallId: string,
      args: ExecArgs,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Exec aborted" }],
          details: { aborted: true },
        };
      }

      const warnings: string[] = [];
      const sessionId = randomUUID().slice(0, 8);

      const requestedHost = normalizeExecHost(args.host);
      if (args.host && !requestedHost) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid host "${args.host}". Valid: sandbox, gateway, node.`,
            },
          ],
          details: { error: "invalid-host" },
        };
      }

      const requestedSecurity = normalizeExecSecurity(args.security);
      if (args.security && !requestedSecurity) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid security "${args.security}". Valid: deny, allowlist, full.`,
            },
          ],
          details: { error: "invalid-security" },
        };
      }

      const requestedAsk = normalizeExecAsk(args.ask);
      if (args.ask && !requestedAsk) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid ask "${args.ask}". Valid: off, on-miss, always.`,
            },
          ],
          details: { error: "invalid-ask" },
        };
      }

      let host: ExecHost = requestedHost ?? execHost;

      if (args.elevated) {
        if (execSecurity !== "full") {
          return {
            content: [
              {
                type: "text",
                text: "Exec elevated mode is unavailable: configured exec security is not full.",
              },
            ],
            details: { error: "elevated-unavailable" },
          };
        }
        host = "gateway";
      }

      const requestedNode = args.node?.trim() || execNode?.trim();

      if (host === "node") {
        return {
          content: [
            {
              type: "text",
              text: "Exec host=node is not supported in this build.",
            },
          ],
          details: { error: "unsupported-node-host", node: requestedNode },
        };
      }

      if (host === "sandbox" && !sandboxContainer) {
        warnings.push(
          'Warning: host="sandbox" requested but no sandbox container is available; falling back to gateway host execution.',
        );
        host = "gateway";
      }

      if (requestedNode) {
        warnings.push('Warning: "node" parameter is ignored unless host="node".');
      }

      const effectiveSecurity = args.elevated
        ? "full"
        : minSecurity(execSecurity, requestedSecurity ?? execSecurity);
      const askMode: ExecAsk = requestedAsk ?? execAsk;

      // Set up exit callback to trigger heartbeat on completion
      const cwd = args.workdir || process.cwd();
      const yieldMs = args.background
        ? 0
        : args.yieldMs ?? defaultBackgroundMs;
      const timeoutSec =
        typeof args.timeout === "number" ? args.timeout : defaultTimeoutSec;
      const completionPolicy = resolveExecCompletionPolicy({
        perCallPolicy: args.completionPolicy,
        sessionSource,
      });
      const session = createEmptySession(sessionId, args.command, cwd);
      let cachedDeliveryExternalId =
        typeof options?.deliveryExternalId === "string"
          ? options.deliveryExternalId.trim()
          : "";
      const resolveDeliveryExternalId = async (): Promise<string | undefined> => {
        if (cachedDeliveryExternalId) {
          return cachedDeliveryExternalId;
        }
        if (!parentSessionId || !isUuidLike(parentSessionId)) {
          return undefined;
        }
        const [sessionRow] = await db
          .select({ externalId: avaSessions.externalId })
          .from(avaSessions)
          .where(eq(avaSessions.id, parentSessionId))
          .limit(1);
        const externalId = sessionRow?.externalId?.trim();
        if (externalId) {
          cachedDeliveryExternalId = externalId;
          return externalId;
        }
        return undefined;
      };
      const queueExecSystemEvent = async (
        text: string,
        eventKey?: string,
        payloadOverrides?: Record<string, unknown>,
        metadataOverrides?: Record<string, unknown>,
      ): Promise<void> => {
        if (!parentSessionId) return;
        const deliveryExternalId = await resolveDeliveryExternalId();
        const accountId = options?.accountId?.trim();
        await queueSystemEvent({
          sessionId: parentSessionId,
          kind: "exec.completion",
          payload: {
            text,
            completionPolicy,
            command: args.command,
            ...(payloadOverrides ?? {}),
          },
          eventKey: eventKey ?? `exec:${session.id}`,
          expiresAt: Date.now() + 5 * 60 * 1000,
          metadata: {
            originKind: "exec",
            ...(deliveryExternalId ? { deliveryExternalId } : {}),
            ...(accountId ? { accountId } : {}),
            ...(metadataOverrides ?? {}),
          },
        });
        wakeHeartbeat(parentSessionId, {
          kind: "event",
          eventKind: "exec.completion",
          source: "exec",
        });
      };

      if (parentSessionId) {
        session.onExitCallback = (finished) => {
          const suppressByPolicy =
            completionPolicy.relay === "silent" ||
            (completionPolicy.relay === "auto" &&
              completionPolicy.relevance === "internal");
          if (suppressByPolicy) {
            return;
          }

          // Queue system event for heartbeat to pick up (async)
          void queueExecSystemEvent(
            `Background process "${finished.command.slice(0, 100)}" completed with exit code ${finished.exitCode ?? "unknown"}. Use process(action="log", sessionId="${finished.id}") to see output.`,
            `exec:${finished.id}`,
            {
              processSessionId: finished.id,
              exitCode: finished.exitCode,
              status: finished.status,
              outputSeq: {
                last: finished.lastSeq,
                stdout: finished.lastStdoutSeq,
                stderr: finished.lastStderrSeq,
              },
            },
          );
        };
      }

      const effectiveAllowlist = await getExecAllowlistForUser({
        userId,
        agentId,
        baseAllowlist: execAllowlist,
      });
      const allowlistPath = mergePathPrepend(process.env.PATH, execPathPrepend);
      const allowlistEval = evaluateShellAllowlist({
        command: args.command,
        allowlist: effectiveAllowlist,
        safeBins: execSafeBins,
        cwd,
        env: allowlistPath ? { PATH: allowlistPath } : undefined,
      });
      const obfuscationSignals = detectCommandObfuscationSignals(args.command);

      const safeBinTrustViolations = allowlistEval.segments.flatMap((segment, index) => {
        if (allowlistEval.segmentSatisfiedBy[index] !== "safeBins") {
          return [];
        }
        const resolvedPath = segment.resolution.resolvedPath?.trim() ?? "";
        if (!resolvedPath) {
          return [
            {
              segment: index,
              executable: segment.resolution.executableName,
              reason: "missing-resolved-path",
            },
          ];
        }
        if (isPathWithinTrustedDir(resolvedPath, execSafeBinTrustedDirs)) {
          return [];
        }
        return [
          {
            segment: index,
            executable: segment.resolution.executableName,
            resolvedPath,
            reason: "untrusted-safe-bin-path",
          },
        ];
      });

      const allowlistPathDriftWarnings = allowlistEval.segments.flatMap((segment, index) => {
        if (allowlistEval.segmentSatisfiedBy[index] !== "allowlist") {
          return [];
        }
        const resolvedPath = segment.resolution.resolvedPath?.trim() ?? "";
        if (!resolvedPath) return [];
        if (isPathWithinTrustedDir(resolvedPath, execSafeBinTrustedDirs)) return [];
        return [
          `Warning: allowlisted command "${segment.resolution.executableName}" resolved to untrusted path ${resolvedPath}.`,
        ];
      });
      if (allowlistPathDriftWarnings.length > 0) {
        warnings.push(...allowlistPathDriftWarnings);
      }

      const staticApproval =
        effectiveSecurity === "full"
          ? { allowed: true as const, reason: undefined as string | undefined }
          : effectiveSecurity === "deny"
            ? {
                allowed: false as const,
                reason: "Exec is disabled (security=deny).",
              }
            : allowlistEval.allowlistSatisfied
              ? { allowed: true as const, reason: undefined as string | undefined }
              : {
                  allowed: false as const,
                  reason: `Command is not in the exec allowlist. Allowed: ${effectiveAllowlist.join(", ") || "(none)"}`,
                };
      const safeBinTrustBlocked = safeBinTrustViolations.length > 0;
      const pathDrift = {
        trustedDirs: execSafeBinTrustedDirs,
        safeBinViolations: safeBinTrustViolations,
        allowlistWarnings: allowlistPathDriftWarnings,
      };
      if (safeBinTrustBlocked) {
        warnings.push(
          "Warning: one or more safe-bin commands resolved outside trusted directories.",
        );
      }
      const matchedAllowlistPatterns = allowlistEval.allowlistMatches.map(
        (entry) => entry.pattern,
      );
      const firstResolvedPath = allowlistEval.segments[0]?.resolution.resolvedPath ?? undefined;

      const obfuscationRequiresApproval =
        obfuscationSignals.length > 0 && effectiveSecurity !== "deny";
      const needsInteractiveApproval =
        (askMode !== "off" &&
          effectiveSecurity !== "deny" &&
          (askMode === "always" || !staticApproval.allowed)) ||
        obfuscationRequiresApproval;

      const staticDeniedReason = safeBinTrustBlocked
        ? "Command resolved outside trusted safe-bin directories."
        : staticApproval.reason;

      if ((!staticApproval.allowed || safeBinTrustBlocked) && !needsInteractiveApproval) {
        return {
          content: [{ type: "text", text: `Exec denied: ${staticDeniedReason}` }],
          details: {
            denied: true,
            reason: staticDeniedReason,
            security: effectiveSecurity,
            pathDrift,
            obfuscationSignals,
          },
        };
      }

      if (
        staticApproval.allowed &&
        matchedAllowlistPatterns.length > 0 &&
        !needsInteractiveApproval
      ) {
        await recordExecAllowlistUsage({
          userId,
          agentId,
          patterns: matchedAllowlistPatterns,
          command: args.command,
          resolvedPath: firstResolvedPath,
        });
      }

      if (needsInteractiveApproval) {
        if (!parentSessionId) {
          const obfuscationText = obfuscationRequiresApproval
            ? ` obfuscation signal(s): ${obfuscationSignals.join(", ")}.`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Exec denied: approval-required execution needs a routable session context (Slack/other channel integration).${obfuscationText}`,
              },
            ],
            details: {
              denied: true,
              reason: obfuscationRequiresApproval
                ? "obfuscation-requires-approval-without-session-context"
                : "missing-session-context",
              ask: askMode,
              security: effectiveSecurity,
              obfuscationSignals,
              pathDrift,
            },
          };
        }

        const started = await approvalRequesterPending(
          {
            sessionId: parentSessionId,
            command: args.command,
            cwd,
            host,
            security: effectiveSecurity,
            ask: askMode === "always" ? "always" : "on-miss",
            userId,
            agentId,
            resolvedPath: firstResolvedPath,
          },
          signal,
        );

        if (!started.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Exec denied: ${started.result.reason ?? "approval flow unavailable"}`,
              },
            ],
            details: {
              denied: true,
              reason: started.result.reason ?? "approval-flow-error",
              security: effectiveSecurity,
              ask: askMode,
              decision: started.result.decision,
              obfuscationSignals,
              pathDrift,
            },
          };
        }

        const pending = started.pending;
        const approvalSlug = pending.approvalId.slice(0, 8);

        void (async () => {
          let runningNotice: ReturnType<typeof setTimeout> | null = null;
          try {
            const decision = await pending.decisionPromise;

            let approved = decision.approved;
            let fallbackReason: string | null = null;

            if (!approved && decision.decision === "timeout") {
              if (execAskFallback === "full") {
                approved = true;
                fallbackReason = "approval timed out; askFallback=full applied.";
              } else if (
                execAskFallback === "allowlist" &&
                allowlistEval.allowlistSatisfied
              ) {
                approved = true;
                fallbackReason =
                  "approval timed out; askFallback=allowlist applied for allowlisted command.";
              }
            }

            if (!approved) {
              await queueExecSystemEvent(
                `Exec denied (${approvalSlug}): ${decision.reason ?? "approval denied"}`,
                `exec-approval:${pending.approvalId}`,
                {
                  approvalId: pending.approvalId,
                  decision: decision.decision,
                  reason: decision.reason,
                },
              );
              return;
            }

            if (fallbackReason) {
              await queueExecSystemEvent(
                `Exec approval fallback (${approvalSlug}): ${fallbackReason}`,
                `exec-approval:${pending.approvalId}:fallback`,
                {
                  approvalId: pending.approvalId,
                  fallback: execAskFallback,
                },
              );
            }

            if (approvalRunningNoticeMs > 0) {
              runningNotice = setTimeout(() => {
                void queueExecSystemEvent(
                  `Exec running after approval (${approvalSlug}): ${args.command}`,
                  `exec-approval:${pending.approvalId}:running`,
                  {
                    approvalId: pending.approvalId,
                    command: args.command,
                  },
                );
              }, approvalRunningNoticeMs);
              runningNotice.unref();
            }

            const approvedTool = createExecTool({
              ...options,
              userId,
              agentId,
              execHost: host,
              execSecurity: "full",
              execAsk: "off",
              approvalRequester,
              approvalRequesterPending,
            });

            const followupArgs: ExecArgs = {
              ...args,
              host,
              security: "full",
              ask: "off",
              background: true,
              ...(requestedNode ? { node: requestedNode } : {}),
            };

            const followup = await approvedTool.execute(
              `${sessionId}-approved`,
              followupArgs,
              undefined,
              undefined,
              _ctx as Parameters<typeof approvedTool.execute>[4],
            );

            const followupDetails = (followup.details ?? {}) as {
              status?: string;
              sessionId?: string;
              exitCode?: number | null;
            };

            if (
              followupDetails.status &&
              followupDetails.status !== "running" &&
              followupDetails.status !== "approval-pending"
            ) {
              await queueExecSystemEvent(
                `Exec finished (${approvalSlug}) with status ${followupDetails.status} and exit code ${followupDetails.exitCode ?? "unknown"}.`,
                `exec-approval:${pending.approvalId}:finished`,
                {
                  approvalId: pending.approvalId,
                  status: followupDetails.status,
                  exitCode: followupDetails.exitCode,
                  processSessionId: followupDetails.sessionId,
                },
              );
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await queueExecSystemEvent(
              `Exec failed after approval (${approvalSlug}): ${reason}`,
              `exec-approval:${pending.approvalId}:error`,
              {
                approvalId: pending.approvalId,
                error: reason,
              },
            );
          } finally {
            if (runningNotice) clearTimeout(runningNotice);
          }
        })();

        return {
          content: [
            {
              type: "text",
                text:
                `${formatWarnings(warnings)}Approval required (id ${approvalSlug}). ` +
                "Approve to run; updates will arrive after completion.",
            },
          ],
            details: {
              status: "approval-pending",
              approvalId: pending.approvalId,
              approvalSlug,
              expiresAtMs: pending.expiresAtMs,
              host,
              command: args.command,
              cwd,
              nodeId: requestedNode,
              resolvedPath: firstResolvedPath,
              obfuscationSignals,
              pathDrift,
            },
          };
        }

      // Build env with security validation + user credential injection
      let env: Record<string, string>;
      try {
        env = buildExecEnv(process.env, resolveEnvOverrides(args.env), userCredentials);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          details: { error: (err as Error).message },
        };
      }
      if (execPathPrepend.length > 0) {
        const mergedPath = mergePathPrepend(env.PATH, execPathPrepend);
        if (mergedPath) {
          env.PATH = mergedPath;
        }
      }

      // ── Preflight: detect shell env var injection in script bodies ──
      const envVarInjectionMatch = detectEnvVarInjection(args.command);
      if (envVarInjectionMatch) {
        return {
          content: [{
            type: "text",
            text: `Warning: Command contains shell variable references (${envVarInjectionMatch}) that will be expanded by the shell before the interpreter sees them. This often causes silent failures. Write the script to a file and execute it instead, or use proper quoting.`,
          }],
          details: { warning: "env_var_injection", match: envVarInjectionMatch },
        };
      }

      // ── Sandboxed execution path ──────────────────────────────────
      if (host === "sandbox" && sandboxContainer) {
        addSession(session);
        if (args.pty) {
          warnings.push(
            "Warning: PTY is not supported for sandbox exec in this build; running without PTY.",
          );
        }
        if (args.background || args.yieldMs !== undefined) {
          warnings.push(
            "Warning: background/yield options are not supported for sandbox exec in this build; running synchronously.",
          );
        }
        try {
          const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 300_000;
          const result = await execInContainer(
            sandboxContainer,
            args.command,
            env,
            args.workdir,
            timeoutMs,
          );

          appendOutput(session, "stdout", result.stdout);
          if (result.stderr) appendOutput(session, "stderr", result.stderr);

          const status: "completed" | "killed" = result.timedOut ? "killed" : "completed";
          markExited(session, result.exitCode, null, status);

          const parts: string[] = [];
          if (result.stdout) parts.push(result.stdout);
          if (result.stderr && result.exitCode !== 0) parts.push(`STDERR:\n${result.stderr}`);
          if (result.timedOut) parts.push("Execution timed out.");
          parts.push(`Exit code: ${result.exitCode}`);

          return {
            content: [
              {
                type: "text",
                text:
                  `${formatWarnings(warnings)}${parts.join("\n").slice(0, 100_000)}` ||
                  `Command completed with exit code ${result.exitCode}`,
              },
            ],
            details: {
              status,
              exitCode: result.exitCode,
              sessionId,
              sandboxed: true,
              host,
              security: effectiveSecurity,
              resolvedPath: firstResolvedPath,
              pathDrift,
              obfuscationSignals,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          markExited(session, 1, null, "failed");
          return {
            content: [
              { type: "text", text: `${formatWarnings(warnings)}Sandbox exec error: ${msg}` },
            ],
            details: {
              error: msg,
              sandboxed: true,
              host,
              security: effectiveSecurity,
              resolvedPath: firstResolvedPath,
              pathDrift,
              obfuscationSignals,
            },
          };
        }
      }

      // ── Host execution path ───────────────────────────────────────
      const ptyRequested = args.pty === true;
      const useScriptPty = ptyRequested && hasScriptPtySupport();
      if (ptyRequested && !useScriptPty) {
        warnings.push(
          'Warning: PTY requested but "script" is unavailable; running without PTY.',
        );
      }
      const spawnCommand = useScriptPty ? "script" : "sh";
      const spawnArgs = useScriptPty
        ? ["-q", "/dev/null", "sh", "-lc", args.command]
        : ["-c", args.command];

      // Spawn the process (try detached first, fallback)
      let child;
      try {
        child = spawn(spawnCommand, spawnArgs, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch {
        child = spawn(spawnCommand, spawnArgs, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }

      session.child = child;
      session.pid = child.pid;

      const stdin: SessionStdin = {
        write: (data, cb) => child.stdin?.write(data, cb),
        end: () => child.stdin?.end(),
        get destroyed() { return child.stdin?.destroyed; },
      };
      session.stdin = stdin;

      addSession(session);

      let updateInterval: ReturnType<typeof setInterval> | null = null;
      if (onUpdate) {
        updateInterval = setInterval(() => {
          if (session.tail) {
            onUpdate({
              content: [{ type: "text", text: session.tail }],
              details: { status: "running", sessionId },
            });
          }
        }, 3000);
      }

      child.stdout.on("data", (data: Buffer) => {
        appendOutput(session, "stdout", data.toString());
      });

      child.stderr.on("data", (data: Buffer) => {
        appendOutput(session, "stderr", data.toString());
      });

      let timedOut = false;
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.on("close", (code, sig) => resolve({ code, signal: sig }));
        child.on("error", (err) => {
          appendOutput(session, "stderr", err.message);
          resolve({ code: 1, signal: null });
        });
      });

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          if (!session.exited) {
            timedOut = true;
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
            // Escalate to SIGKILL after 5s grace period
            setTimeout(() => {
              if (!session.exited) {
                try { child.kill("SIGKILL"); } catch { /* ignore */ }
              }
            }, 5000);
          }
        }, timeoutSec * 1000);
      }

      return new Promise<AgentToolResult<unknown>>((resolve) => {
        let yielded = false;
        let yieldTimer: ReturnType<typeof setTimeout> | null = null;

        const resolveRunning = () => {
          resolve({
            content: [
              {
                type: "text",
                text: `${formatWarnings(warnings)}Command running in background.\nSession ID: ${sessionId}\nPID: ${child.pid}\nUse the process tool with action="poll" sessionId="${sessionId}" to check output.`,
              },
            ],
            details: {
              status: "running",
              sessionId,
              pid: child.pid,
              host,
              security: effectiveSecurity,
              pty: useScriptPty,
              resolvedPath: firstResolvedPath,
              pathDrift,
              obfuscationSignals,
            },
          });
        };

        if (yieldMs === 0) {
          markBackgrounded(session);
          resolveRunning();
        } else {
          yieldTimer = setTimeout(() => {
            if (!session.exited) {
              yielded = true;
              markBackgrounded(session);
              resolveRunning();
            }
          }, yieldMs);
        }

        exitPromise.then(({ code, signal: exitSignal }) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (yieldTimer) clearTimeout(yieldTimer);
          if (updateInterval) clearInterval(updateInterval);

          const status = timedOut || (code === null && exitSignal) ? "killed" : "completed";
          markExited(session, code, exitSignal, status as "completed" | "killed");

          if (yielded || session.backgrounded) return;

          const { stdout, stderr } = drainSession(session);
          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr && code !== 0) parts.push(`STDERR:\n${stderr}`);
          if (timedOut) parts.push("Execution timed out.");
          parts.push(`Exit code: ${code}`);

          resolve({
            content: [
              {
                type: "text",
                text:
                  `${formatWarnings(warnings)}${parts.join("\n").slice(0, 100_000)}` ||
                  `Command completed with exit code ${code}`,
              },
            ],
            details: {
              status,
              exitCode: code,
              sessionId,
              host,
              security: effectiveSecurity,
              pty: useScriptPty,
              resolvedPath: firstResolvedPath,
              pathDrift,
              obfuscationSignals,
            },
          });
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            if (!session.exited && !session.backgrounded) {
              try { child.kill("SIGTERM"); } catch { /* ignore */ }
            }
          });
        }
      });
    },
  };
}
