/**
 * Subagent Executor
 *
 * Spawns isolated subagents for delegated tasks.
 *
 * Architecture:
 * - No hardcoded subagent types — the agent describes tasks naturally
 * - Agent determines model and timeout per spawn
 * - Results (success or failure) route back to the parent agent, not to Slack
 * - Nested sub-agents with configurable depth (default max: 2, configurable via SUBAGENT_MAX_DEPTH)
 * - Per-parent child limit (default: 5, configurable via SUBAGENT_MAX_CHILDREN)
 */
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { db } from "../db/client.js";
import { avaSessions, avaMessages } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  AuthStorage,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  getPiModel,
  getDefaultProvider,
  getDefaultModelId,
  getModelContextWindow,
} from "./pi-provider.js";
import { getBuiltInTools, createCustomTools } from "./pi-converter.js";
import { resolveUserContext } from "./user-context.js";
import { createLogger } from "../lib/logger.js";
import { startTrace } from "../services/tracing.service.js";
import { getConfig } from "../lib/config-loader.js";
import type { AnnounceMode } from "./tools/subagent-registry.js";
import {
  pruneContext,
  DEFAULT_PRUNING_CONFIG,
  estimateTotalTokens,
} from "./context-pruning.js";
import { buildSessionKey } from "../core/session-key.js";
import { runHookPhase } from "../hooks/index.js";
import { sessionKeyResolverService } from "../services/session-key-resolver.service.js";

// --- Nesting configuration (from config.json) ---
const subCfg = getConfig().subagents;
const MAX_SPAWN_DEPTH = subCfg.maxDepth;
const MAX_CHILDREN_PER_AGENT = subCfg.maxChildren;
const MIN_SUBAGENT_TIMEOUT_MS = 10_000;
const MAX_SUBAGENT_TIMEOUT_MS = 2_147_000_000;
function normalizeSubagentTimeoutMs(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return 0;
  const safe = Math.floor(timeoutMs as number);
  if (safe <= 0) return 0;
  if (safe < MIN_SUBAGENT_TIMEOUT_MS) return MIN_SUBAGENT_TIMEOUT_MS;
  if (safe > MAX_SUBAGENT_TIMEOUT_MS) return MAX_SUBAGENT_TIMEOUT_MS;
  return safe;
}
const DEFAULT_TIMEOUT_MS = normalizeSubagentTimeoutMs(subCfg.defaultTimeoutMs);
const DEFAULT_MODEL = subCfg.defaultModel;
const EMPTY_SUBAGENT_OUTPUT_ERROR =
  "empty-subagent-output: Subagent completed tool execution but returned no assistant response.";

/** Track children count per parent session to enforce limits */
const childrenCount = new Map<string, number>();
const MAX_CHILDREN_MAP_SIZE = 500;

function getChildCount(parentId: string): number {
  return childrenCount.get(parentId) || 0;
}

function incrementChildCount(parentId: string): void {
  if (childrenCount.size > MAX_CHILDREN_MAP_SIZE) {
    for (const [id, count] of childrenCount) {
      if (count <= 0) childrenCount.delete(id);
    }
  }
  childrenCount.set(parentId, getChildCount(parentId) + 1);
}

function decrementChildCount(parentId: string): void {
  const count = getChildCount(parentId);
  if (count <= 1) {
    childrenCount.delete(parentId);
  } else {
    childrenCount.set(parentId, count - 1);
  }
}

export interface SpawnSubagentOptions {
  /** The task for the subagent to complete */
  task: string;
  /** Parent session ID (for tracking and result routing) */
  parentSessionId: string;
  /** User ID (for memory access) */
  userId: string;
  /** Optional context to pass to subagent */
  context?: string;
  /** Subagent execution mode */
  mode?: "run" | "session";
  /** Whether to delete session after completion (default: true) */
  cleanup?: boolean;
  /** Model override (default: env SUBAGENT_DEFAULT_MODEL or parent's model) */
  modelId?: string;
  /** Timeout in ms (default from SUBAGENT_DEFAULT_TIMEOUT_MS, clamped) */
  timeoutMs?: number;
  /** Optional fixed child session id (used for steer restart semantics). */
  sessionId?: string;
  /** Optional label for display */
  label?: string;
  /** Sandbox container name inherited from parent (subagent runs in same container) */
  sandboxContainer?: string;
  /** Current depth in the subagent chain (0 = top-level agent) */
  currentDepth?: number;
  /** Controls how results are announced to the user */
  announceMode?: AnnounceMode;
  /** Optional cancellation signal from parent registry/run controller */
  abortSignal?: AbortSignal;
  /** Channel delivery context for announce routing (inherited from parent) */
  deliveryContext?: {
    externalId: string;
  };
  /** Pre-resolved user context from parent (avoids redundant DB fetch) */
  parentUserContext?: import("./user-context.js").UserContext;
}

export interface SubagentResult {
  success: boolean;
  content: string;
  toolsUsed: string[];
  error?: string;
  sessionId: string;
  /** Durable session key for this subagent run. */
  sessionKey?: string;
  durationMs: number;
  /** Self-generated summary from the subagent's announce step */
  announceSummary?: string;
  /** Scratch artifact path containing full run output and metadata. */
  fullResultPath?: string;
}

interface FinalizationSession {
  messages: unknown[];
  prompt: (prompt: string) => Promise<unknown>;
}

const DEFAULT_SUBAGENT_RESULTS_DIR = path.resolve(
  process.cwd(),
  ".scratch",
  "subagent-results",
);

function resolveSubagentResultsDir(): string {
  const configured = process.env.AVA_SUBAGENT_RESULTS_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_SUBAGENT_RESULTS_DIR;
}

function timestampForFilename(value: number): string {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

async function persistSubagentResultArtifact(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  parentSessionId: string;
  task: string;
  content: string;
  announceSummary?: string;
  toolsUsed: string[];
  startedAt: number;
  endedAt: number;
  status: "completed" | "failed" | "timeout" | "aborted";
  error?: string;
}): Promise<string | undefined> {
  const dir = resolveSubagentResultsDir();
  const fileName = `${timestampForFilename(params.endedAt)}-${params.runId}.md`;
  const filePath = path.join(dir, fileName);
  const lines = [
    `# Subagent Result ${params.runId}`,
    "",
    `- Status: ${params.status}`,
    `- Session ID: ${params.sessionId}`,
    `- Session Key: ${params.sessionKey}`,
    `- Parent Session ID: ${params.parentSessionId}`,
    `- Started At: ${new Date(params.startedAt).toISOString()}`,
    `- Ended At: ${new Date(params.endedAt).toISOString()}`,
    `- Duration Ms: ${Math.max(0, params.endedAt - params.startedAt)}`,
    params.toolsUsed.length > 0
      ? `- Tools Used: ${params.toolsUsed.join(", ")}`
      : "- Tools Used: (none)",
    "",
    "## Task",
    params.task || "(empty)",
    "",
    "## Summary",
    params.announceSummary?.trim() || "(not provided)",
    "",
    "## Full Result",
    params.content || "(empty)",
    params.error
      ? ["", "## Error", params.error]
      : [],
  ]
    .flat()
    .join("\n");

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, lines, "utf8");
    return filePath;
  } catch (error) {
    createLogger("subagent").warn(
      { err: error, runId: params.runId, filePath },
      "Failed to persist subagent artifact",
    );
    return undefined;
  }
}

/**
 * Spawn a subagent to handle a delegated task.
 *
 * The subagent gets the same tool set as the main agent (read, write, edit, bash, etc.)
 * plus the ability to spawn its own children if depth allows.
 * Results route back to the parent — never directly to the user.
 */
export async function spawnSubagent(
  options: SpawnSubagentOptions,
): Promise<SubagentResult> {
  const {
    task,
    parentSessionId,
    userId,
    context,
    mode = "run",
    cleanup = true,
    modelId,
    timeoutMs: requestedTimeoutMs,
    sessionId: requestedSessionId,
    label,
    sandboxContainer,
    currentDepth = 0,
    announceMode,
    abortSignal,
    parentUserContext,
  } = options;
  const timeoutMs = normalizeSubagentTimeoutMs(
    requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const startTime = Date.now();

  if (abortSignal?.aborted) {
    return {
      success: false,
      content: "",
      toolsUsed: [],
      error: "Subagent aborted before execution started.",
      sessionId: "",
      durationMs: 0,
    };
  }

  // Enforce depth limit
  if (currentDepth >= MAX_SPAWN_DEPTH) {
    return {
      success: false,
      content: "",
      toolsUsed: [],
      error: `Maximum subagent nesting depth reached (${MAX_SPAWN_DEPTH}). Cannot spawn deeper.`,
      sessionId: "",
      durationMs: 0,
    };
  }

  // Enforce per-parent children limit
  if (getChildCount(parentSessionId) >= MAX_CHILDREN_PER_AGENT) {
    return {
      success: false,
      content: "",
      toolsUsed: [],
      error: `Parent has reached maximum children limit (${MAX_CHILDREN_PER_AGENT}). Wait for existing subagents to complete.`,
      sessionId: "",
      durationMs: 0,
    };
  }

  incrementChildCount(parentSessionId);

  const sessionId = requestedSessionId || randomUUID();
  const displayLabel = label || task.slice(0, 50);

  // Explicit model selection only (no keyword inference).
  let resolvedModel = modelId || DEFAULT_MODEL;
  if (!resolvedModel) {
    resolvedModel = getDefaultModelId();
  }

  const slog = createLogger("subagent", {
    sessionId,
    parentSessionId,
    depth: currentDepth,
    model: resolvedModel,
  });
  slog.info({ task: task.slice(0, 200), timeoutMs }, "Spawning subagent");

  const trace = startTrace({
    name: "subagent-run",
    sessionId,
    userId,
    input: task.slice(0, 500),
    metadata: {
      depth: currentDepth,
      parentSessionId,
      label: displayLabel,
      model: resolvedModel,
    },
  });

  const toolsUsed: string[] = [];
  const subagentSessionKey = buildSessionKey({
    scope: "main",
    channel: "subagent",
    conversationId: parentSessionId.slice(0, 12),
    threadId: sessionId.slice(0, 8),
  });
  const parentIdentity =
    await sessionKeyResolverService.resolveBySessionId(parentSessionId);
  const parentSessionKey = parentIdentity?.sessionKey;
  const hookSpawnInput = {
    parentSessionId,
    ...(parentSessionKey ? { parentSessionKey } : {}),
    childSessionId: sessionId,
    childSessionKey: subagentSessionKey,
    mode,
  };
  let lifecycleOutcome = "failed";

  try {
    await runHookPhase("subagent_spawning", hookSpawnInput);

    // 1. Create (or refresh) subagent session in database.
    const [existingSession] = await db
      .select({ id: avaSessions.id })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);

    if (existingSession) {
      await db
        .update(avaSessions)
        .set({
          sessionKey: subagentSessionKey,
          source: "subagent",
          status: "active",
          lifecycleState: "active",
          archivedAt: null,
          deletedAt: null,
          archivedByReason: null,
          updatedAt: new Date(),
          metadata: {
            parentSessionId,
            cleanup,
            label: displayLabel,
          },
        })
        .where(eq(avaSessions.id, sessionId));
    } else {
      await db.insert(avaSessions).values({
        id: sessionId,
        sessionKey: subagentSessionKey,
        agentId: "main",
        scope: "subagent",
        userId,
        title: `Subagent: ${displayLabel}${displayLabel.length < task.length ? "..." : ""}`,
        source: "subagent",
        status: "active",
        metadata: {
          parentSessionId,
          cleanup,
          label: displayLabel,
        },
      });
    }
    await runHookPhase("subagent_spawned", hookSpawnInput);

    const userContext = parentUserContext ?? await resolveUserContext("web", userId);

    // 2. Build system prompt — minimal, task-focused (includes available credential env vars)
    const credentialKeys = (userContext.credentials?.custom ?? []).map((c) => c.key.toUpperCase());
    const systemPrompt = buildSubagentSystemPrompt(currentDepth, credentialKeys);

    // 3. Build user message
    const userMessage = buildSubagentPrompt(task, context);

    // 4. Get model
    const model = getPiModel(getDefaultProvider(), resolvedModel);

    // 5. Get tools — subagents get the SAME tools as the parent agent
    //    (minus schedule/session_status/sessions; nested spawn stays async via shared spawn_subagent tool)
    const nextDepth = currentDepth + 1;

    // Get all parent custom tools, then filter out ones that don't apply
    const EXCLUDED_SUBAGENT_TOOLS = new Set([
      "schedule",
      "session_status",
      "sessions",
      "get_current_time",
      "get_session_info",
    ]);
    const parentCustomTools = createCustomTools({
      userId,
      sessionId,
      userContext,
      sandboxContainer,
      sessionSource: "subagent",
      subagentDepth: nextDepth,
      deliveryContext: options.deliveryContext,
    }).filter((t) => !EXCLUDED_SUBAGENT_TOOLS.has(t.name));

    // Add subagent-specific utility tools.
    const subagentSpecificTools = createSubagentCustomTools({
      userId,
      sessionId,
      currentDepth: nextDepth,
    });

    const subagentCustomTools = [
      ...parentCustomTools,
      ...subagentSpecificTools,
    ];

    // 6. Create session manager and settings (in-memory)
    const effectiveCwd = sandboxContainer
      ? getConfig().sandbox.workdir || "/workspace"
      : process.cwd();
    const sessionManager = SessionManager.inMemory(effectiveCwd);
    const settingsManager = SettingsManager.inMemory();

    // 7. Create resource loader with subagent system prompt
    const resourceLoader = new DefaultResourceLoader({
      cwd: effectiveCwd,
      settingsManager,
      systemPromptOverride: () => systemPrompt,
    });
    await resourceLoader.reload();

    // 7b. Auth storage — fixes "No API key found" for Vertex Claude
    const authStorage = new AuthStorage();
    if (model.provider === "google-vertex-claude") {
      authStorage.setRuntimeApiKey(
        "google-vertex-claude",
        "vertex-sa-credentials",
      );
    }

    // 8. Create agent session — inherit sandbox from parent
    //    When sandboxed, add Docker-backed tools as custom tools to override base tools.
    const sandboxBuiltInTools = sandboxContainer
      ? getBuiltInTools({ cwd: effectiveCwd, sandboxContainer })
      : undefined;
    const effectiveSubagentCustomTools = sandboxBuiltInTools
      ? [
          ...(sandboxBuiltInTools as unknown as ToolDefinition[]),
          ...subagentCustomTools,
        ]
      : subagentCustomTools;
    const { session } = await createAgentSession({
      cwd: effectiveCwd,
      model,
      ...(sandboxBuiltInTools ? { tools: sandboxBuiltInTools } : {}),
      customTools: effectiveSubagentCustomTools,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage,
    });

    // 9. Track tool usage + preemptive context overflow guard
    const contextWindow = getModelContextWindow(
      getDefaultProvider(),
      resolvedModel,
    );
    const subagentPruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      softTrimRatio: 0.2,
      hardClearRatio: 0.35,
      keepLastAssistants: 2,
      softTrim: { maxChars: 4_000, headChars: 1_500, tailChars: 1_000 },
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        slog.info(
          {
            tool: event.toolName,
            argsPreview: serializePreview(event.args),
          },
          "Subagent tool start",
        );
        return;
      }

      if (event.type === "tool_execution_end") {
        slog.info(
          {
            tool: event.toolName,
            resultPreview: serializePreview(event.result),
          },
          "Subagent tool end",
        );
        if (!toolsUsed.includes(event.toolName)) {
          toolsUsed.push(event.toolName);
        }
        // Preemptive context guard: prune after each tool result to avoid overflow
        const msgs = session.messages as any[];
        const estimatedTokens = estimateTotalTokens(msgs);
        if (estimatedTokens > contextWindow * 0.6) {
          const { messages: pruned, charsRemoved } = pruneContext(
            msgs,
            contextWindow,
            subagentPruningConfig,
          );
          if (charsRemoved > 0) {
            slog.debug(
              { charsRemoved, estimatedTokens },
              "Subagent context pruned preemptively",
            );
            // Replace messages in-place via session manager
            while (msgs.length > 0) msgs.pop();
            for (const m of pruned) msgs.push(m);
          }
        }
      }
    });

    // 10. Execute with timeout/abort
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise =
      timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(
                new Error(`Subagent timeout after ${Math.round(timeoutMs / 1000)}s`),
              );
            }, timeoutMs);
            timeoutHandle.unref?.();
          })
        : null;

    let removeAbortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (!abortSignal) {
        return;
      }
      if (abortSignal.aborted) {
        reject(new Error("Subagent aborted"));
        return;
      }
      const onAbort = () => reject(new Error("Subagent aborted"));
      abortSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        abortSignal.removeEventListener("abort", onAbort);
      };
    });

    let announceSummary: string | undefined;
    let content = "";
    let fullResultPath: string | undefined;

    try {
      const races: Promise<unknown>[] = [session.prompt(userMessage), abortPromise];
      if (timeoutPromise) {
        races.push(timeoutPromise);
      }
      await Promise.race(races);

      // 11. Extract task result while session is still live (before summary step or dispose)
      content = await resolveFinalSubagentContent(session);

      // 12. Self-summary step: ask the subagent to summarize its work
      if (announceMode && announceMode !== "silent") {
        try {
          const summaryPrompt = buildSelfSummaryPrompt({
            mode: announceMode,
            fullResult: content,
          });
          await session.prompt(summaryPrompt);
          announceSummary = extractLastAssistantText(session.messages);
          if (announceSummary) {
            announceSummary = announceSummary.trim();
          }
        } catch {
          slog.warn(
            "Announce summary step failed — falling back to full result",
          );
          if (content) {
            announceSummary = content.trim();
          }
        }
      }

      fullResultPath = await persistSubagentResultArtifact({
        runId: sessionId,
        sessionId,
        sessionKey: subagentSessionKey,
        parentSessionId,
        task,
        content,
        announceSummary,
        toolsUsed,
        startedAt: startTime,
        endedAt: Date.now(),
        status: "completed",
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      removeAbortListener?.();
      unsubscribe();
      session.dispose();
    }

    const durationMs = Date.now() - startTime;
    slog.info(
      {
        toolsUsed,
        durationMs,
        contentLength: content.length,
        hasAnnounceSummary: !!announceSummary,
      },
      "Subagent completed",
    );
    trace.update({
      output: content.slice(0, 500),
      statusMessage: "completed",
      metadata: { toolsUsed, durationMs },
    });

    if (cleanup) {
      await cleanupSubagentSession(sessionId);
    }

    decrementChildCount(parentSessionId);
    lifecycleOutcome = "completed";

    return {
      success: true,
      content,
      toolsUsed,
      sessionId,
      sessionKey: subagentSessionKey,
      durationMs,
      announceSummary,
      fullResultPath,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout =
      errorMessage.includes("timeout") || errorMessage.includes("Timeout");
    const isAborted = errorMessage.toLowerCase().includes("aborted");
    const endedAt = Date.now();
    const fullResultPath = await persistSubagentResultArtifact({
      runId: sessionId,
      sessionId,
      sessionKey: subagentSessionKey,
      parentSessionId,
      task,
      content: "",
      toolsUsed,
      startedAt: startTime,
      endedAt,
      status: isTimeout ? "timeout" : isAborted ? "aborted" : "failed",
      error: errorMessage,
    });
    slog.error({ err: error, durationMs }, "Subagent failed");
    trace.update({
      statusMessage: "error",
      metadata: { error: errorMessage, durationMs },
    });

    decrementChildCount(parentSessionId);

    if (cleanup) {
      await cleanupSubagentSession(sessionId).catch((e) => {
        slog.error({ err: e }, "Failed to cleanup subagent session");
      });
    }

    lifecycleOutcome = isTimeout ? "timeout" : isAborted ? "aborted" : "failed";
    const finalError = isTimeout
      ? `Subagent timed out after ${Math.round(timeoutMs / 1000)}s before completing.`
      : isAborted
        ? "Subagent aborted."
        : errorMessage;

    return {
      success: false,
      content: "",
      toolsUsed,
      error: finalError,
      sessionId,
      sessionKey: subagentSessionKey,
      durationMs,
      fullResultPath,
    };
  } finally {
    await runHookPhase("subagent_ended", {
      ...hookSpawnInput,
      outcome: lifecycleOutcome,
    });
  }
}

/**
 * Create custom tools for subagent.
 * Utilities only — nested spawn_subagent comes from shared createCustomTools().
 */
function createSubagentCustomTools(options: {
  userId: string;
  sessionId: string;
  currentDepth: number;
}): ToolDefinition[] {
  const { userId, sessionId, currentDepth } = options;
  const tools: ToolDefinition[] = [];

  // Get current time tool
  tools.push({
    name: "get_current_time",
    label: "Get Time",
    description: "Get the current date and time",
    parameters: Type.Object({
      timezone: Type.Optional(
        Type.String({
          description: 'Timezone (e.g., "America/New_York"). Defaults to UTC.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { timezone?: string },
    ): Promise<AgentToolResult<unknown>> => {
      const now = new Date();
      const formatOptions: Intl.DateTimeFormatOptions = {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: params.timezone || "UTC",
      };
      const result = {
        timestamp: now.toISOString(),
        formatted: now.toLocaleString("en-US", formatOptions),
        timezone: params.timezone || "UTC",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // Get session info tool
  tools.push({
    name: "get_session_info",
    label: "Session Info",
    description: "Get information about the current session",
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<unknown>> => {
      const result = {
        sessionId,
        userId,
        isSubagent: true,
        depth: currentDepth,
        maxDepth: MAX_SPAWN_DEPTH,
        timestamp: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  return tools;
}

/**
 * Build the self-summary prompt for the announce step.
 * Runs as a second turn in the subagent session after task completion.
 */
function buildSelfSummaryPrompt(params: {
  mode: "brief" | "full";
  fullResult: string;
}): string {
  const cleanResult = params.fullResult.trim();
  const resultBlock = cleanResult || "(no result text)";
  if (params.mode === "brief") {
    return [
      "[System: Summarize your work]",
      "Provide a 1-sentence summary of the outcome for the parent agent.",
      "Focus on what was found/accomplished, not process details.",
      "If no useful data was found, say that explicitly in one sentence.",
      "",
      "Use ONLY this task output as source context:",
      resultBlock,
    ].join("\n");
  }
  return [
    "[System: Summarize your work]",
    "Summarize your key findings for the parent agent (3-6 sentences).",
    "Focus on actionable outcomes. Do not describe your process or tools.",
    "If no useful data was found, say that explicitly.",
    "",
    "Use ONLY this task output as source context:",
    resultBlock,
  ].join("\n");
}

function buildForceFinalResponsePrompt(): string {
  return [
    "[System: Recovery response required]",
    "You just completed tool calls but produced no final assistant message.",
    "Respond now with a concise final result for the user.",
    "Do not call any tools in this step.",
    "If no data was found, explicitly say that no data was found and why.",
  ].join("\n");
}

async function resolveFinalSubagentContent(
  session: FinalizationSession,
): Promise<string> {
  let content = extractLastAssistantText(session.messages) || "";
  if (content.trim()) return content;

  await session.prompt(buildForceFinalResponsePrompt());
  content = extractLastAssistantText(session.messages) || "";

  if (!content.trim()) {
    throw new Error(EMPTY_SUBAGENT_OUTPUT_ERROR);
  }
  return content;
}

/**
 * Extract the last assistant text from session messages.
 */
function extractLastAssistantText(
  messages: readonly any[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && "content" in msg) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }
  return undefined;
}

function serializePreview(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 300);
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return "[unserializable]";
  }
}

export const __testing = {
  resolveFinalSubagentContent,
};

/**
 * Build system prompt for subagent — minimal, no type-specific instructions.
 */
function buildSubagentSystemPrompt(currentDepth: number, credentialEnvVars?: string[]): string {
  const lines = [
    `You are a subagent (depth ${currentDepth}/${MAX_SPAWN_DEPTH}) with full tool access.`,
    "",
    "## Available Tools",
    "You have the same tools as the parent agent:",
    "- read/write/edit: File operations",
    "- exec/process: Shell command execution",
    "- grep/find/ls: File search and listing",
    "- web_search/web_fetch: Web research",
    "- browser: Browser automation",
    "- python_exec: Python sandbox execution",
    "- memory: Long-term memory search/save",
    "- sql_query: Database queries",
    "- slack_message/slack_actions: Slack messaging",
    "- analyze_image: Image analysis",
    "- tts: Text to speech",
    "- spawn_subagent: Delegate to child subagents (if depth allows)",
  ];

  if (credentialEnvVars && credentialEnvVars.length > 0) {
    lines.push(
      "",
      "## Credentials (auto-injected as environment variables in exec)",
      `The following are available in every exec call: ${credentialEnvVars.join(", ")}`,
      "Use them directly — e.g. curl -H \"Authorization: token $GITHUB_TOKEN\" or git commands will pick up GITHUB_TOKEN automatically.",
    );
  }

  lines.push(
    "",
    "## Guidelines",
    "- Complete your assigned task efficiently using available tools",
    "- Provide a clear, concise summary of findings or work done",
    "- Stay focused on the assigned task",
    "- You can spawn child subagents if needed, but prefer doing work directly when possible",
    "- Your results are returned to the parent agent — be thorough but concise",
    "- External messaging (Slack/email/etc.) is allowed only when explicitly requested and a specific recipient/target is provided",
    "",
    "## Context Recovery",
    "If you see markers like '[Content cleared to reduce context size]' or '[...truncated N chars...]',",
    "the content was pruned to prevent context overflow. Re-read the file/resource with smaller chunks",
    "or a targeted line range instead of re-fetching the full content.",
  );

  return lines.join("\n");
}

/**
 * Build the prompt for the subagent with task and optional context.
 */
function buildSubagentPrompt(task: string, context?: string): string {
  const lines = ["## Your Task", task];

  if (context) {
    lines.push("", "## Context from Parent Agent", context);
  }

  lines.push(
    "",
    "## Instructions",
    "Complete this task using the available tools.",
    "When done, provide a clear summary of what you found or accomplished.",
  );

  return lines.join("\n");
}

/**
 * Clean up a subagent session by deleting it and its messages.
 */
async function cleanupSubagentSession(sessionId: string): Promise<void> {
  try {
    await db.delete(avaMessages).where(eq(avaMessages.sessionId, sessionId));
    await db.delete(avaSessions).where(eq(avaSessions.id, sessionId));
    createLogger("subagent").debug(
      { sessionId },
      "Cleaned up subagent session",
    );
  } catch (error) {
    createLogger("subagent").error(
      { err: error, sessionId },
      "Failed to cleanup subagent session",
    );
    throw error;
  }
}

/**
 * Check if a session is a subagent session.
 */
export async function isSubagentSession(sessionId: string): Promise<boolean> {
  const [session] = await db
    .select({ source: avaSessions.source })
    .from(avaSessions)
    .where(eq(avaSessions.id, sessionId))
    .limit(1);

  return session?.source === "subagent";
}
