/**
 * Gateway WebSocket Server
 *
 * Typed-frame WebSocket RPC server for AVA.
 */
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import { runtime } from "./runtime.js";
import {
  isRequestFrame,
  createError,
  createErrorResponse,
  createSuccessResponse,
  ErrorCodes,
  type RequestFrame,
  type ResponseFrame,
} from "./protocol/types.js";
import { GATEWAY_PUBLIC_EVENT_PATTERNS } from "./protocol/events.js";
import { Methods, type ConnectParams, type ConnectResult } from "./protocol/methods.js";
import {
  chatAbort,
  chatHistory,
  chatSend,
  sessionsList,
  sessionsPreview,
  sessionsGet,
  sessionsReset,
  sessionsDelete,
  subscribe,
  unsubscribe,
  queueEnqueue,
  queueStats,
  queuePending,
  queueCancel,
  cronList,
  cronAdd,
  cronUpdate,
  cronRemove,
  cronRun,
  browserStatus,
  browserNavigate,
  browserSnapshot,
  browserAct,
  browserScreenshot,
  browserTabs,
  execApprovalRequest,
  execApprovalWaitDecision,
  execApprovalResolve,
  powersList,
  powersGetDetail,
  powersExecute,
  powersCreate,
  powersUpdate,
  powersDelete,
  powersInstall,
  powersCommunity,
  powersRuns,
  powersCreateFromChat,
  metricsList,
  metricsDelete,
} from "./methods/index.js";
import { queueProcessor } from "./services/queue-processor.js";
import { cronService } from "./services/cron.js";
import { wakeOutboundPump } from "./services/outbound-delivery-pump.js";
import { authenticateGatewayRequest } from "./auth.js";
import { createLogger } from "../lib/logger.js";
import { stopSessionHeartbeat } from "./services/heartbeat-lifecycle.js";

const log = createLogger("gateway", { component: "server" });

type MethodRouteContext = {
  clientId: string;
  authUserId?: string;
};

type MethodRouteHandler = (
  params: Record<string, unknown>,
  context: MethodRouteContext,
) => Promise<unknown> | unknown;

export interface GatewayServerOptions {
  server?: Server;
  port?: number;
  path?: string;
}

const REMOVED_EXTERNAL_METHODS = new Set<string>([
  Methods.AGENT_RUN,
  Methods.AGENT_STATUS,
  Methods.AGENT_CANCEL,
]);

const METHOD_ROUTES: Array<[string, MethodRouteHandler]> = [
  [
    Methods.CHAT_SEND,
    (params, context) =>
      chatSend(params as unknown as Parameters<typeof chatSend>[0], context.clientId, context.authUserId),
  ],
  [
    Methods.CHAT_HISTORY,
    (params, context) =>
      chatHistory(params as unknown as Parameters<typeof chatHistory>[0], context.authUserId),
  ],
  [
    Methods.CHAT_ABORT,
    (params, context) =>
      chatAbort(params as unknown as Parameters<typeof chatAbort>[0], context.authUserId),
  ],
  [
    Methods.SESSIONS_LIST,
    (params, context) =>
      sessionsList(params as unknown as Parameters<typeof sessionsList>[0], context.authUserId),
  ],
  [
    Methods.SESSIONS_PREVIEW,
    (params, context) =>
      sessionsPreview(params as unknown as Parameters<typeof sessionsPreview>[0], context.authUserId),
  ],
  [
    Methods.SESSIONS_GET,
    (params, context) =>
      sessionsGet(params as unknown as Parameters<typeof sessionsGet>[0], context.authUserId),
  ],
  [
    Methods.SESSIONS_RESET,
    (params, context) =>
      sessionsReset(params as unknown as Parameters<typeof sessionsReset>[0], context.authUserId),
  ],
  [
    Methods.SESSIONS_DELETE,
    (params, context) =>
      sessionsDelete(params as unknown as Parameters<typeof sessionsDelete>[0], context.authUserId),
  ],
  [
    Methods.SUBSCRIBE,
    (params, context) =>
      subscribe(params as unknown as Parameters<typeof subscribe>[0], context.clientId, context.authUserId),
  ],
  [
    Methods.UNSUBSCRIBE,
    (params, context) =>
      unsubscribe(params as unknown as Parameters<typeof unsubscribe>[0], context.clientId),
  ],
  [
    Methods.QUEUE_ENQUEUE,
    (params, context) =>
      queueEnqueue(params as unknown as Parameters<typeof queueEnqueue>[0], context.authUserId),
  ],
  [
    Methods.QUEUE_STATS,
    (params, context) =>
      queueStats(params as unknown as Parameters<typeof queueStats>[0], context.authUserId),
  ],
  [
    Methods.QUEUE_PENDING,
    (params, context) =>
      queuePending(params as unknown as Parameters<typeof queuePending>[0], context.authUserId),
  ],
  [
    Methods.QUEUE_CANCEL,
    (params, context) =>
      queueCancel(params as unknown as Parameters<typeof queueCancel>[0], context.authUserId),
  ],
  [
    Methods.CRON_LIST,
    (params, context) =>
      cronList(params as unknown as Parameters<typeof cronList>[0], context.authUserId),
  ],
  [
    Methods.CRON_ADD,
    (params, context) =>
      cronAdd(params as unknown as Parameters<typeof cronAdd>[0], context.authUserId),
  ],
  [
    Methods.CRON_UPDATE,
    (params, context) =>
      cronUpdate(params as unknown as Parameters<typeof cronUpdate>[0], context.authUserId),
  ],
  [
    Methods.CRON_REMOVE,
    (params, context) =>
      cronRemove(params as unknown as Parameters<typeof cronRemove>[0], context.authUserId),
  ],
  [
    Methods.CRON_RUN,
    (params, context) =>
      cronRun(params as unknown as Parameters<typeof cronRun>[0], context.authUserId),
  ],
  [
    Methods.BROWSER_STATUS,
    () => browserStatus(),
  ],
  [
    Methods.BROWSER_NAVIGATE,
    (params) => browserNavigate(params as unknown as Parameters<typeof browserNavigate>[0]),
  ],
  [
    Methods.BROWSER_SNAPSHOT,
    (params) => browserSnapshot(params as unknown as Parameters<typeof browserSnapshot>[0]),
  ],
  [
    Methods.BROWSER_ACT,
    (params) => browserAct(params as unknown as Parameters<typeof browserAct>[0]),
  ],
  [
    Methods.BROWSER_SCREENSHOT,
    (params) => browserScreenshot(params as unknown as Parameters<typeof browserScreenshot>[0]),
  ],
  [
    Methods.BROWSER_TABS,
    (params) => browserTabs(params as unknown as Parameters<typeof browserTabs>[0]),
  ],
  [
    Methods.EXEC_APPROVAL_REQUEST,
    (params, context) =>
      execApprovalRequest(params as unknown as Parameters<typeof execApprovalRequest>[0], context.authUserId),
  ],
  [
    Methods.EXEC_APPROVAL_WAIT_DECISION,
    (params) =>
      execApprovalWaitDecision(params as unknown as Parameters<typeof execApprovalWaitDecision>[0]),
  ],
  [
    Methods.EXEC_APPROVAL_RESOLVE,
    (params, context) =>
      execApprovalResolve(params as unknown as Parameters<typeof execApprovalResolve>[0], context.authUserId),
  ],
  [
    Methods.POWERS_LIST,
    (params, context) =>
      powersList(params as unknown as Parameters<typeof powersList>[0], context.authUserId),
  ],
  [
    Methods.POWERS_GET_DETAIL,
    (params, context) =>
      powersGetDetail(params as unknown as Parameters<typeof powersGetDetail>[0], context.authUserId),
  ],
  [
    Methods.POWERS_EXECUTE,
    (params, context) =>
      powersExecute(params as unknown as Parameters<typeof powersExecute>[0], context.authUserId),
  ],
  [
    Methods.POWERS_CREATE,
    (params, context) =>
      powersCreate(params as unknown as Parameters<typeof powersCreate>[0], context.authUserId),
  ],
  [
    Methods.POWERS_UPDATE,
    (params, context) =>
      powersUpdate(params as unknown as Parameters<typeof powersUpdate>[0], context.authUserId),
  ],
  [
    Methods.POWERS_DELETE,
    (params, context) =>
      powersDelete(params as unknown as Parameters<typeof powersDelete>[0], context.authUserId),
  ],
  [
    Methods.POWERS_INSTALL,
    (params, context) =>
      powersInstall(params as unknown as Parameters<typeof powersInstall>[0], context.authUserId),
  ],
  [
    Methods.POWERS_COMMUNITY,
    (params, context) =>
      powersCommunity(params as unknown as Parameters<typeof powersCommunity>[0], context.authUserId),
  ],
  [
    Methods.POWERS_RUNS,
    (params, context) =>
      powersRuns(params as unknown as Parameters<typeof powersRuns>[0], context.authUserId),
  ],
  [
    Methods.POWERS_CREATE_FROM_CHAT,
    (params, context) =>
      powersCreateFromChat(params as unknown as Parameters<typeof powersCreateFromChat>[0], context.authUserId),
  ],
  [
    Methods.METRICS_LIST,
    (params, context) =>
      metricsList(params as unknown as Parameters<typeof metricsList>[0], context.authUserId),
  ],
  [
    Methods.METRICS_DELETE,
    (params, context) =>
      metricsDelete(params as unknown as Parameters<typeof metricsDelete>[0], context.authUserId),
  ],
];

const METHOD_ROUTE_MAP = new Map<string, MethodRouteHandler>(METHOD_ROUTES);
const PUBLIC_METHODS = Object.freeze([
  Methods.CONNECT,
  ...METHOD_ROUTES.map(([method]) => method),
]);
const PUBLIC_EVENTS = Object.freeze([...GATEWAY_PUBLIC_EVENT_PATTERNS]);

export function listPublicGatewayMethods(): string[] {
  return [...PUBLIC_METHODS];
}

export function listPublicGatewayEvents(): string[] {
  return [...PUBLIC_EVENTS];
}

export function createGatewayServer(
  options: GatewayServerOptions = {},
): WebSocketServer {
  const { server, port = 18789, path = "/ws" } = options;

  const wss = server
    ? new WebSocketServer({ server, path })
    : new WebSocketServer({ port, path });

  log.info(
    {
      mode: server ? "attached" : "standalone",
      port,
      path,
    },
    "Gateway WebSocket server started",
  );

  // Start queue processor and cron service
  queueProcessor.start();
  cronService.start();
  wakeOutboundPump("gateway-startup", 0);

  // Ensure background services are stopped when the WS server is closed.
  wss.once("close", () => {
    queueProcessor.stop();
    cronService.stop();
  });

  wss.on("connection", (ws: WebSocket, request) => {
    const authResult = authenticateGatewayRequest(request);
    if (!authResult.ok) {
      ws.close(4401, authResult.reason);
      return;
    }

    const client = runtime.addClient(ws, authResult.auth);
    const connectNonce = randomUUID();
    let handshakeComplete = false;
    let cleanedUp = false;
    let requestChain = Promise.resolve();

    runtime.sendEventToClient(client.id, "connect.challenge", {
      nonce: connectNonce,
      ts: Date.now(),
    });

    const cleanupClientConnection = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      const clientData = runtime.getClient(client.id);
      if (clientData) {
        for (const sessionId of clientData.sessionSubscriptions) {
          if (!runtime.hasOtherSessionSubscribers(sessionId, client.id)) {
            stopSessionHeartbeat(sessionId);
            const cancelledRuns = runtime.cancelRunsForSession(sessionId);
            if (cancelledRuns > 0) {
              log.info(
                { sessionId, cancelledRuns, clientId: client.id },
                "Cancelled active runs after final session subscriber disconnected",
              );
            }
          }
        }
      }
      runtime.removeClient(client.id);
    };

    const sendWsPayload = (payload: ResponseFrame): void => {
      if (ws.readyState !== 1) {
        return;
      }
      ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          log.warn(
            { err: error, clientId: client.id },
            "Failed to send websocket response",
          );
        }
      });
    };

    ws.on("message", (data: Buffer) => {
      requestChain = requestChain
        .then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString());
          } catch (error) {
            log.warn({ err: error, clientId: client.id }, "Failed to parse incoming WS message");
            sendWsPayload(
              createErrorResponse(
                "unknown",
                createError(ErrorCodes.PARSE_ERROR, "Invalid JSON"),
              ),
            );
            return;
          }

          const response = await handleRequest({
            message: parsed,
            clientId: client.id,
            handshakeComplete,
            connectNonce,
          });

          if (
            response.id &&
            response.id !== "unknown" &&
            response.ok &&
            isConnectMethodFrame(parsed)
          ) {
            handshakeComplete = true;
            runtime.markClientConnected(client.id, {
              caps: resolveConnectCaps(parsed.params),
              clientMeta: resolveConnectClientMeta(parsed.params),
            });
          }

          sendWsPayload(response);
        })
        .catch((error) => {
          log.error(
            { err: error, clientId: client.id },
            "Gateway request serialization chain failed",
          );
        });
    });

    ws.on("close", () => {
      cleanupClientConnection();
    });

    ws.on("error", (error) => {
      log.error({ err: error, clientId: client.id }, "WebSocket client error");
      cleanupClientConnection();
    });
  });

  return wss;
}

function isConnectMethodFrame(message: unknown): message is RequestFrame {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as RequestFrame).type === "req" &&
    (message as RequestFrame).method === Methods.CONNECT
  );
}

function resolveConnectCaps(params: unknown): string[] {
  if (!params || typeof params !== "object") {
    return [];
  }
  const raw = (params as { caps?: unknown }).caps;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function resolveConnectClientMeta(
  params: unknown,
): {
  id?: string;
  name?: string;
  version?: string;
  platform?: string;
} | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const client = (params as { client?: unknown }).client;
  if (!client || typeof client !== "object") {
    return undefined;
  }
  const record = client as Record<string, unknown>;
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.platform === "string" ? { platform: record.platform } : {}),
  };
}

async function handleRequest(args: {
  message: unknown;
  clientId: string;
  handshakeComplete: boolean;
  connectNonce: string;
}): Promise<ResponseFrame> {
  const client = runtime.getClient(args.clientId);
  if (!client) {
    return createErrorResponse(
      "unknown",
      createError(ErrorCodes.UNAUTHORIZED, "Unauthenticated client"),
    );
  }

  if (!isRequestFrame(args.message)) {
    return createErrorResponse(
      "unknown",
      createError(ErrorCodes.INVALID_REQUEST, "Invalid request frame format"),
    );
  }

  const { id, method, params = {} } = args.message;

  // Handshake gate: connect must be the first successful method call.
  if (!args.handshakeComplete && method !== Methods.CONNECT) {
    return createErrorResponse(
      id,
      createError(
        ErrorCodes.UNAUTHORIZED,
        "connect handshake required before method execution",
      ),
    );
  }

  if (method === Methods.CONNECT) {
    return handleConnect(id, params, args.connectNonce);
  }

  try {
    const result = await routeMethod(method, params, args.clientId, client.auth?.userId);

    // Method handlers return RpcError objects on failure; normalize to typed response.
    if (
      result &&
      typeof result === "object" &&
      "code" in result &&
      "message" in result &&
      typeof (result as { code: unknown }).code === "number"
    ) {
      return createErrorResponse(id, result as { code: number; message: string; data?: unknown });
    }

    return createSuccessResponse(id, result);
  } catch (error) {
    log.error({ err: error, method, clientId: args.clientId }, "Error handling gateway method");
    return createErrorResponse(
      id,
      createError(
        ErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : "Internal error",
      ),
    );
  }
}

function handleConnect(
  id: string,
  params: Record<string, unknown>,
  expectedNonce: string,
): ResponseFrame {
  const nonce = typeof params.nonce === "string" ? params.nonce.trim() : "";
  if (!nonce) {
    return createErrorResponse(
      id,
      createError(ErrorCodes.INVALID_PARAMS, "connect.nonce is required"),
    );
  }
  if (nonce !== expectedNonce) {
    return createErrorResponse(
      id,
      createError(ErrorCodes.UNAUTHORIZED, "connect nonce mismatch"),
    );
  }

  const _validatedConnectParams: ConnectParams = {
    nonce,
    ...(typeof params.client === "object" && params.client !== null
      ? { client: params.client as ConnectParams["client"] }
      : {}),
    ...(Array.isArray(params.caps) ? { caps: params.caps as string[] } : {}),
  };
  if (!_validatedConnectParams.nonce) {
    return createErrorResponse(
      id,
      createError(ErrorCodes.INVALID_PARAMS, "connect.nonce is required"),
    );
  }
  const payload: ConnectResult = {
    connected: true,
    serverTime: Date.now(),
    methods: [...PUBLIC_METHODS],
    events: [...PUBLIC_EVENTS],
  };
  return createSuccessResponse(id, payload);
}

async function routeMethod(
  method: string,
  params: Record<string, unknown>,
  clientId: string,
  authUserId?: string,
): Promise<unknown> {
  if (REMOVED_EXTERNAL_METHODS.has(method)) {
    return createError(
      ErrorCodes.METHOD_NOT_FOUND,
      `Method ${method} was removed from external WS API; use chat.send/chat.history/chat.abort`,
    );
  }

  const handler = METHOD_ROUTE_MAP.get(method);
  if (!handler) {
    return createError(
      ErrorCodes.METHOD_NOT_FOUND,
      `Method ${method} not found`,
    );
  }

  return handler(params, { clientId, authUserId });
}

export { runtime } from "./runtime.js";
