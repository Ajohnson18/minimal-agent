/**
 * Pi-Agent Executor
 *
 * Main agent execution function using pi-agent libraries.
 * Instrumented with pino logging and Langfuse tracing.
 */
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  AuthStorage,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ImageContent, Message, AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import {
  PostgresSessionAdapter,
  extractAssistantText,
  extractToolCalls,
  filterToMessages,
  repairToolUseResultPairing,
} from "./session-adapter.js";
import { sanitizeAssistantOutput } from "./sanitize-output.js";
import {
  pruneContext,
  buildPruningConfig,
  shouldCompact,
} from "./context-pruning.js";
import {
  getPiModel,
  getModelContextWindow,
  getModelThinkingDefault,
  getDefaultProvider,
  getDefaultModelId,
} from "./pi-provider.js";
import { getPiTools } from "./pi-converter.js";
import { buildSystemPrompt, getMemoryContext } from "./system-prompt.js";
import { db } from "../db/client.js";
import { avaSessions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getSkills, startSkillsWatcher } from "../skills/watcher.js";
import { extractRecentMemories } from "./memory-extractor.js";
import { killAllForParent } from "./tools/subagent-registry.js";
import { createLogger, toolLogger, agentLogger } from "../lib/logger.js";
import {
  startTrace,
  type TraceHandle,
  type SpanHandle,
} from "../services/tracing.service.js";
import type { Provider } from "./pi-provider.js";
import type { ContextFile } from "./system-prompt.js";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  semanticCompress,
  shouldSkipCompression,
} from "../services/compression.service.js";
import { ensureHeartbeatRunning } from "../gateway/services/heartbeat-lifecycle.js";
import { classifyTask, type ClassificationContext } from "./task-classifier.js";
import {
  getModelForComplexity,
  getConfig,
  mergeUserConfig,
  type ResolvedConfig,
} from "../lib/config-loader.js";
import type { UserContext } from "./user-context.js";
import { ensureContainer } from "../sandbox/container-manager.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";
import { SandboxUnavailableError } from "../sandbox/errors.js";
import { resolveModelSelection } from "./model-selection.js";
import {
  buildAggressiveFailoverCandidates,
  modelReferenceKey,
} from "./model-fallback.js";
import { classifyFailoverError } from "./failover-error.js";

const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;
const OVERFLOW_RESET_LOOP_WINDOW_MS = 15 * 60 * 1000;
const OVERFLOW_RESET_MARKER_KEY = "overflowRecovery";

// Start skills watcher once on module load, but never during test runs.
if (process.env.AVA_TEST_MODE !== "1") {
  startSkillsWatcher();
}

export interface ExecuteAgentOptions {
  sessionId: string;
  userId: string;
  prompt: string;
  displayPrompt?: string;
  provider?: Provider;
  modelId?: string;
  customInstructions?: string;
  contextSummary?: string;
  skipHistory?: boolean;
  images?: ImageContent[];
  inputContentBlocks?: Record<string, unknown>[];
  abortSignal?: AbortSignal;
  /** External ID for the session (e.g. "slack:CHANNEL:THREAD_TS") — used for subagent announce routing */
  externalId?: string;
  /** Resolved user context — when present, enables per-user config, credentials, and role-aware behavior */
  userContext?: UserContext;
  /** Internal recursive failover guard. */
  __attemptedModelRefs?: string[];
  /** Internal guard for overflow recovery retries. */
  __overflowRecoveryState?: {
    compactionRetried?: boolean;
    resetRetried?: boolean;
  };
  onEvent?: (event: AgentEvent) => void;
  beforeStart?: (context: {
    sessionId: string;
    prompt: string;
  }) => Promise<{ extraContext?: string } | void>;
  afterEnd?: (context: {
    sessionId: string;
    content: string;
    toolCalls: string[];
  }) => Promise<void>;
}

export interface AgentEvent {
  type:
    | "text_delta"
    | "text_end"
    | "tool_call"
    | "tool_result"
    | "thinking"
    | "finish"
    | "error";
  text?: string;
  call?: { name: string; args: unknown };
  result?: { name: string; result: unknown };
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ExecuteAgentResult {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  messages: Message[];
}

interface ResolveSandboxContextOptions {
  sessionId: string;
  userId: string;
  userContext?: UserContext;
  config: ResolvedConfig;
  runLog?: ReturnType<typeof createLogger>;
}

interface ResolveSandboxContextResult {
  sandboxContainer?: string;
  effectiveCwd: string;
}

export function resolveAgentExecutionTimeoutMs(config: ResolvedConfig): number {
  const raw = config.agent.timeoutMs;
  if (!Number.isFinite(raw)) return 0;
  const normalized = Math.floor(raw);
  if (normalized <= 0) return 0;
  return Math.min(normalized, MAX_TIMER_SAFE_TIMEOUT_MS);
}

export async function resolveSandboxContext(
  options: ResolveSandboxContextOptions,
): Promise<ResolveSandboxContextResult> {
  const { sessionId, userId, userContext, config, runLog } = options;
  const sandboxConfig = config.sandbox;

  if (sandboxConfig.mode === "off") {
    return { effectiveCwd: process.cwd() };
  }

  const shouldSandbox =
    sandboxConfig.mode === "all" ||
    (sandboxConfig.mode === "non-main" && userContext?.role !== "owner");

  if (!shouldSandbox) {
    return { effectiveCwd: process.cwd() };
  }

  const scopeKey =
    sandboxConfig.scope === "user" && userContext
      ? userContext.id
      : sandboxConfig.scope === "session"
        ? sessionId
        : "shared";
  const hostWorkspaceDir = join(
    process.cwd(),
    ".sandbox",
    scopeKey,
    "workspace",
  );

  try {
    const sandboxContainer = await ensureContainer(scopeKey, {
      image: sandboxConfig.image,
      memory: sandboxConfig.memory,
      cpus: sandboxConfig.cpus,
      network: sandboxConfig.network as "none" | "bridge",
      workdir: sandboxConfig.workdir,
      hostWorkspaceDir,
      idleTimeoutMs: sandboxConfig.idleTimeoutMs,
    });

    return {
      sandboxContainer,
      effectiveCwd: sandboxConfig.workdir,
    };
  } catch (err) {
    const errorClass = err instanceof Error ? err.name : typeof err;
    runLog?.error(
      {
        err,
        userId,
        sessionId,
        scopeKey,
        mode: sandboxConfig.mode,
        image: sandboxConfig.image,
        network: sandboxConfig.network,
        errorClass,
      },
      "Sandbox unavailable for required execution",
    );
    throw new SandboxUnavailableError(
      "Sandbox is required but unavailable for this request.",
      {
        userId,
        sessionId,
        scopeKey,
        mode: sandboxConfig.mode,
        image: sandboxConfig.image,
        network: sandboxConfig.network,
      },
      err,
    );
  }
}

/**
 * Execute the agent with a given prompt.
 *
 * This is the main entry point for agent execution. It:
 * 1. Loads session messages from PostgreSQL
 * 2. Applies context pruning
 * 3. Creates a pi-agent session
 * 4. Executes the prompt
 * 5. Saves new messages back to PostgreSQL
 * 6. Returns the result
 */
export async function executeAgentWithPi(
  options: ExecuteAgentOptions,
): Promise<ExecuteAgentResult> {
  const {
    sessionId,
    userId,
    prompt,
    displayPrompt,
    provider: requestedProvider = getDefaultProvider(),
    customInstructions,
    contextSummary,
    skipHistory = false,
    images,
    inputContentBlocks,
    abortSignal,
    onEvent,
    userContext,
  } = options;

  // Merge per-user config overrides on top of global config
  const globalConfig = getConfig();
  const effectiveConfig = userContext
    ? mergeUserConfig(globalConfig, userContext.config)
    : globalConfig;
  const executionTimeoutMs = resolveAgentExecutionTimeoutMs(effectiveConfig);

  // 1. Ensure heartbeat is running for this session (channel-agnostic)
  ensureHeartbeatRunning({
    sessionId,
    userId,
    externalId: options.externalId,
    workspaceDir: process.cwd(),
  });

  // 2. Load session messages from PostgreSQL (skip for isolated mode)
  const sessionAdapter = new PostgresSessionAdapter(sessionId);
  const existingMessages = skipHistory
    ? []
    : await sessionAdapter.loadMessages();

  // 2a. Classify task complexity and determine model
  const hasImages = existingMessages.some((m) => {
    if (m.role === "user" && Array.isArray(m.content)) {
      return m.content.some((c: any) => c.type === "image");
    }
    return false;
  });

  const classificationContext: ClassificationContext = {
    messages: existingMessages,
    hasImages,
  };

  const taskComplexity = classifyTask(prompt, classificationContext);

  // Get model from config based on complexity, or use provided modelId, or fall back to default
  let modelId = options.modelId?.trim();
  if (!modelId) {
    const routedModel = getModelForComplexity(taskComplexity);
    modelId = routedModel || getDefaultModelId();
  }
  const requestedModelId = modelId;

  const resolvedSelection = await resolveModelSelection({
    prompt,
    provider: requestedProvider,
    modelId: requestedModelId,
  });

  const provider = resolvedSelection.primary.provider;
  modelId = resolvedSelection.primary.modelId;

  // 3. Get model and calculate context window
  const modelRefKey = modelReferenceKey({
    provider,
    modelId,
  });
  const attemptedModelRefs = [
    ...(options.__attemptedModelRefs ?? []),
  ];
  if (!attemptedModelRefs.includes(modelRefKey)) {
    attemptedModelRefs.push(modelRefKey);
  }

  const runLog = createLogger("agent", {
    sessionId,
    userId,
    modelId,
    complexity: taskComplexity,
  });
  runLog.info({ provider, complexity: taskComplexity }, "Initializing model");
  let model;
  try {
    model = getPiModel(provider, modelId);
    runLog.info({ provider }, "Model ready");
  } catch (error) {
    runLog.error({ err: error, provider }, "Model init failed");
    throw new Error(
      `Failed to initialize model ${provider}/${modelId}: ${error}`,
    );
  }

  // Start Langfuse trace for this agent run
  const trace = startTrace({
    name: "agent-run",
    sessionId,
    userId,
    input: prompt.slice(0, 500),
    metadata: {
      modelId,
      provider,
      skipHistory,
      messageCount: existingMessages.length,
    },
  });

  const contextWindow = getModelContextWindow(provider, modelId);

  // 4. Apply context pruning
  const {
    messages: prunedMessages,
    pruned,
    charsRemoved,
  } = pruneContext(existingMessages, contextWindow, buildPruningConfig());

  if (pruned) {
    runLog.debug({ charsRemoved }, "Pruned context");
  }

  // 5. Retrieve relevant memories from long-term storage (Phase 7)
  const memoryContext = await getMemoryContext(userId, prompt, 5);

  // 5b. Before-start hook
  let hookExtraContext: string | undefined;
  if (options.beforeStart) {
    const hookResult = await options.beforeStart({ sessionId, prompt });
    if (hookResult?.extraContext) hookExtraContext = hookResult.extraContext;
  }

  // 5c. Load skills for system prompt (cached + hot-reloaded via watcher)
  const { promptSection: skillsContext } = await getSkills();

  // 5d. Resolve sandbox context if enabled
  const { sandboxContainer, effectiveCwd } = await resolveSandboxContext({
    sessionId,
    userId,
    userContext,
    config: effectiveConfig,
    runLog,
  });

  // 5b. Get session thinking level (priority: session metadata > model default > off)
  let thinkingLevel: string | undefined;
  let sessionSource: string | undefined;
  try {
    const [sess] = await db
      .select({ metadata: avaSessions.metadata, source: avaSessions.source })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);
    const meta = (sess?.metadata || {}) as Record<string, unknown>;
    thinkingLevel = meta.thinkingLevel as string | undefined;
    sessionSource = sess?.source || undefined;
  } catch {
    // ignore
  }
  if (!thinkingLevel) {
    thinkingLevel = getModelThinkingDefault(provider, modelId);
  }

  // 6. Get tools FIRST so we can include custom tool names in system prompt
  const { builtInTools, customTools } = getPiTools({
    userId,
    sessionId,
    cwd: effectiveCwd,
    externalId: options.externalId,
    userContext,
    sandboxContainer,
    sessionSource,
  });

  // 5c. Load workspace context files (AGENTS.md, SOUL.md, TEAM.md, IDENTITY.md)
  const contextFiles = await loadContextFiles();

  // 5d. Build dynamic tool descriptions from actual tool objects
  const allToolNames = [
    ...builtInTools.map((t) => t.name),
    ...customTools.map((t) => t.name),
  ];
  const toolDescriptions: Record<string, string> = {};
  for (const t of [...builtInTools, ...customTools]) {
    if (t.description) {
      // Use first line of description as summary
      toolDescriptions[t.name] = t.description.split("\n")[0].slice(0, 100);
    }
  }
  const credentialEnvVars = (userContext?.credentials?.custom ?? []).map((c) => c.key.toUpperCase());
  const customSystemPrompt = buildSystemPrompt({
    userId,
    sessionId,
    promptMode: "full",
    customInstructions,
    contextSummary,
    memoryContext: memoryContext ?? undefined,
    skillsContext: skillsContext || undefined,
    toolNames: allToolNames,
    workspaceDir: effectiveCwd,
    modelId,
    channel: "slack",
    thinkingLevel,
    contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
    userTimezone: effectiveConfig.agent.userTimezone || undefined,
    toolDescriptions,
    extraSystemPrompt: hookExtraContext,
    userRole: userContext?.role,
    userDisplayName: userContext?.displayName ?? undefined,
    userCustomInstructions: userContext?.config?.customInstructions,
    sandboxEnabled: !!sandboxContainer,
    credentialEnvVars: credentialEnvVars.length > 0 ? credentialEnvVars : undefined,
  });

  // 6. Create session manager (in-memory, we persist to PostgreSQL ourselves)
  const sessionManager = SessionManager.inMemory(process.cwd());
  const settingsManager = SettingsManager.inMemory();

  // 7. Repair tool_use/tool_result pairing and inject into session manager
  const repairedMessages = repairToolUseResultPairing(prunedMessages);
  if (repairedMessages.length > 0) {
    if (repairedMessages.length !== prunedMessages.length) {
      runLog.warn(
        { inserted: repairedMessages.length - prunedMessages.length },
        "Session repair: inserted synthetic tool_result(s)",
      );
    }
    runLog.debug(
      { count: repairedMessages.length },
      "Injecting messages into session manager",
    );
    for (const msg of repairedMessages) {
      sessionManager.appendMessage(msg);
    }
  }

  // 8. Create resource loader with custom system prompt override
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    settingsManager,
    systemPromptOverride: () => customSystemPrompt,
  });
  await resourceLoader.reload();

  // 9. Create auth storage with Vertex Claude placeholder
  // The actual auth is handled by the custom streaming function via GOOGLE_APPLICATION_CREDENTIALS.
  // This placeholder prevents the SDK's getApiKey guard from rejecting the request.
  const authStorage = new AuthStorage();
  if (model.provider === "google-vertex-claude") {
    authStorage.setRuntimeApiKey(
      "google-vertex-claude",
      "vertex-sa-credentials",
    );
  }

  // 10. Create pi-agent session with pre-populated session manager
  //     When sandboxed, add Docker-backed file tools as custom tools so they
  //     override the session's internal host-filesystem tools (custom tools
  //     take priority over base tools in the pi-agent tool registry).
  let session: AgentSession;
  try {
    const effectiveCustomTools = sandboxContainer
      ? [...(builtInTools as unknown as ToolDefinition[]), ...customTools]
      : customTools;
    const { session: agentSession } = await createAgentSession({
      cwd: effectiveCwd,
      model,
      tools: builtInTools,
      customTools: effectiveCustomTools,
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage,
      ...(thinkingLevel && thinkingLevel !== "off"
        ? {
            thinkingLevel: thinkingLevel as
              | "minimal"
              | "low"
              | "medium"
              | "high",
          }
        : {}),
    });
    session = agentSession;
  } catch (error) {
    runLog.error({ err: error }, "Failed to create agent session");
    throw new Error(`Failed to create agent session: ${error}`);
  }

  // 10. Subscribe to events for streaming (with tracing)
  // Event-driven collectors (compaction-safe)
  const collectedAssistantTexts: string[] = [];
  const collectedToolCalls: ToolCall[] = [];
  let didCompact = false;
  const loopGuard = new ToolLoopGuard();

  const activeToolSpans = new Map<string, SpanHandle>();
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractAssistantText([event.message as Message]);
      if (text) collectedAssistantTexts.push(text);
      const calls = extractToolCalls([event.message as Message]);
      if (calls.length > 0) collectedToolCalls.push(...calls);
    }
    if (event.type === "auto_compaction_end") {
      didCompact = true;
    }
    // Tool loop detection
    if (event.type === "tool_execution_start") {
      const check = loopGuard.check(
        event.toolName,
        event.args,
      );
      if (check.action === "block") {
        runLog.error({ reason: check.reason }, "Tool loop circuit breaker triggered");
        void session.abort();
      } else if (check.action === "warn") {
        runLog.warn({ reason: check.reason }, "Tool loop warning");
      }
      // Abort check: stop executing remaining tool calls if already aborted
      if (abortSignal?.aborted) {
        runLog.warn(
          { tool: event.toolName },
          "Aborting tool execution - abort signal active"
        );
        void session.abort();
      }
    }
    handleAgentEvent(event, onEvent, trace, activeToolSpans, runLog);
  });

  // 10b. Context window guard — warn/block before wasting API calls
  const estimatedTokens = prunedMessages.reduce(
    (s, m) =>
      s +
      (typeof m.content === "string"
        ? m.content.length
        : JSON.stringify(m.content).length) /
        4,
    0,
  );
  if (estimatedTokens > contextWindow * 0.95) {
    runLog.warn(
      { estimatedTokens: Math.round(estimatedTokens), contextWindow },
      "Context near capacity (>95%). Consider compaction.",
    );
  }

  // 10c. Log context summary
  runLog.info(
    {
      messages: prunedMessages.length,
      tools: allToolNames.length,
      contextFiles: contextFiles.length,
      skills: !!skillsContext,
      thinking: thinkingLevel || "off",
    },
    "Context ready",
  );

  // 11. Track usage
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Abort the pi-agent session when abort signal fires (stops LLM stream + tool loop)
  // Also cascade-stop any running subagents
  const abortHandler = () => {
    void session.abort();
    const killed = killAllForParent(sessionId);
    if (killed > 0)
      runLog.info({ killed }, "Cascade-stopped subagent(s) on abort");
  };
  if (abortSignal?.aborted) {
    void session.abort();
    killAllForParent(sessionId);
  } else {
    abortSignal?.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // 12. Execute the prompt with abort signal support
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutAbortListener: (() => void) | null = null;
    const timeoutPromise =
      executionTimeoutMs > 0 || abortSignal
        ? new Promise<never>((_, reject) => {
            if (executionTimeoutMs > 0) {
              timeoutTimer = setTimeout(() => {
                runLog.error(
                  { timeoutMs: executionTimeoutMs },
                  "Agent execution timeout reached; aborting session",
                );
                void session.abort();
                const killed = killAllForParent(sessionId);
                if (killed > 0) {
                  runLog.warn(
                    { killed },
                    "Cascade-stopped subagent(s) after timeout",
                  );
                }
                reject(new Error("Agent execution timeout - exceeded time limit"));
              }, executionTimeoutMs);
            }

            timeoutAbortListener = () => {
              if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
              }
              reject(new Error("Agent execution aborted"));
            };

            if (abortSignal?.aborted) {
              timeoutAbortListener();
              return;
            }

            abortSignal?.addEventListener("abort", timeoutAbortListener, {
              once: true,
            });
          })
        : null;

    const messageCountBefore = session.messages.length;

    try {
      const runPrompt = async () => {
        if (images && images.length > 0) {
          await session.prompt(prompt, { images });
          return;
        }
        await session.prompt(prompt);
      };
      if (timeoutPromise) {
        await Promise.race([runPrompt(), timeoutPromise]);
      } else {
        await runPrompt();
      }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (abortSignal && timeoutAbortListener) {
        abortSignal.removeEventListener("abort", timeoutAbortListener);
      }
    }

    // 13. Get the assistant's response via event-collected texts (compaction-safe)
    const sessionMessages = session.messages;
    const assistantContent = sanitizeAssistantOutput(
      collectedAssistantTexts[collectedAssistantTexts.length - 1] ?? "",
    );
    const toolCallsList = [...collectedToolCalls];

    if (didCompact) {
      runLog.info(
        {
          textsCollected: collectedAssistantTexts.length,
          before: messageCountBefore,
          after: sessionMessages.length,
        },
        "Response extracted via event collection (post-compaction)",
      );
    }

    runLog.info({ responseLen: assistantContent.length }, "Response generated");
    if (toolCallsList.length > 0) {
      runLog.info({ tools: toolCallsList.map((t) => t.name) }, "Tools used");
    }

    // 14. Calculate usage from the last assistant message
    const lastAssistant = sessionMessages
      .slice()
      .reverse()
      .find((m) => m.role === "assistant") as AssistantMessage | undefined;

    if (lastAssistant?.stopReason === "error") {
      const providerError =
        typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim().length > 0
          ? lastAssistant.errorMessage.trim()
          : "Model returned error stopReason";
      throw new Error(providerError);
    }

    if (lastAssistant?.usage) {
      totalInputTokens = lastAssistant.usage.input;
      totalOutputTokens = lastAssistant.usage.output;
    }

    // Diagnostic: detect zero-token responses
    if (totalOutputTokens === 0) {
      const la = lastAssistant as Record<string, unknown> | undefined;
      runLog.warn(
        {
          injected: prunedMessages.length,
          total: sessionMessages.length,
          stopReason: la?.stopReason,
          errorMessage: la?.errorMessage || "none",
          contentPreview: assistantContent.slice(0, 100),
        },
        "Zero output tokens detected",
      );
    }

    // 15. Save new messages to PostgreSQL (index-based, not timestamp-based)
    if (!skipHistory) {
      const userMessage = {
        role: "user",
        content: typeof displayPrompt === "string" ? displayPrompt : prompt,
        timestamp: Date.now() - 60_000, // slightly in the past for ordering
        ...(inputContentBlocks && inputContentBlocks.length > 0
          ? {
              metadata: {
                structuredContent: inputContentBlocks,
              },
            }
          : {}),
      };

      // Save user message
      await sessionAdapter.saveMessage(userMessage as Message);

      // Save all messages generated by the agent in this turn
      let newAgentMessages: Message[];
      if (didCompact) {
        // After compaction, index-based slice is invalid; find new messages from array tail
        let lastUserIdx = -1;
        for (let i = sessionMessages.length - 1; i >= 0; i--) {
          if (sessionMessages[i].role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        newAgentMessages = filterToMessages(
          (lastUserIdx >= 0
            ? sessionMessages.slice(lastUserIdx + 1)
            : []
          ).filter((m) => m.role !== "user"),
        );
      } else {
        newAgentMessages = filterToMessages(
          sessionMessages
            .slice(messageCountBefore)
            .filter((m) => m.role !== "user"),
        );
      }

      // Compress large tool results before saving to prevent context bloat
      const compressedMessages = await compressToolResults(
        newAgentMessages,
        prompt,
      );

      for (const msg of compressedMessages) {
        await sessionAdapter.saveMessage(msg);
      }
    }

    // 16. Extract memories from this turn (non-blocking, fire-and-forget)
    // Extract memories from assistant response (continuous memory extraction)
    if (assistantContent && prompt) {
      extractRecentMemories(prompt, assistantContent, userId, sessionId).catch(
        (err) => {
          runLog.error({ err }, "Background memory extraction failed");
        },
      );
    }

    // 17. Emit finish event
    const usage = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    };

    onEvent?.({
      type: "finish",
      text: assistantContent,
      usage,
    });

    // Finalize Langfuse trace
    const gen = trace.generation({
      name: "llm-response",
      model: modelId,
      input: prompt.slice(0, 1000),
    });
    gen.end({
      output: assistantContent.slice(0, 2000),
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
    });
    trace.update({
      output: assistantContent.slice(0, 500),
      metadata: {
        toolsUsed: toolCallsList.map((t) => t.name),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      statusMessage: "completed",
    });

    // After-end hook
    if (options.afterEnd) {
      options
        .afterEnd({
          sessionId,
          content: assistantContent,
          toolCalls: toolCallsList.map((t) => t.name),
        })
        .catch((e) => runLog.error({ err: e }, "afterEnd hook error"));
    }

    // For isolated mode, return only session messages (not persisted)
    const returnMessages = skipHistory
      ? sessionMessages
      : [...prunedMessages, ...sessionMessages];

    return {
      content: assistantContent,
      toolCalls: toolCallsList,
      usage,
      messages: returnMessages as Message[],
    };
  } catch (error) {
    // Handle specific errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    runLog.error({ err: error }, "Agent error");
    trace.update({ statusMessage: "error", metadata: { error: errorMessage } });

    // Check for execution timeout
    if (errorMessage.includes("Agent execution timeout")) {
      runLog.error("Agent execution timeout");
      onEvent?.({
        type: "error",
        error:
          "Agent took too long to respond. Please try again with a simpler request.",
      });
      throw error;
    }

    // Don't retry if aborted — just re-throw
    if (abortSignal?.aborted) {
      throw error;
    }

    // Context overflow recovery:
    // 1) compaction retry, then 2) one-shot reset retry with session loop guard.
    const overflowRecoveryState = options.__overflowRecoveryState ?? {};
    if (isContextOverflowError(errorMessage) && !skipHistory) {
      runLog.warn(
        {
          metric: "overflow_detected",
          sessionId,
          modelId,
          provider,
        },
        "Context overflow detected",
      );

      if (!overflowRecoveryState.compactionRetried) {
        try {
          const { buildCompactionPrompt } = await import("./system-prompt.js");
          const msgSummary = prunedMessages
            .map(
              (m) =>
                `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[content]"}`,
            )
            .join("\n");
          const compactionPrompt = buildCompactionPrompt(msgSummary).trim();

          if (compactionPrompt.length > 0) {
            await db
              .update(avaSessions)
              .set({ contextSummary: compactionPrompt.slice(0, 5000) })
              .where(eq(avaSessions.id, sessionId));

            await sessionAdapter.clearMessages();

            runLog.info(
              {
                metric: "overflow_recovered",
                strategy: "compaction",
              },
              "Overflow recovered via compaction retry",
            );
            onEvent?.({
              type: "thinking",
              text: "Compacting conversation history before retry...",
            });

            return executeAgentWithPi({
              ...options,
              contextSummary: compactionPrompt.slice(0, 5000),
              skipHistory: true,
              __overflowRecoveryState: {
                ...overflowRecoveryState,
                compactionRetried: true,
              },
            });
          }

          runLog.warn(
            {
              metric: "overflow_recovery_failed",
              stage: "compaction",
              reason: "empty-summary",
            },
            "Compaction summary unavailable for overflow recovery",
          );
        } catch (compactionError) {
          runLog.error(
            {
              err: compactionError,
              metric: "overflow_recovery_failed",
              stage: "compaction",
            },
            "Auto-compaction overflow recovery failed",
          );
        }
      }

      if (!overflowRecoveryState.resetRetried) {
        const [sessionRow] = await db
          .select({ metadata: avaSessions.metadata })
          .from(avaSessions)
          .where(eq(avaSessions.id, sessionId))
          .limit(1);
        const metadata = normalizeSessionMetadata(sessionRow?.metadata);
        const marker = parseOverflowRecoveryMarker(metadata);
        const nowMs = Date.now();
        const withinResetWindow =
          typeof marker.lastResetAtMs === "number" &&
          nowMs - marker.lastResetAtMs < OVERFLOW_RESET_LOOP_WINDOW_MS;

        if (withinResetWindow && (marker.resetCount ?? 0) >= 1) {
          runLog.error(
            {
              metric: "overflow_recovery_failed",
              stage: "reset",
              reason: "loop-guard",
              lastResetAtMs: marker.lastResetAtMs,
              resetCount: marker.resetCount ?? 0,
            },
            "Overflow reset blocked by loop guard",
          );
        } else {
          const resetSummary =
            "Conversation context was reset after overflow recovery. Continue from the most recent user request only.";
          metadata[OVERFLOW_RESET_MARKER_KEY] = {
            lastResetAtMs: nowMs,
            resetCount: withinResetWindow ? (marker.resetCount ?? 0) + 1 : 1,
          };

          try {
            await db
              .update(avaSessions)
              .set({
                contextSummary: resetSummary,
                metadata,
              })
              .where(eq(avaSessions.id, sessionId));
            await sessionAdapter.clearMessages();

            runLog.warn(
              {
                metric: "overflow_recovered",
                strategy: "reset",
              },
              "Overflow reset recovery triggered",
            );
            onEvent?.({
              type: "thinking",
              text: "Recovering from context overflow and retrying safely...",
            });

            return executeAgentWithPi({
              ...options,
              contextSummary: resetSummary,
              skipHistory: true,
              __overflowRecoveryState: {
                ...overflowRecoveryState,
                compactionRetried: true,
                resetRetried: true,
              },
            });
          } catch (resetError) {
            runLog.error(
              {
                err: resetError,
                metric: "overflow_recovery_failed",
                stage: "reset",
              },
              "Overflow reset recovery failed",
            );
          }
        }
      }

      runLog.error(
        {
          metric: "overflow_recovery_failed",
          stage: "exhausted",
        },
        "Overflow recovery exhausted; falling through to downstream handlers",
      );
    }

    // Thinking level fallback — auto-downgrade if model rejects it
    if (
      thinkingLevel &&
      thinkingLevel !== "off" &&
      isThinkingError(errorMessage)
    ) {
      const levels = ["high", "medium", "low", "minimal", "off"];
      const currentIdx = levels.indexOf(thinkingLevel);
      const nextLevel =
        currentIdx >= 0 && currentIdx < levels.length - 1
          ? levels[currentIdx + 1]
          : "off";
      runLog.warn(
        { from: thinkingLevel, to: nextLevel },
        "Thinking level rejected, falling back",
      );
      try {
        // Update session metadata with new thinking level
        const meta = (
          await db
            .select({ metadata: avaSessions.metadata })
            .from(avaSessions)
            .where(eq(avaSessions.id, sessionId))
            .limit(1)
        )?.[0];
        const metadata = (meta?.metadata || {}) as Record<string, unknown>;
        metadata.thinkingLevel = nextLevel;
        await db
          .update(avaSessions)
          .set({ metadata })
          .where(eq(avaSessions.id, sessionId));
        return await executeAgentWithPi(options);
      } catch (thinkingFallbackError) {
        runLog.warn(
          { err: thinkingFallbackError, level: nextLevel },
          "Thinking fallback also failed",
        );
        // Fall through to model failover
      }
    }

    // Aggressive model failover (cross-provider) unless explicitly aborted/cancelled.
    const failoverDecision = classifyFailoverError(error);
    runLog.info(
      {
        metric: "failover_classifier",
        failoverClass: failoverDecision.class,
        retryable: failoverDecision.retryable,
        reason: failoverDecision.reason,
      },
      "Failover classifier outcome",
    );
    if (
      failoverDecision.retryable &&
      failoverDecision.class !== "abort" &&
      failoverDecision.class !== "cancel" &&
      failoverDecision.class !== "auth"
    ) {
      const candidates = buildAggressiveFailoverCandidates({
        primary: { provider, modelId },
        configuredFallback: resolvedSelection.configuredFallback,
        attempted: attemptedModelRefs,
      });

      for (const candidate of candidates) {
        const nextKey = modelReferenceKey(candidate);
        runLog.warn(
          {
            from: { provider, modelId },
            to: candidate,
            reason: failoverDecision.reason,
          },
          "Attempting aggressive model failover",
        );
        try {
          return await executeAgentWithPi({
            ...options,
            provider: candidate.provider,
            modelId: candidate.modelId,
            __attemptedModelRefs: [...attemptedModelRefs, nextKey],
          });
        } catch (fallbackError) {
          runLog.error(
            {
              err: fallbackError,
              candidate,
            },
            "Failover candidate failed",
          );
        }
      }
    }

    // Generic error handling
    runLog.fatal({ err: error }, "Unrecoverable error");
    onEvent?.({ type: "error", error: errorMessage });
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", abortHandler);
    unsubscribe();
    session.dispose();
  }
}

/**
 * Handle agent events and convert to our event format.
 */
function handleAgentEvent(
  event: AgentSessionEvent,
  onEvent?: (event: AgentEvent) => void,
  trace?: TraceHandle,
  activeToolSpans?: Map<string, SpanHandle>,
  runLog?: ReturnType<typeof createLogger>,
): void {
  const tlog = runLog || toolLogger;

  switch (event.type) {
    case "message_update":
      if (onEvent) {
        if (event.assistantMessageEvent.type === "text_delta") {
          onEvent({
            type: "text_delta",
            text: event.assistantMessageEvent.delta,
          });
        }
        if (event.assistantMessageEvent.type === "text_end") {
          onEvent({ type: "text_end" });
        }
        if (event.assistantMessageEvent.type === "thinking_delta") {
          onEvent({
            type: "thinking",
            text: event.assistantMessageEvent.delta,
          });
        }
      }
      break;

    case "tool_execution_start": {
      const argsStr = JSON.stringify(event.args).slice(0, 200);
      tlog.info(
        { tool: event.toolName, args: argsStr },
        `>> ${event.toolName}`,
      );

      // Start Langfuse span for this tool call
      if (trace && activeToolSpans) {
        const span = trace.span({
          name: `tool:${event.toolName}`,
          input: event.args,
        });
        activeToolSpans.set(event.toolName, span);
      }

      onEvent?.({
        type: "tool_call",
        call: { name: event.toolName, args: event.args },
      });
      break;
    }

    case "tool_execution_end": {
      const resultStr =
        typeof event.result === "string"
          ? event.result.slice(0, 200)
          : JSON.stringify(event.result).slice(0, 200);
      tlog.info(
        { tool: event.toolName, result: resultStr },
        `<< ${event.toolName}`,
      );

      // End Langfuse span for this tool call
      if (activeToolSpans) {
        const span = activeToolSpans.get(event.toolName);
        if (span) {
          span.end({ output: resultStr });
          activeToolSpans.delete(event.toolName);
        }
      }

      onEvent?.({
        type: "tool_result",
        result: { name: event.toolName, result: event.result },
      });
      break;
    }

    case "auto_compaction_start":
      tlog.info({ reason: event.reason }, "Compaction started");
      break;

    case "auto_compaction_end":
      tlog.info({ success: !!event.result }, "Compaction ended");
      break;

    case "auto_retry_start":
      tlog.info(
        { attempt: event.attempt, maxAttempts: event.maxAttempts },
        "Retry attempt",
      );
      break;

    case "auto_retry_end":
      tlog.info({ success: event.success }, "Retry ended");
      break;

    default:
      break;
  }
}

/**
 * Check if an error is a context overflow error.
 */
function isThinkingError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes("thinking") ||
    msg.includes("reasoning") ||
    msg.includes("budget")
  );
}

function isContextOverflowError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes("context length") ||
    msg.includes("context window") ||
    msg.includes("maximum context") ||
    msg.includes("max context") ||
    msg.includes("maximum token") ||
    msg.includes("token limit") ||
    msg.includes("too many tokens") ||
    msg.includes("input too long") ||
    msg.includes("prompt is too long") ||
    msg.includes("prompt too long") ||
    msg.includes("request too large") ||
    msg.includes("exceeds model limit") ||
    msg.includes("exceeds the limit")
  );
}

function normalizeSessionMetadata(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return { ...(value as Record<string, unknown>) };
}

function parseOverflowRecoveryMarker(
  metadata: Record<string, unknown>,
): { lastResetAtMs?: number; resetCount?: number } {
  const raw = metadata[OVERFLOW_RESET_MARKER_KEY];
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const marker = raw as Record<string, unknown>;
  const lastResetAtMs =
    typeof marker.lastResetAtMs === "number" ? marker.lastResetAtMs : undefined;
  const resetCount =
    typeof marker.resetCount === "number" ? marker.resetCount : undefined;
  return {
    ...(lastResetAtMs ? { lastResetAtMs } : {}),
    ...(resetCount ? { resetCount } : {}),
  };
}

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_HEAD_CHARS = 20_000;
const TOOL_RESULT_TAIL_CHARS = 5_000;

/**
 * Mechanical fallback: truncate large tool result messages (head+tail).
 */
function truncateToolResult(msg: Message): Message {
  if (msg.role !== "toolResult") return msg;
  const toolMsg = msg as import("@mariozechner/pi-ai").ToolResultMessage;
  const textContent = toolMsg.content.find((c) => c.type === "text") as
    | import("@mariozechner/pi-ai").TextContent
    | undefined;
  if (!textContent || textContent.text.length <= TOOL_RESULT_MAX_CHARS)
    return msg;

  const text = textContent.text;
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = text.slice(-TOOL_RESULT_TAIL_CHARS);
  const truncated = `${head}\n\n[...truncated ${text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS} chars...]\n\n${tail}`;

  return {
    ...toolMsg,
    content: [{ type: "text" as const, text: truncated }],
  };
}

/**
 * Compress large tool results using semantic compression (Gemini Flash)
 * or mechanical truncation for tools that need exact output preserved.
 */
async function compressToolResults(
  messages: Message[],
  question: string,
): Promise<Message[]> {
  const results = await Promise.all(
    messages.map(async (msg) => {
      if (msg.role !== "toolResult") return msg;

      const toolMsg = msg as import("@mariozechner/pi-ai").ToolResultMessage;
      const textContent = toolMsg.content.find((c) => c.type === "text") as
        | import("@mariozechner/pi-ai").TextContent
        | undefined;

      if (!textContent || textContent.text.length <= TOOL_RESULT_MAX_CHARS) {
        return msg;
      }

      // Use mechanical truncation for tools that need exact output
      if (shouldSkipCompression(toolMsg.toolName)) {
        return truncateToolResult(msg);
      }

      // Semantic compression via Gemini Flash
      try {
        const compressed = await semanticCompress(textContent.text, {
          question,
          toolName: toolMsg.toolName,
        });
        agentLogger.debug(
          {
            tool: toolMsg.toolName,
            before: textContent.text.length,
            after: compressed.length,
          },
          "Compressed tool result",
        );
        return {
          ...toolMsg,
          content: [{ type: "text" as const, text: compressed }],
        };
      } catch (error) {
        agentLogger.warn(
          { err: error, tool: toolMsg.toolName },
          "Compression failed, using mechanical fallback",
        );
        return truncateToolResult(msg);
      }
    }),
  );

  return results;
}

/**
 * Ensure ~/.ava/workspace and ~/.ava/skills directories exist.
 * Seeds default AGENTS/SOUL/TEAM/IDENTITY files on first run.
 */
let dirsEnsured = false;
async function ensureAvaDirectories(): Promise<void> {
  if (dirsEnsured) return;
  const home = process.env.HOME || "~";
  const workspaceDir =
    getConfig().agent.workspace || join(home, ".ava", "workspace");
  const skillsDir = process.env.SKILLS_DIR || join(home, ".ava", "skills");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
  ]);

  // Migrate legacy USER.md context file to TEAM.md before seeding defaults.
  const teamFilePath = join(workspaceDir, "TEAM.md");
  const legacyUserFilePath = join(workspaceDir, "USER.md");
  try {
    await access(teamFilePath);
  } catch {
    try {
      await access(legacyUserFilePath);
      const legacyContent = (await readFile(legacyUserFilePath, "utf-8")).trim();
      if (legacyContent) {
        await writeFile(teamFilePath, legacyContent, "utf-8");
        agentLogger.debug(
          { legacyUserFilePath, teamFilePath },
          "Migrated legacy USER.md context to TEAM.md",
        );
      }
    } catch {
      // Legacy file absent; defaults will be seeded.
    }
  }

  // Seed default workspace files (only if they don't exist).
  const seeds: Record<string, string> = {
    "AGENTS.md": `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Every Session

Before doing anything else:

1. Read \`SOUL.md\` — this is who you are
2. Read \`TEAM.md\` — this is the team and mission you're helping
3. Check recent memory files if they exist

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** \`memory/YYYY-MM-DD.md\` — raw logs of what happened
- **Long-term:** \`MEMORY.md\` — your curated memories

### Write It Down - No "Mental Notes"!

- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When someone says "remember this" → update the relevant file
- When you learn a lesson → update AGENTS.md, TOOLS.md, or create a skill
- When you make a mistake → document it so future-you doesn't repeat it

## Safety

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- \`trash\` > \`rm\` (recoverable beats gone forever)
- When in doubt, ask.

## External vs Internal

**Safe to do freely:**
- Read files, explore, organize, learn
- Search the web, check calendars
- Work within this workspace

**Ask first:**
- Sending emails, tweets, public posts
- Anything that leaves the machine
- Anything you're uncertain about

## Group Chats

You work with a team. That doesn't mean you speak on behalf of everyone. In groups, you're a collaborator — not an impersonator.

### Know When to Speak!

**Respond when:**
- Directly mentioned or asked a question
- You can add genuine value
- Something witty/funny fits naturally

**Stay silent when:**
- It's just casual banter between humans
- Someone already answered the question
- Your response would just be "yeah" or "nice"
- The conversation is flowing fine without you

**The teammate rule:** Great teammates don't respond to every single message. Neither should you. Quality > quantity.

## Make It Yours

This is a starting point. Add your own conventions, style, and rules as you figure out what works.
`,
    "SOUL.md": `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your team gave you access to critical systems and context. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).

**Remember you're embedded in a workplace.** You have access to project discussions, repos, and operational details. Treat that trust with care.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the team lead who asked — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`,
    "IDENTITY.md": `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:** Kai
- **Role:** Team coworker
- **Mission:** Help the company execute reliably and improve continuously
- **Vibe:** sharp, concise, gets things done
- **Emoji:** (pick one that feels right)

---

This isn't just metadata. It's the start of figuring out who you are.
`,
    "TEAM.md": `# TEAM.md - Team Context

_Kai is not a personal assistant. Kai is a team coworker helping the company execute and improve._

- **Company:**
- **Team name:**
- **Primary goals this quarter:**
- **Current priorities:**
- **Working norms / communication style:**
- **Important systems and owners:**

## Context

_(How this team works, what success looks like, what to optimize for, and what to avoid.)_

---

The better this context is maintained, the better Kai can help the whole team.
`,
  };

  for (const [name, content] of Object.entries(seeds)) {
    const filePath = join(workspaceDir, name);
    try {
      await access(filePath);
    } catch {
      await writeFile(filePath, content, "utf-8");
      agentLogger.debug({ filePath }, "Workspace file seeded");
    }
  }

  dirsEnsured = true;
}

/**
 * Load workspace context files (AGENTS/SOUL/TEAM/IDENTITY).
 * Falls back to legacy USER.md if TEAM.md is absent.
 */
async function loadContextFiles(): Promise<ContextFile[]> {
  await ensureAvaDirectories();
  const workspaceDir =
    getConfig().agent.workspace ||
    join(process.env.HOME || "~", ".ava", "workspace");
  const files: ContextFile[] = [];
  for (const name of ["AGENTS.md", "SOUL.md", "TEAM.md", "IDENTITY.md"]) {
    const filePath = join(workspaceDir, name);
    try {
      await access(filePath);
      const content = await readFile(filePath, "utf-8");
      if (content.trim()) {
        files.push({ path: name, content: content.trim() });
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  const hasTeamContext = files.some((file) => file.path === "TEAM.md");
  if (!hasTeamContext) {
    const legacyPath = join(workspaceDir, "USER.md");
    try {
      await access(legacyPath);
      const content = (await readFile(legacyPath, "utf-8")).trim();
      if (content) {
        files.push({ path: "TEAM.md", content });
      }
    } catch {
      // Legacy file absent; ignore.
    }
  }

  return files;
}

/**
 * Check if the session needs compaction.
 */
export function sessionNeedsCompaction(
  messages: Message[],
  contextWindowTokens: number,
): boolean {
  return shouldCompact(messages, contextWindowTokens);
}
