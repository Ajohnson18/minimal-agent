/**
 * Agent Methods
 *
 * RPC handlers for agent execution.
 */
import { runtime } from "../runtime.js";
import {
  executeAgentWithPi,
  type AgentEvent,
  resolveSandboxContext,
} from "../../agent/executor-pi.js";
import { getContextSummary } from "../../agent/compaction.js";
import { resolveUserContext } from "../../agent/user-context.js";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import { getConfig } from "../../lib/config-loader.js";
import {
  SANDBOX_UNAVAILABLE_CODE,
  isSandboxUnavailableError,
} from "../../sandbox/errors.js";
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from "../services/session-identity.js";
import type {
  AgentRunParams,
  AgentRunResult,
  AgentStatusParams,
  AgentStatusResult,
  AgentCancelParams,
  AgentCancelResult,
} from "../protocol/methods.js";
import type {
  AgentStartedEvent,
  AgentThinkingEvent,
  AgentChunkEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentCompletedEvent,
  AgentErrorEvent,
} from "../protocol/events.js";

const FAKE_AGENT_MODE = process.env.AVA_TEST_FAKE_AGENT_MODE === "1";
const FAKE_AGENT_DELAY_MS = (() => {
  const parsed = Number(process.env.AVA_TEST_FAKE_AGENT_DELAY_MS ?? "40");
  if (!Number.isFinite(parsed)) {
    return 40;
  }
  return Math.min(500, Math.max(1, Math.floor(parsed)));
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeFakeAgent(options: {
  message: string;
  abortSignal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<{
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
  const chunks = ["[fake] ", "stream ", "complete"];
  let streamed = "";
  for (const chunk of chunks) {
    if (options.abortSignal?.aborted) {
      throw new Error("Agent run aborted");
    }
    await sleep(FAKE_AGENT_DELAY_MS);
    if (options.abortSignal?.aborted) {
      throw new Error("Agent run aborted");
    }
    options.onEvent({ type: "text_delta", text: chunk });
    streamed += chunk;
  }

  const content = `${streamed.trim()} (${options.message.trim()})`;
  return {
    content,
    usage: {
      inputTokens: Math.max(1, options.message.length),
      outputTokens: Math.max(1, content.length),
      totalTokens: Math.max(2, options.message.length + content.length),
    },
  };
}

export async function agentRun(
  params: AgentRunParams,
  authUserId?: string,
): Promise<AgentRunResult | RpcError> {
  const {
    sessionKey,
    message,
    userId: requestedUserId = "gateway-user",
    contextSummary,
  } = params;
  const userId = authUserId ?? requestedUserId;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (!message) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionKey and message are required",
    );
  }
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  let sessionId: string | undefined;
  let resolvedSessionKey: string | undefined;
  if (authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: authUserId,
      sessionKey,
    });

    if (!identity) {
      return createError(
        ErrorCodes.NOT_FOUND,
        `Session ${sessionKey} not found`,
      );
    }
    sessionId = identity.sessionId;
    resolvedSessionKey = identity.sessionKey;
  } else {
    const identity = await resolveGatewaySessionIdentity({ sessionKey });
    if (!identity) {
      return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
    }
    sessionId = identity.sessionId;
    resolvedSessionKey = identity.sessionKey;
  }

  if (!sessionId || !resolvedSessionKey) {
    return createError(ErrorCodes.NOT_FOUND, "Session not found");
  }

  try {
    await resolveSandboxContext({
      sessionId,
      userId,
      config: getConfig(),
    });
  } catch (error) {
    if (isSandboxUnavailableError(error)) {
      return createError(
        ErrorCodes.SANDBOX_UNAVAILABLE,
        error.message,
        { code: SANDBOX_UNAVAILABLE_CODE },
      );
    }
    throw error;
  }

  // Create a run record
  const run = runtime.createRun(sessionId, userId);

  // Broadcast started event
  const startedEvent: AgentStartedEvent = {
    event: "agent.started",
    payload: {
      runId: run.runId,
      sessionKey: resolvedSessionKey,
      startedAt: run.startedAt,
    },
  };
  runtime.broadcast(startedEvent, sessionId);

  // Execute agent asynchronously
  executeAgentAsync(run.runId, sessionId, resolvedSessionKey, userId, message, contextSummary);

  return {
    runId: run.runId,
    status: "accepted",
    acceptedAt: Date.now(),
  };
}

async function executeAgentAsync(
  runId: string,
  sessionId: string,
  sessionKey: string,
  userId: string,
  message: string,
  contextSummaryOverride?: string
): Promise<void> {
  try {
    runtime.updateRun(runId, { status: "running" });

    // Get context summary if not provided
    const contextSummary =
      contextSummaryOverride ?? (await getContextSummary(sessionId));

    const run = runtime.getRun(runId);
    if (!run || run.status === "cancelled") {
      return;
    }

    const userContext = await resolveUserContext("web", userId);

    const result = FAKE_AGENT_MODE
      ? await executeFakeAgent({
          message,
          abortSignal: run.abortController?.signal,
          onEvent: (event: AgentEvent) => {
            handleAgentEvent(runId, sessionId, event);
          },
        })
      : await executeAgentWithPi({
          sessionId,
          userId,
          userContext,
          prompt: message,
          contextSummary: contextSummary || undefined,
          abortSignal: run.abortController?.signal,
          onEvent: (event: AgentEvent) => {
            handleAgentEvent(runId, sessionId, event);
          },
        });

    const latestRun = runtime.getRun(runId);
    if (!latestRun || latestRun.status === "cancelled") {
      return;
    }

    // Update run with result
    runtime.updateRun(runId, {
      status: "completed",
      completedAt: Date.now(),
      content: result.content,
      usage: result.usage,
    });

    // Broadcast completed event
    const completedEvent: AgentCompletedEvent = {
      event: "agent.completed",
      payload: {
        runId,
        sessionKey,
        content: result.content,
        usage: result.usage,
        completedAt: Date.now(),
      },
    };
    runtime.broadcast(completedEvent, sessionId);
  } catch (error) {
    const latestRun = runtime.getRun(runId);
    if (latestRun?.status === "cancelled") {
      return;
    }

    const errorMessage = isSandboxUnavailableError(error)
      ? `${SANDBOX_UNAVAILABLE_CODE}: ${error.message}`
      : (error instanceof Error ? error.message : String(error));

    runtime.updateRun(runId, {
      status: "error",
      completedAt: Date.now(),
      error: errorMessage,
    });

    // Broadcast error event
    const errorEvent: AgentErrorEvent = {
      event: "agent.error",
      payload: {
        runId,
        sessionKey,
        error: errorMessage,
        errorAt: Date.now(),
      },
    };
    runtime.broadcast(errorEvent, sessionId);
  }
}

function handleAgentEvent(
  runId: string,
  sessionId: string,
  event: AgentEvent
): void {
  switch (event.type) {
    case "thinking": {
      const thinkingEvent: AgentThinkingEvent = {
        event: "agent.thinking",
        payload: { runId },
      };
      runtime.broadcast(thinkingEvent, sessionId);
      break;
    }

    case "text_delta":
      if (event.text) {
        const chunkEvent: AgentChunkEvent = {
          event: "agent.chunk",
          payload: { runId, text: event.text },
        };
        runtime.broadcast(chunkEvent, sessionId);
      }
      break;

    case "tool_call":
      if (event.call) {
        const toolCallEvent: AgentToolCallEvent = {
          event: "agent.tool_call",
          payload: {
            runId,
            toolName: event.call.name,
            args: event.call.args,
          },
        };
        runtime.broadcast(toolCallEvent, sessionId);
      }
      break;

    case "tool_result":
      if (event.result) {
        const toolResultEvent: AgentToolResultEvent = {
          event: "agent.tool_result",
          payload: {
            runId,
            toolName: event.result.name,
            result: event.result.result,
          },
        };
        runtime.broadcast(toolResultEvent, sessionId);
      }
      break;
  }
}

export async function agentStatus(
  params: AgentStatusParams,
  authUserId?: string,
): Promise<AgentStatusResult | RpcError> {
  const { runId } = params;

  if (!runId) {
    return createError(ErrorCodes.INVALID_PARAMS, "runId is required");
  }

  const run = runtime.getRun(runId);
  if (!run) {
    return createError(ErrorCodes.NOT_FOUND, `Run ${runId} not found`);
  }
  if (authUserId && run.userId !== authUserId) {
    return createError(ErrorCodes.UNAUTHORIZED, "Not authorized for this run");
  }

  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    content: run.content,
    error: run.error,
    usage: run.usage,
  };
}

export async function agentCancel(
  params: AgentCancelParams,
  authUserId?: string,
): Promise<AgentCancelResult | RpcError> {
  const { runId } = params;

  if (!runId) {
    return createError(ErrorCodes.INVALID_PARAMS, "runId is required");
  }

  if (authUserId) {
    const run = runtime.getRun(runId);
    if (!run || run.userId !== authUserId) {
      return createError(ErrorCodes.UNAUTHORIZED, "Not authorized for this run");
    }
  }

  const cancelled = runtime.cancelRun(runId);
  return { cancelled };
}
