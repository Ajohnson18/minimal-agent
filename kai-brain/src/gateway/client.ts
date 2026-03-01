/**
 * Gateway Client
 *
 * Internal client for connecting to the gateway from adapters (Slack, etc.)
 * Uses direct method calls instead of WebSocket for in-process communication.
 */
import { runtime } from "./runtime.js";
import {
  agentRun,
  agentStatus,
  agentCancel,
  sessionsList,
  sessionsGet,
  sessionsReset,
  sessionsDelete,
} from "./methods/index.js";
import type {
  AgentRunParams,
  AgentRunResult,
  AgentStatusParams,
  AgentStatusResult,
  AgentCancelParams,
  AgentCancelResult,
  SessionsListParams,
  SessionsListResult,
  SessionsGetParams,
  SessionsGetResult,
  SessionsResetParams,
  SessionsResetResult,
  SessionsDeleteParams,
  SessionsDeleteResult,
} from "./protocol/methods.js";
import type { GatewayEvent } from "./protocol/events.js";
import type { RpcError } from "./protocol/types.js";

export type EventCallback = (event: GatewayEvent) => void;

class GatewayClient {
  private eventListeners = new Map<string, Set<EventCallback>>();

  // Agent methods
  async agentRun(params: AgentRunParams): Promise<AgentRunResult> {
    const result = await agentRun(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  async agentStatus(params: AgentStatusParams): Promise<AgentStatusResult> {
    const result = await agentStatus(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  async agentCancel(params: AgentCancelParams): Promise<AgentCancelResult> {
    const result = await agentCancel(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  // Session methods
  async sessionsList(
    params: SessionsListParams = {}
  ): Promise<SessionsListResult> {
    const result = await sessionsList(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  async sessionsGet(params: SessionsGetParams): Promise<SessionsGetResult> {
    const result = await sessionsGet(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  async sessionsReset(
    params: SessionsResetParams
  ): Promise<SessionsResetResult> {
    const result = await sessionsReset(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  async sessionsDelete(
    params: SessionsDeleteParams
  ): Promise<SessionsDeleteResult> {
    const result = await sessionsDelete(params);
    if (this.isError(result)) {
      throw new Error(result.message);
    }
    return result;
  }

  // Event subscription (for in-process listeners)
  subscribe(eventType: string, callback: EventCallback): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType)!.add(callback);

    return () => {
      this.eventListeners.get(eventType)?.delete(callback);
    };
  }

  // Called by runtime to notify in-process listeners
  emit(event: GatewayEvent): void {
    const eventType = event.event;

    // Notify exact match listeners
    this.eventListeners.get(eventType)?.forEach((cb) => cb(event));

    // Notify wildcard listeners
    this.eventListeners.get("*")?.forEach((cb) => cb(event));

    // Notify category wildcard (e.g., 'agent.*')
    const category = eventType.split(".")[0];
    this.eventListeners.get(`${category}.*`)?.forEach((cb) => cb(event));
  }

  // Wait for a run to complete
  async waitForRun(
    runId: string,
    options: { timeoutMs?: number; onEvent?: EventCallback } = {}
  ): Promise<AgentStatusResult> {
    const { timeoutMs = 600_000, onEvent } = options;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for run ${runId}`));
      }, timeoutMs);

      const unsubscribe = this.subscribe("*", (event) => {
        // Only forward events for THIS run (prevents cross-session event leaking)
        const eventRunId = "runId" in event.payload ? event.payload.runId : null;
        if (eventRunId && eventRunId !== runId) return;

        onEvent?.(event);

        if (
          (event.event === "agent.completed" ||
            event.event === "agent.error") &&
          eventRunId === runId
        ) {
          clearTimeout(timeout);
          unsubscribe();

          this.agentStatus({ runId }).then(resolve).catch(reject);
        }
      });
    });
  }

  private isError(result: unknown): result is RpcError {
    return (
      typeof result === "object" &&
      result !== null &&
      "code" in result &&
      "message" in result
    );
  }
}

export const gatewayClient = new GatewayClient();

// Hook into runtime to emit events to in-process listeners
const originalBroadcast = runtime.broadcast.bind(runtime);
runtime.broadcast = (event: GatewayEvent, sessionId?: string, opts?: { dropIfSlow?: boolean; includeClientIds?: string[]; stateVersion?: Record<string, number> }) => {
  originalBroadcast(event, sessionId, opts);
  gatewayClient.emit(event);
};
