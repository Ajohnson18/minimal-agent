/**
 * Gateway Event Types
 *
 * Events pushed from server to connected clients.
 */

/**
 * Event families surfaced to clients in the `connect` handshake response.
 * Keep this list aligned with externally-broadcast gateway events.
 */
export const GATEWAY_PUBLIC_EVENT_PATTERNS = [
  "connect.challenge",
  "chat",
  "agent",
  "agent.*",
  "session.*",
  "cron.*",
  "exec.approval.*",
] as const;

export type ChatState = "delta" | "final" | "aborted" | "error";

export interface ConnectChallengeEvent {
  event: "connect.challenge";
  payload: {
    nonce: string;
    ts: number;
  };
}

export interface ChatEvent {
  event: "chat";
  payload: {
    runId: string;
    sessionKey: string;
    seq: number;
    state: ChatState;
    message?: unknown;
    errorMessage?: string;
    usage?: unknown;
    stopReason?: string;
  };
}

export interface AgentStreamEvent {
  event: "agent";
  payload: {
    runId: string;
    sessionKey?: string;
    stream: string;
    seq: number;
    ts: number;
    data?: Record<string, unknown>;
  };
}

export type AgentEventType =
  | "agent.started"
  | "agent.thinking"
  | "agent.chunk"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.completed"
  | "agent.error";

export type CronEventType = "cron.fired" | "cron.completed" | "cron.error";

export type SessionEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted";

export type ExecApprovalEventType =
  | "exec.approval.requested"
  | "exec.approval.resolved";

export type SkillTreeEventType = "skill-tree.updated";

export type GatewayEventType =
  | "connect.challenge"
  | "chat"
  | "agent"
  | AgentEventType
  | CronEventType
  | SessionEventType
  | ExecApprovalEventType
  | SkillTreeEventType;

export interface AgentStartedEvent {
  event: "agent.started";
  payload: {
    runId: string;
    sessionKey: string;
    startedAt: number;
  };
}

export interface AgentThinkingEvent {
  event: "agent.thinking";
  payload: {
    runId: string;
    text?: string;
    delta?: string;
  };
}

export interface AgentChunkEvent {
  event: "agent.chunk";
  payload: {
    runId: string;
    text: string;
  };
}

export interface AgentToolCallEvent {
  event: "agent.tool_call";
  payload: {
    runId: string;
    toolName: string;
    args: unknown;
  };
}

export interface AgentToolResultEvent {
  event: "agent.tool_result";
  payload: {
    runId: string;
    toolName: string;
    result: unknown;
  };
}

export interface AgentCompletedEvent {
  event: "agent.completed";
  payload: {
    runId: string;
    sessionKey: string;
    content: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    completedAt: number;
  };
}

export interface AgentErrorEvent {
  event: "agent.error";
  payload: {
    runId: string;
    sessionKey: string;
    error: string;
    errorAt: number;
  };
}

export interface CronFiredEvent {
  event: "cron.fired";
  payload: {
    jobId: string;
    sessionKey: string;
    firedAt: number;
  };
}

export interface SessionCreatedEvent {
  event: "session.created";
  payload: {
    sessionKey: string;
    userId: string;
    source: string;
    createdAt: number;
  };
}

export interface ExecApprovalRequestedEvent {
  event: "exec.approval.requested";
  payload: {
    id: string;
    request: {
      sessionKey: string;
      command: string;
      cwd: string;
      host: "sandbox" | "gateway" | "node";
      security: "deny" | "allowlist" | "full";
      ask: "on-miss" | "always";
      userId?: string;
      agentId?: string;
      resolvedPath?: string;
    };
    createdAtMs: number;
    expiresAtMs: number;
  };
}

export interface ExecApprovalResolvedEvent {
  event: "exec.approval.resolved";
  payload: {
    id: string;
    decision: "allow-once" | "allow-always" | "deny" | "timeout" | "error";
    resolvedBy?: string;
    ts: number;
  };
}

export interface SkillTreeUpdatedEvent {
  event: "skill-tree.updated";
  payload: {
    nodeId: string;
    action: "registered" | "updated" | "removed";
  };
}

export type GatewayEvent =
  | ConnectChallengeEvent
  | ChatEvent
  | AgentStreamEvent
  | AgentStartedEvent
  | AgentThinkingEvent
  | AgentChunkEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentCompletedEvent
  | AgentErrorEvent
  | CronFiredEvent
  | SessionCreatedEvent
  | ExecApprovalRequestedEvent
  | ExecApprovalResolvedEvent
  | SkillTreeUpdatedEvent;
