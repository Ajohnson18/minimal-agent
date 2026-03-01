/**
 * Spawn Subagent Tool
 *
 * Architecture:
 * - No hardcoded types — the agent describes tasks naturally
 * - Agent determines model and timeout per spawn
 * - Flow modes resolve per session (`async` default, `supervisor` opt-in)
 * - Announce modes: full (summary), brief (one-liner), silent (no delivery)
 * - Async non-blocking with status polling
 * - Registry persists with DB-first durability and triggers announce on completion
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { spawnSubagent, type SubagentResult } from "../subagent-executor.js";
import type { UserContext } from "../user-context.js";
import {
  registerRun,
  completeRun,
  failRun,
  timeoutRun,
  killRun,
  killAllForParent,
  listRunsDurable,
  getRun,
  getRunDurable,
  canSpawn,
  formatRunStatus,
  type SubagentRun,
} from "./subagent-registry.js";
import { randomUUID } from "crypto";
import { ToolInputError } from "./common.js";
import { getConfig } from "../../lib/config-loader.js";
import {
  resolveSessionSubagentFlowMode,
  type SubagentFlowMode,
} from "../subagent-flow-mode.js";

const SUBAGENT_MIN_TIMEOUT_SEC = 10;
const SUBAGENT_MAX_TIMEOUT_SEC = 2_147_000; // timer-safe upper bound (~24.8 days)
const DEFAULT_SUBAGENT_TIMEOUT_SEC = Math.max(
  0,
  Math.round(getConfig().subagents.defaultTimeoutMs / 1000),
);
const STEER_ABORT_SETTLE_TIMEOUT_MS = 3000;
const SUPERVISOR_STATUS_UPDATE_MIN_MS = 1_000;

type SupervisorAttemptStatus = "completed" | "failed" | "timeout" | "aborted";

interface SupervisorAttemptResult {
  attempt: number;
  status: SupervisorAttemptStatus;
  durationMs: number;
  sessionId: string;
  sessionKey?: string;
  toolsUsed: string[];
  fullResultPath?: string;
  error?: string;
}

function clampTimeoutSec(timeoutSec: number | undefined): number {
  if (!Number.isFinite(timeoutSec)) return DEFAULT_SUBAGENT_TIMEOUT_SEC;
  const safe = Math.floor(timeoutSec as number);
  if (safe <= 0) return 0;
  if (safe < SUBAGENT_MIN_TIMEOUT_SEC) return SUBAGENT_MIN_TIMEOUT_SEC;
  if (safe > SUBAGENT_MAX_TIMEOUT_SEC) return SUBAGENT_MAX_TIMEOUT_SEC;
  return safe;
}

function isSubagentTimeoutError(error: string | undefined): boolean {
  if (!error) return false;
  const msg = error.toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout");
}

function isSubagentAbortError(error: string | undefined): boolean {
  if (!error) return false;
  return error.toLowerCase().includes("aborted");
}

function toSupervisorAttemptStatus(
  result: SubagentResult,
): SupervisorAttemptStatus {
  if (result.success) return "completed";
  if (isSubagentAbortError(result.error)) return "aborted";
  if (isSubagentTimeoutError(result.error)) return "timeout";
  return "failed";
}

function summarizeSupervisorAttempts(attempts: SupervisorAttemptResult[]): string {
  if (attempts.length === 0) return "No attempts executed.";
  return attempts
    .map((attempt) => {
      const seconds = Math.max(0, Math.round(attempt.durationMs / 1000));
      const errorSuffix =
        attempt.error && attempt.error.trim().length > 0
          ? ` — ${attempt.error.trim()}`
          : "";
      return `${attempt.attempt}. ${attempt.status} (${seconds}s)${errorSuffix}`;
    })
    .join("\n");
}

function emitToolUpdate(
  onUpdate: AgentToolUpdateCallback | undefined,
  text: string,
  details: Record<string, unknown>,
): void {
  if (!onUpdate) return;
  try {
    onUpdate({
      content: [{ type: "text", text }],
      details,
    });
  } catch {
    // Ignore transient update callback failures.
  }
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Subagent aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Subagent aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => !!signal,
  );
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(
      typeof source.reason === "string" ? source.reason : undefined,
    );
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

async function runSupervisorSubagentFlow(options: {
  userId: string;
  sessionId: string;
  currentDepth: number;
  maxDepth: number;
  task: string;
  context?: string;
  mode: "run" | "session";
  cleanup: boolean;
  model?: string;
  timeoutMs: number;
  sandboxContainer?: string;
  flowMode: SubagentFlowMode;
  signal?: AbortSignal;
  userContext?: UserContext;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<
  AgentToolResult<{
    status: string;
    flowMode: SubagentFlowMode;
    depth: number;
    maxDepth: number;
    attempts: number;
    maxAttempts: number;
    totalDurationMs: number;
    timeoutMs: number;
    model: string;
    mode: "run" | "session";
    sessionId?: string;
    childSessionKey?: string;
    fullResultPath?: string;
    toolsUsed?: string[];
    attemptResults: SupervisorAttemptResult[];
    error?: string;
  }>
> {
  const supervisorConfig = getConfig().subagents.orchestration.supervisor;
  const maxAttempts = Math.max(1, supervisorConfig.maxAttempts);
  const baseBackoffMs = Math.max(0, supervisorConfig.baseBackoffMs);
  const maxBackoffMs = Math.max(baseBackoffMs, supervisorConfig.maxBackoffMs);
  const maxWorkflowMs = Math.max(1_000, supervisorConfig.maxWorkflowMs);
  const statusUpdateMs = Math.max(
    SUPERVISOR_STATUS_UPDATE_MIN_MS,
    supervisorConfig.statusUpdateMs,
  );

  const startedAt = Date.now();
  const workflowDeadlineMs = startedAt + maxWorkflowMs;
  const attemptResults: SupervisorAttemptResult[] = [];
  const childSessionId = randomUUID();
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      lastError = "Subagent aborted.";
      break;
    }

    const now = Date.now();
    const remainingWorkflowMs = workflowDeadlineMs - now;
    if (remainingWorkflowMs <= 0) {
      lastError = `Supervisor workflow timed out after ${Math.round(maxWorkflowMs / 1000)}s before completion.`;
      break;
    }

    emitToolUpdate(
      options.onUpdate,
      `Supervisor attempt ${attempt}/${maxAttempts} started.`,
      {
        status: "running",
        orchestration: "supervisor",
        attempt,
        maxAttempts,
      },
    );

    const effectiveTimeoutMs =
      options.timeoutMs > 0
        ? Math.min(options.timeoutMs, remainingWorkflowMs)
        : remainingWorkflowMs;

    const attemptStart = Date.now();
    let statusTimer: ReturnType<typeof setInterval> | null = null;
    if (options.onUpdate) {
      statusTimer = setInterval(() => {
        const elapsedMs = Date.now() - attemptStart;
        emitToolUpdate(
          options.onUpdate,
          `Supervisor attempt ${attempt}/${maxAttempts} running (${Math.round(elapsedMs / 1000)}s elapsed).`,
          {
            status: "running",
            orchestration: "supervisor",
            attempt,
            maxAttempts,
            elapsedMs,
          },
        );
      }, statusUpdateMs);
      statusTimer.unref?.();
    }

    let result: SubagentResult;
    try {
      result = await spawnSubagent({
        task: options.task,
        parentSessionId: options.sessionId,
        userId: options.userId,
        currentDepth: options.currentDepth,
        context: options.context,
        mode: options.mode,
        cleanup: options.cleanup,
        modelId: options.model,
        timeoutMs: effectiveTimeoutMs,
        sessionId: childSessionId,
        label: options.task.slice(0, 50),
        sandboxContainer: options.sandboxContainer,
        announceMode: "silent",
        abortSignal: options.signal,
        parentUserContext: options.userContext,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        success: false,
        content: "",
        toolsUsed: [],
        error: message,
        sessionId: childSessionId,
        durationMs: Date.now() - attemptStart,
      };
    } finally {
      if (statusTimer) {
        clearInterval(statusTimer);
      }
    }

    const attemptStatus = toSupervisorAttemptStatus(result);
    const attemptResult: SupervisorAttemptResult = {
      attempt,
      status: attemptStatus,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      ...(result.sessionKey ? { sessionKey: result.sessionKey } : {}),
      toolsUsed: result.toolsUsed,
      ...(result.fullResultPath ? { fullResultPath: result.fullResultPath } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    attemptResults.push(attemptResult);

    if (result.success) {
      const totalDurationMs = Date.now() - startedAt;
      return {
        content: [
          {
            type: "text",
            text: [
              "Subagent completed under supervisor orchestration.",
              `Attempts used: ${attempt}/${maxAttempts}`,
              `Session ID: ${result.sessionId}`,
              result.sessionKey ? `Session Key: ${result.sessionKey}` : undefined,
              result.fullResultPath ? `Full Result Path: ${result.fullResultPath}` : undefined,
              `Tools used: ${result.toolsUsed.length > 0 ? result.toolsUsed.join(", ") : "none"}`,
              "",
              "Result:",
              result.content,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
          },
        ],
        details: {
          status: "completed",
          flowMode: options.flowMode,
          depth: options.currentDepth,
          maxDepth: options.maxDepth,
          attempts: attempt,
          maxAttempts,
          totalDurationMs,
          timeoutMs: options.timeoutMs,
          model: options.model || "default",
          mode: options.mode,
          sessionId: result.sessionId,
          childSessionKey: result.sessionKey,
          fullResultPath: result.fullResultPath,
          toolsUsed: result.toolsUsed,
          attemptResults,
        },
      };
    }

    lastError = result.error || "Unknown subagent failure";
    if (attemptStatus === "aborted") {
      break;
    }

    if (attempt >= maxAttempts) {
      break;
    }

    const backoffMs = Math.min(
      baseBackoffMs * 2 ** Math.max(0, attempt - 1),
      maxBackoffMs,
    );
    const remainingAfterAttemptMs = workflowDeadlineMs - Date.now();
    if (remainingAfterAttemptMs <= 0) {
      lastError = `Supervisor workflow timed out after ${Math.round(maxWorkflowMs / 1000)}s before completion.`;
      break;
    }
    const sleepMs = Math.min(backoffMs, remainingAfterAttemptMs);
    emitToolUpdate(
      options.onUpdate,
      `Supervisor retrying in ${Math.round(sleepMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts}).`,
      {
        status: "retrying",
        orchestration: "supervisor",
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        backoffMs: sleepMs,
        lastError,
      },
    );
    try {
      await waitWithAbort(sleepMs, options.signal);
    } catch {
      lastError = "Subagent aborted.";
      break;
    }
  }

  const totalDurationMs = Date.now() - startedAt;
  const attemptsUsed = attemptResults.length;
  const aborted = options.signal?.aborted || isSubagentAbortError(lastError);
  const errorText =
    lastError ||
    (aborted
      ? "Subagent aborted."
      : `Subagent failed after ${attemptsUsed}/${maxAttempts} attempts.`);
  return {
    content: [
      {
        type: "text",
        text: [
          "Subagent failed under supervisor orchestration.",
          `Attempts used: ${attemptsUsed}/${maxAttempts}`,
          `Last error: ${errorText}`,
          "",
          "Attempt history:",
          summarizeSupervisorAttempts(attemptResults),
        ].join("\n"),
      },
    ],
    details: {
      status: aborted ? "aborted" : "failed",
      flowMode: options.flowMode,
      depth: options.currentDepth,
      maxDepth: options.maxDepth,
      attempts: attemptsUsed,
      maxAttempts,
      totalDurationMs,
      timeoutMs: options.timeoutMs,
      model: options.model || "default",
      mode: options.mode,
      sessionId: attemptResults.at(-1)?.sessionId,
      childSessionKey: attemptResults.at(-1)?.sessionKey,
      fullResultPath: attemptResults.at(-1)?.fullResultPath,
      toolsUsed: attemptResults.at(-1)?.toolsUsed,
      attemptResults,
      error: errorText,
    },
  };
}

/**
 * Create the spawn_subagent tool with session context.
 *
 * Results are announced via direct delivery:
 * 1. Subagent completes → self-summary step in subagent session
 * 2. Registry triggers announce using effective flow + announce policy
 * 3. Compact system event queued for parent context on next turn
 */
export function createSpawnSubagentTool(options: {
  userId: string;
  sessionId: string;
  /** External ID of the parent session for announce routing (e.g. "slack:C123:1234.5678") */
  externalId?: string;
  /** Sandbox container inherited from parent session */
  sandboxContainer?: string;
  /** Session source for parity guard behavior */
  sessionSource?: string | null;
  /** Current subagent depth for nested-spawn guard propagation. */
  currentDepth?: number;
  /** Delivery context inherited from parent (for nested subagents) */
  deliveryContext?: {
    externalId: string;
  };
  /** Pre-resolved user context passed down to subagents */
  userContext?: UserContext;
  onResult?: (runId: string, result: SubagentRun) => void;
}): ToolDefinition {
  const { userId, sessionId, onResult } = options;
  const spawnDepth = Math.max(0, options.currentDepth ?? 0);
  const configuredMaxDepth = Number(getConfig().subagents.maxDepth);
  const maxDepth = Number.isFinite(configuredMaxDepth)
    ? Math.max(1, Math.floor(configuredMaxDepth))
    : 1;

  return {
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: `Delegate a task to a specialized subagent that runs in isolation with full tool access.

Use this when:
- You need to explore or research a part of the codebase
- A task is complex enough to benefit from isolated focus
- You want parallel investigation of multiple areas
- You need to delegate coding or analysis tasks

Subagents have access to standard coding tools (read, write, edit, bash, grep, find, ls).
Research and analyze subagents are read-only (no write/edit capabilities).

Note: Subagents can spawn their own subagents (max depth: 2, max children per agent: 5).

Actions:
- spawn (default): Launch a new subagent. In async flow it returns immediately; in supervisor flow it waits and returns child results directly.
- list: Show running and completed subagents for this session.
- status: Check status of a specific subagent by ID.
- steer: Send guidance message to a running subagent (mid-execution redirection).
- kill: Stop a running subagent (cascades to its children).
- kill_all: Stop all running subagents for this session.`,
    parameters: Type.Object({
      action: Type.Optional(Type.String({
        description: 'Action: "spawn" (default), "list", "status", "steer", "kill", "kill_all"',
      })),
      task: Type.Optional(Type.String({
        description: 'Clear description of what the subagent should accomplish (required for spawn)',
      })),
      context: Type.Optional(Type.String({
        description: 'Optional context to pass to subagent (relevant file paths, previous findings, constraints, etc.)',
      })),
      mode: Type.Optional(Type.String({
        description: 'Execution mode: "run" (default) for task execution, or "session" to keep the child session durable',
      })),
      timeout: Type.Optional(Type.Number({
        description: `Timeout in seconds for the subagent (default: ${DEFAULT_SUBAGENT_TIMEOUT_SEC}; 0 disables timeout)`,
        minimum: 0,
        maximum: SUBAGENT_MAX_TIMEOUT_SEC,
      })),
      model: Type.Optional(Type.String({
        description: 'Optional model override for the subagent (e.g. \'gemini-2.0-flash\')',
      })),
      run_id: Type.Optional(Type.String({
        description: 'Subagent run ID (for status/steer/kill actions)',
      })),
      steer_message: Type.Optional(Type.String({
        description: 'Guidance message to send to running subagent (for steer action)',
      })),
      keep_session: Type.Optional(Type.Boolean({
        description: 'If true, keep the subagent session for later inspection (default: false, sessions are cleaned up)',
      })),
      delivery: Type.Optional(
        Type.Object({
          announce: Type.Optional(
            Type.String({
              description:
                'How to report results: "full" (concise summary, default), "brief" (one-liner), "silent" (no user message)',
            }),
          ),
        }),
      ),
      announce: Type.Optional(
        Type.String({
          description:
            'Deprecated alias for delivery.announce; use delivery.announce instead',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action?: string;
        task?: string;
        context?: string;
        mode?: string;
        timeout?: number;
        model?: string;
        run_id?: string;
        steer_message?: string;
        keep_session?: boolean;
        delivery?: {
          announce?: string;
        };
        announce?: string;
      },
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const action = params.action || 'spawn';

      // Check abort signal before executing (except for read-only operations)
      if (signal?.aborted && action !== 'list' && action !== 'status' && action !== 'kill' && action !== 'kill_all') {
        const abortDetails: Record<string, unknown> = {
          aborted: true,
          status: "aborted",
          action,
        };
        if (action === "spawn") {
          try {
            abortDetails.flowMode = await resolveSessionSubagentFlowMode(sessionId);
          } catch {
            // Keep abort handling resilient even if flow-mode resolution fails.
          }
        }
        return {
          content: [{ type: "text", text: "Subagent operation aborted" }],
          details: abortDetails,
        };
      }

      // --- List ---
      if (action === 'list') {
        const { running, completed } = await listRunsDurable(sessionId);
        const sections: string[] = [];

        if (running.length === 0 && completed.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent runs found for this session." }],
            details: { running: 0, completed: 0 },
          };
        }

        if (running.length > 0) {
          sections.push(`## Running (${running.length})\n\n${running.map(formatRunStatus).join('\n\n')}`);
        }
        if (completed.length > 0) {
          sections.push(`## Completed (${completed.length})\n\n${completed.map(r => {
            const status = formatRunStatus(r);
            const result = r.result ? `\n\n**Result:**\n${r.result.slice(0, 2000)}${r.result.length > 2000 ? '...' : ''}` : '';
            return status + result;
          }).join('\n\n---\n\n')}`);
        }

        return {
          content: [{ type: "text", text: sections.join('\n\n') }],
          details: { running: running.length, completed: completed.length },
        };
      }

      // --- Status ---
      if (action === 'status') {
        if (!params.run_id) {
          return {
            content: [{ type: "text", text: "Error: run_id is required for status action" }],
            details: { error: "missing_run_id" },
          };
        }
        const run = await getRunDurable(params.run_id);
        if (!run) {
          return {
            content: [{ type: "text", text: `No subagent run found with ID: ${params.run_id}` }],
            details: { error: "not_found" },
          };
        }
        const status = formatRunStatus(run);
        const result = run.result ? `\n\n**Result:**\n${run.result}` : '';
        return {
          content: [{ type: "text", text: status + result }],
          details: {
            status: run.status,
            id: run.id,
            childSessionKey: run.childSessionKey,
            fullResultPath: run.fullResultPath,
            announceDeliveryPhases: run.announceDeliveryPhases,
          },
        };
      }

      // --- Steer ---
      if (action === 'steer') {
        if (!params.run_id) {
          return {
            content: [{ type: "text", text: "Error: run_id is required for steer action" }],
            details: { error: "missing_run_id" },
          };
        }
        if (!params.steer_message) {
          return {
            content: [{ type: "text", text: "Error: steer_message is required for steer action" }],
            details: { error: "missing_steer_message" },
          };
        }

        const message = params.steer_message;
        if (message.length > 4000) {
          throw new ToolInputError("Steer message too long (max 4000 chars)");
        }

        const run = getRun(params.run_id);
        if (!run) {
          return {
            content: [{ type: "text", text: `No subagent run found with ID: ${params.run_id}` }],
            details: { error: "not_found" },
          };
        }

        if (run.status !== 'running') {
          return {
            content: [{ type: "text", text: `Cannot steer ${run.status} subagent` }],
            details: { error: "not_running", status: run.status },
          };
        }
        if (!run.sessionId) {
          return {
            content: [{ type: "text", text: "Cannot steer this subagent yet (session is still initializing)." }],
            details: { error: "session_not_ready" },
          };
        }

        // Rate limiting: max 1 steer every 2 seconds per run
        const lastSteer = steerTimestamps.get(params.run_id) || 0;
        const now = Date.now();
        if (now - lastSteer < 2000) {
          throw new ToolInputError("Steer rate limit: wait 2 seconds between messages");
        }
        steerTimestamps.set(params.run_id, now);

        const previousRunId = params.run_id;
        const reusedSessionId = run.sessionId;
        const mode = run.mode === "session" ? "session" : "run";
        const cleanup = run.cleanup ?? mode !== "session";
        const announceMode = run.announceMode ?? "full";
        const flowMode = run.flowMode ?? "async";
        const task = run.task;
        const type = run.type || "general";
        const depth = run.depth ?? 0;
        const deliveryContext = run.deliveryContext;
        const requesterIsSubagent = run.requesterIsSubagent;
        const metadata = run.metadata;

        const killed = killRun(previousRunId);
        if (!killed) {
          return {
            content: [{ type: "text", text: `Could not steer ${previousRunId}; run is no longer active.` }],
            details: { error: "not_running" },
          };
        }

        if (run.spawnPromise) {
          await Promise.race([
            Promise.resolve(run.spawnPromise).catch(() => undefined),
            new Promise((resolve) =>
              setTimeout(resolve, STEER_ABORT_SETTLE_TIMEOUT_MS),
            ),
          ]);
        }

        const replacementRunId = randomUUID().slice(0, 8);
        const abortController = new AbortController();
        const replacementRun: SubagentRun = {
          id: replacementRunId,
          userId,
          task,
          type,
          parentSessionId: sessionId,
          sessionId: reusedSessionId,
          depth,
          mode,
          cleanup,
          status: "running",
          startedAt: Date.now(),
          toolsUsed: [],
          abortController,
          deliveryContext,
          announceMode,
          requesterIsSubagent,
          flowMode,
          metadata,
          onComplete: onResult
            ? (completedRun) => {
                try {
                  onResult(replacementRunId, completedRun);
                } catch {
                  // ignore callback errors
                }
              }
            : undefined,
        };
        registerRun(replacementRun);

        const timeoutSec = clampTimeoutSec(params.timeout);
        const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
        const spawnPromise = spawnSubagent({
          task,
          parentSessionId: sessionId,
          userId,
          currentDepth: depth,
          context: [
            "[Steer Update from Parent]",
            message,
            "",
            "Continue the assigned task using this updated guidance.",
          ].join("\n"),
          mode,
          cleanup,
          modelId: params.model,
          timeoutMs,
          sessionId: reusedSessionId,
          label: task.slice(0, 50),
          sandboxContainer: options.sandboxContainer,
          announceMode,
          abortSignal: mergeAbortSignals(signal, abortController.signal),
          parentUserContext: options.userContext,
        });
        startBackgroundSubagentRun(replacementRunId, replacementRun, spawnPromise);

        return {
          content: [{
            type: "text",
            text: `Steered subagent ${previousRunId}. Restarted as ${replacementRunId} in the same child session.`,
          }],
          details: {
            steered: true,
            mode: "restart",
            previousRunId,
            runId: replacementRunId,
            sessionId: reusedSessionId,
          },
        };
      }

      // --- Kill ---
      if (action === 'kill') {
        if (!params.run_id) {
          return {
            content: [{ type: "text", text: "Error: run_id is required for kill action" }],
            details: { error: "missing_run_id" },
          };
        }
        const killed = killRun(params.run_id);
        return {
          content: [{ type: "text", text: killed ? `Killed subagent ${params.run_id}` : `Could not kill ${params.run_id} (not running or not found)` }],
          details: { killed },
        };
      }

      // --- Kill All ---
      if (action === 'kill_all') {
        const count = killAllForParent(sessionId);
        return {
          content: [{ type: "text", text: count > 0 ? `Killed ${count} running subagent(s)` : 'No running subagents to kill' }],
          details: { killed: count },
        };
      }

      // --- Spawn ---
      if (!params.task) {
        return {
          content: [{ type: "text", text: "Error: task is required for spawn action" }],
          details: { error: "missing_task" },
        };
      }
      if (spawnDepth >= maxDepth) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot spawn subagent: maximum nesting depth reached (${maxDepth}).`,
            },
          ],
          details: {
            error: "max_depth_reached",
            depth: spawnDepth,
            maxDepth,
          },
        };
      }

      if (!canSpawn()) {
        return {
          content: [{ type: "text", text: "Too many concurrent subagents running. Wait for some to complete or kill existing ones." }],
          details: { error: "concurrency_limit" },
        };
      }

      const runId = randomUUID().slice(0, 8);
      const timeoutSec = clampTimeoutSec(params.timeout);
      const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
      const mode = params.mode === "session" ? "session" : "run";
      const keepSession = params.keep_session ?? mode === "session";
      const abortController = new AbortController();
      const childSessionId = randomUUID();

      const announceInput = params.delivery?.announce ?? params.announce;
      const announceMode = (['full', 'brief', 'silent'].includes(announceInput || '')
        ? announceInput as 'full' | 'brief' | 'silent'
        : 'full');
      const flowMode = await resolveSessionSubagentFlowMode(sessionId);
      const effectiveDeliveryContext = options.externalId 
        ? { externalId: options.externalId }
        : options.deliveryContext;

      if (flowMode === "supervisor") {
        return runSupervisorSubagentFlow({
          userId,
          sessionId,
          currentDepth: spawnDepth,
          maxDepth,
          task: params.task,
          context: params.context,
          mode,
          cleanup: !keepSession,
          model: params.model,
          timeoutMs,
          sandboxContainer: options.sandboxContainer,
          flowMode,
          signal,
          onUpdate,
          userContext: options.userContext,
        });
      }

      const run: SubagentRun = {
        id: runId,
        userId,
        task: params.task,
        type: "general",
        parentSessionId: sessionId,
        sessionId: childSessionId,
        depth: spawnDepth,
        mode,
        cleanup: !keepSession,
        status: 'running',
        startedAt: Date.now(),
        toolsUsed: [],
        abortController,
        deliveryContext: effectiveDeliveryContext,
        announceMode,
        requesterIsSubagent: (options.sessionSource || "").trim().toLowerCase() === "subagent",
        flowMode,
        metadata: {
          flowMode,
        },
        onComplete: onResult
          ? (completedRun) => { try { onResult(runId, completedRun); } catch { /* ignore */ } }
          : undefined,
      };
      registerRun(run);

      // Fire and forget — run in background
      const spawnPromise = spawnSubagent({
        task: params.task,
        parentSessionId: sessionId,
        userId,
        currentDepth: spawnDepth,
        context: params.context,
        mode,
        cleanup: !keepSession,
        modelId: params.model,
        timeoutMs,
        sessionId: childSessionId,
        label: params.task.slice(0, 50),
        sandboxContainer: options.sandboxContainer,
        announceMode,
        abortSignal: mergeAbortSignals(signal, abortController.signal),
        deliveryContext: effectiveDeliveryContext,
        parentUserContext: options.userContext,
      });
      startBackgroundSubagentRun(runId, run, spawnPromise);

      // Return immediately
      return {
        content: [{
          type: "text",
          text: [
            `Subagent spawned (async).`,
            `**Run ID:** ${runId}`,
            `**Task:** ${params.task.slice(0, 100)}${params.task.length > 100 ? '...' : ''}`,
            `**Model:** ${params.model || 'default'}`,
            `**Mode:** ${mode}`,
            `**Flow:** ${flowMode}`,
            `**Delivery:** ${announceMode}`,
            `**Timeout:** ${timeoutSec > 0 ? `${timeoutSec}s` : "none"}`,
            '',
            'The result will be announced when the subagent finishes.',
            'Use `spawn_subagent` with `action: "list"` or `action: "status"` + `run_id` to check progress.',
          ].join("\n"),
        }],
        details: {
          status: "accepted",
          runId,
          depth: spawnDepth,
          maxDepth,
          timeout: timeoutSec,
          model: params.model || 'default',
          mode,
          flowMode,
          delivery: announceMode,
          childSessionId,
          childSessionKey: undefined,
          fullResultPath: undefined,
        },
      };
    },
  };
}

// --- Steer helper functions ---

/** Track steer timestamps for rate limiting */
const steerTimestamps = new Map<string, number>();

function startBackgroundSubagentRun(
  runId: string,
  run: SubagentRun,
  spawnPromise: ReturnType<typeof spawnSubagent>,
): void {
  run.spawnPromise = spawnPromise;
  spawnPromise
    .then((result) => {
      const currentRun = getRun(runId);
      if (!currentRun || currentRun.status !== "running") return;
      if (result.sessionId && !currentRun.sessionId) {
        currentRun.sessionId = result.sessionId;
      }

      if (result.success) {
        completeRun(runId, result.content, result.toolsUsed, result.announceSummary, {
          sessionKey: result.sessionKey,
          fullResultPath: result.fullResultPath,
        });
      } else {
        const errorMessage = result.error || "Unknown error";
        if (isSubagentTimeoutError(errorMessage)) {
          timeoutRun(runId, {
            sessionKey: result.sessionKey,
            fullResultPath: result.fullResultPath,
          });
        } else {
          failRun(runId, errorMessage, {
            sessionKey: result.sessionKey,
            fullResultPath: result.fullResultPath,
          });
        }
      }
    })
    .catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (isSubagentTimeoutError(msg)) {
        timeoutRun(runId);
      } else {
        failRun(runId, msg);
      }
    });
}

export const __testing = {
  clampTimeoutSec,
  isSubagentTimeoutError,
  DEFAULT_SUBAGENT_TIMEOUT_SEC,
  SUBAGENT_MIN_TIMEOUT_SEC,
  SUBAGENT_MAX_TIMEOUT_SEC,
};
