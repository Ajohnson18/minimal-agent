/**
 * Gateway Method Registry
 *
 * WebSocket API contract for typed-frame RPC methods.
 */

export const Methods = {
  // Connection lifecycle
  CONNECT: "connect",

  // Chat-native methods (primary Web UI flow)
  CHAT_SEND: "chat.send",
  CHAT_HISTORY: "chat.history",
  CHAT_ABORT: "chat.abort",

  // Legacy agent methods (removed from external WS surface)
  AGENT_RUN: "agent.run",
  AGENT_STATUS: "agent.status",
  AGENT_CANCEL: "agent.cancel",

  // Session methods
  SESSIONS_LIST: "sessions.list",
  SESSIONS_PREVIEW: "sessions.preview",
  SESSIONS_GET: "sessions.get",
  SESSIONS_RESET: "sessions.reset",
  SESSIONS_DELETE: "sessions.delete",

  // Cron methods
  CRON_LIST: "cron.list",
  CRON_ADD: "cron.add",
  CRON_UPDATE: "cron.update",
  CRON_REMOVE: "cron.remove",
  CRON_RUN: "cron.run",

  // Browser methods
  BROWSER_STATUS: "browser.status",
  BROWSER_NAVIGATE: "browser.navigate",
  BROWSER_SNAPSHOT: "browser.snapshot",
  BROWSER_ACT: "browser.act",
  BROWSER_SCREENSHOT: "browser.screenshot",
  BROWSER_TABS: "browser.tabs",

  // Queue methods
  QUEUE_ENQUEUE: "queue.enqueue",
  QUEUE_STATS: "queue.stats",
  QUEUE_PENDING: "queue.pending",
  QUEUE_CANCEL: "queue.cancel",

  // Exec approval methods
  EXEC_APPROVAL_REQUEST: "exec.approval.request",
  EXEC_APPROVAL_WAIT_DECISION: "exec.approval.waitDecision",
  EXEC_APPROVAL_RESOLVE: "exec.approval.resolve",

  // Powers methods
  POWERS_LIST: "powers.list",
  POWERS_GET_DETAIL: "powers.getDetail",
  POWERS_EXECUTE: "powers.execute",
  POWERS_CREATE: "powers.create",
  POWERS_UPDATE: "powers.update",
  POWERS_DELETE: "powers.delete",
  POWERS_INSTALL: "powers.install",
  POWERS_COMMUNITY: "powers.community",
  POWERS_RUNS: "powers.runs",
  POWERS_CREATE_FROM_CHAT: "powers.createFromChat",

  // Metrics methods
  METRICS_LIST: "metrics.list",
  METRICS_DELETE: "metrics.delete",

  // Subscription methods
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

export interface ConnectParams {
  nonce: string;
  client?: {
    id?: string;
    name?: string;
    version?: string;
    platform?: string;
  };
  caps?: string[];
}

export interface ConnectResult {
  connected: true;
  serverTime: number;
  methods: string[];
  events: string[];
}

// Chat method params/results
export interface ChatSendParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
  attachments?: unknown[];
}

export type ChatSendStatus = "started" | "in_flight" | "ok" | "error";

export interface ChatSendResult {
  runId: string;
  status: ChatSendStatus;
}

export interface ChatHistoryParams {
  sessionKey: string;
  limit?: number;
}

export interface ChatHistoryResult {
  sessionKey: string;
  sessionId?: string;
  messages: unknown[];
  thinkingLevel?: string;
  verboseLevel?: string;
}

export interface ChatAbortParams {
  sessionKey: string;
  runId?: string;
}

export interface ChatAbortResult {
  ok: true;
  aborted: number;
  runIds: string[];
}

// Legacy agent method params/results
export interface AgentRunParams {
  sessionKey: string;
  message: string;
  /**
   * @deprecated Ignored when gateway auth context is present.
   */
  userId?: string;
  contextSummary?: string;
}

export interface AgentRunResult {
  runId: string;
  status: "accepted";
  acceptedAt: number;
}

export interface AgentStatusParams {
  runId: string;
}

export interface AgentStatusResult {
  runId: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  startedAt?: number;
  completedAt?: number;
  content?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AgentCancelParams {
  runId: string;
}

export interface AgentCancelResult {
  cancelled: boolean;
}

// Session method params/results
export interface SessionsListParams {
  /**
   * @deprecated Ignored when gateway auth context is present.
   */
  userId?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface SessionInfo {
  sessionKey: string;
  userId: string;
  source: string;
  title?: string;
  status: string;
  messageCount: number;
  tokenCount?: number;
  createdAt: number;
  lastMessageAt?: number;
}

export interface SessionsListResult {
  sessions: SessionInfo[];
  total: number;
}

export interface SessionsPreviewParams {
  keys?: string[];
  limit?: number;
  source?: string;
}

export interface SessionPreview {
  sessionKey: string;
  title?: string;
  source: string;
  status: string;
  lastMessageAt?: number;
  preview?: string;
}

export interface SessionsPreviewResult {
  previews: SessionPreview[];
}

export interface SessionsGetParams {
  sessionKey: string;
}

export interface SessionsGetResult extends SessionInfo {
  externalId?: string;
}

export interface SessionsResetParams {
  sessionKey: string;
}

export interface SessionsResetResult {
  reset: boolean;
  messagesDeleted: number;
}

export interface SessionsDeleteParams {
  sessionKey: string;
}

export interface SessionsDeleteResult {
  deleted: boolean;
}

// Subscription params
export interface SubscribeParams {
  events: string[];
  sessionKey?: string;
}

export interface SubscribeResult {
  subscribed: string[];
}

export interface UnsubscribeParams {
  events: string[];
}

export interface UnsubscribeResult {
  unsubscribed: string[];
}

// Exec approval params/results
export interface ExecApprovalRequestParams {
  id?: string;
  sessionKey: string;
  command: string;
  cwd: string;
  host: "sandbox" | "gateway" | "node";
  security: "deny" | "allowlist" | "full";
  ask: "on-miss" | "always";
  timeoutMs?: number;
  userId?: string;
  agentId?: string;
  resolvedPath?: string;
  twoPhase?: boolean;
}

export interface ExecApprovalRequestResult {
  id: string;
  sessionKey?: string;
  decision?: "allow-once" | "allow-always" | "deny" | null;
  status?: "accepted";
  createdAtMs?: number;
  expiresAtMs?: number;
}

export interface ExecApprovalWaitDecisionParams {
  id: string;
}

export interface ExecApprovalWaitDecisionResult {
  id: string;
  sessionKey?: string;
  decision: "allow-once" | "allow-always" | "deny" | null;
}

export interface ExecApprovalResolveParams {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
}

export interface ExecApprovalResolveResult {
  ok: boolean;
}

// Powers method params/results
export interface PowersListParams {
  category?: string;
}

export interface PowersListResult {
  powers: Array<{
    id: string;
    name: string;
    description: string;
    fileName: string;
    icon: string;
    category: string;
    source: string;
    enabled: boolean;
    dependsOn: string[];
    skills: string[];
    tools: string[];
    steps: string[];
    artifacts: Array<{ key: string; label: string; type: string }>;
    output: string;
    available: boolean;
    missingIntegrations: string[];
  }>;
}

export interface PowersGetDetailParams {
  powerId: string;
}

export interface PowersGetDetailResult {
  power: PowersListResult["powers"][0] & {
    prompt: string;
    locked: boolean;
  };
  versions: Array<{
    id: string;
    prompt: string;
    changeNote: string;
    createdAt: number;
  }>;
}

export interface PowersExecuteParams {
  powerId: string;
  sessionKey: string;
  params?: Record<string, string>;
}

export interface PowersExecuteResult {
  runId: string;
  status: "accepted";
  acceptedAt: number;
}

export interface PowersCreateParams {
  name: string;
  description: string;
  icon?: string;
  category?: string;
  dependsOn?: string[];
  skills?: string[];
  tools?: string[];
  steps?: string[];
  output?: string;
}

export interface PowersCreateResult {
  power: PowersListResult["powers"][0];
}

export interface PowersUpdateParams {
  powerId: string;
  name?: string;
  description?: string;
  icon?: string;
  category?: string;
  dependsOn?: string[];
  skills?: string[];
  tools?: string[];
  steps?: string[];
  artifacts?: Array<{ key: string; label: string; type: string }>;
  output?: string;
  prompt?: string;
}

export interface PowersUpdateResult {
  power: PowersListResult["powers"][0];
}

export interface PowersDeleteParams {
  powerId: string;
}

export interface PowersDeleteResult {
  deleted: boolean;
}

export interface PowersInstallParams {
  powerId: string;
}

export interface PowersInstallResult {
  power: PowersListResult["powers"][0];
}

export interface PowersCommunityParams {}

export interface PowersCommunityResult {
  powers: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    dependsOn: string[];
    steps: string[];
    installed: boolean;
  }>;
}

export interface PowersRunsParams {
  limit?: number;
  powerId?: string;
}

export interface PowersRunsResult {
  runs: Array<{
    id: string;
    powerId: string;
    powerName: string;
    runId: string;
    status: string;
    startedAt: number;
    completedAt: number | null;
    error: string | null;
    result: unknown | null;
  }>;
}

export interface PowersCreateFromChatParams {
  sessionKey: string;
}

export interface PowersCreateFromChatResult {
  power: PowersListResult["powers"][0];
}

// Metrics method params/results
export interface MetricsListParams {
  powerId?: string;
}

export interface MetricInfo {
  id: string;
  powerId: string;
  powerName: string;
  key: string;
  label: string;
  artifactType: string;
  data: unknown;
  icon: string | null;
  lastRunId: string | null;
  updatedAt: number;
  createdAt: number;
}

export interface MetricsListResult {
  metrics: MetricInfo[];
}

export interface MetricsDeleteParams {
  id: string;
}

export interface MetricsDeleteResult {
  deleted: boolean;
}
