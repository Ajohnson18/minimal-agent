import { describe, expect, test, vi } from "vitest";

const methodMocks = {
  chatSend: vi.fn(async () => ({ runId: "run-1", status: "started" })),
  chatHistory: vi.fn(async () => ({ sessionKey: "session:main:s1", sessionId: "s1", messages: [] })),
  chatAbort: vi.fn(async () => ({ ok: true, aborted: 1, runIds: ["run-1"] })),
  agentRun: vi.fn(async () => ({ runId: "run-1", status: "accepted" })),
  agentStatus: vi.fn(async () => ({ runId: "run-1", status: "running" })),
  agentCancel: vi.fn(async () => ({ cancelled: true })),
  sessionsList: vi.fn(async () => ({ sessions: [], total: 0 })),
  sessionsPreview: vi.fn(async () => ({ previews: [] })),
  sessionsGet: vi.fn(async () => ({ sessionKey: "session:main:s1", userId: "u1", source: "test", status: "active", messageCount: 0, createdAt: Date.now() })),
  sessionsReset: vi.fn(async () => ({ reset: true, messagesDeleted: 0 })),
  sessionsDelete: vi.fn(async () => ({ deleted: true })),
  subscribe: vi.fn(async () => ({ subscribed: ["agent"] })),
  unsubscribe: vi.fn(async () => ({ unsubscribed: ["agent"] })),
  queueEnqueue: vi.fn(async () => ({ id: "q1", status: "pending", queuedAt: Date.now() })),
  queueStats: vi.fn(async () => ({ pending: 1, processing: 0, completed: 0, error: 0 })),
  queuePending: vi.fn(async () => ({ items: [] })),
  queueCancel: vi.fn(async () => ({ cancelled: 1 })),
  execApprovalRequest: vi.fn(async () => ({ id: "approval-1", status: "accepted" })),
  execApprovalWaitDecision: vi.fn(async () => ({ id: "approval-1", decision: null })),
  execApprovalResolve: vi.fn(async () => ({ ok: true })),
  cronList: vi.fn(async () => ({ jobs: [] })),
  cronAdd: vi.fn(async () => ({ job: { id: "c1" } })),
  cronUpdate: vi.fn(async () => ({ job: { id: "c1", name: "updated" } })),
  cronRemove: vi.fn(async () => ({ deleted: true })),
  cronRun: vi.fn(async () => ({ triggered: true })),
  browserStatus: vi.fn(async () => ({ running: true, tabCount: 1 })),
  browserNavigate: vi.fn(async () => ({ url: "https://example.com", title: "Example" })),
  browserSnapshot: vi.fn(async () => ({ snapshot: "content", refs: {}, url: "https://example.com", title: "Example" })),
  browserAct: vi.fn(async () => ({ result: "ok" })),
  browserScreenshot: vi.fn(async () => ({ base64: "abc", mimeType: "image/png", width: 1, height: 1 })),
  browserTabs: vi.fn(async () => ({ tabs: [] })),
};

const queueProcessorMock = {
  start: vi.fn(),
  stop: vi.fn(),
};

const cronServiceMock = {
  start: vi.fn(),
  stop: vi.fn(),
};

const stopSessionHeartbeatMock = vi.fn();

vi.mock("../../src/gateway/methods/index.js", () => methodMocks);
vi.mock("../../src/gateway/services/queue-processor.js", () => ({
  queueProcessor: queueProcessorMock,
}));
vi.mock("../../src/gateway/services/cron.js", () => ({
  cronService: cronServiceMock,
}));
vi.mock("../../src/gateway/services/heartbeat-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/gateway/services/heartbeat-lifecycle.js")>();
  return {
    ...actual,
    stopSessionHeartbeat: stopSessionHeartbeatMock,
  };
});

import { WebSocket } from "ws";
import { openWebSocket, rpcCall } from "../helpers/ws.js";
import { canBindLocalPort } from "../helpers/network.js";
import { createTestJwt } from "../helpers/auth.js";

const canListen = await canBindLocalPort();
const describeIfNetwork = canListen ? describe : describe.skip;

async function resolveWsPort(wss: {
  address(): string | { port: number } | null;
  once(event: "listening" | "error", cb: (error?: Error) => void): void;
}): Promise<number> {
  const initial = wss.address();
  if (initial && typeof initial !== "string") {
    return initial.port;
  }

  await new Promise<void>((resolve, reject) => {
    const onListening = () => resolve();
    const onError = (error?: Error) =>
      reject(error ?? new Error("websocket listen failed"));
    wss.once("listening", onListening);
    wss.once("error", onError);
  });

  const finalAddress = wss.address();
  if (!finalAddress || typeof finalAddress === "string") {
    throw new Error("Failed to resolve websocket address");
  }

  return finalAddress.port;
}

describeIfNetwork("e2e: gateway rpc", () => {
  test("routes rpc methods and broadcasts subscribed events", async () => {
    vi.resetModules();

    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();
    methodMocks.subscribe.mockImplementation(
      async (params: { events?: string[] }, clientId: string) => ({
        subscribed: runtime.subscribe(clientId, params.events ?? [], "s1"),
      }),
    );
    methodMocks.unsubscribe.mockImplementation(
      async (params: { events?: string[] }, clientId: string) => ({
        unsubscribed: runtime.unsubscribe(clientId, params.events ?? []),
      }),
    );

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`, {
      token: createTestJwt({ sub: "ws-e2e-user" }),
    });

    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [
      {
        method: "chat.send",
        params: {
          sessionKey: "session:main:s1",
          message: "hello",
          idempotencyKey: "idem-gateway-rpc-1",
        },
      },
      { method: "chat.history", params: { sessionKey: "session:main:s1", limit: 20 } },
      { method: "chat.abort", params: { sessionKey: "session:main:s1", runId: "run-1" } },
      { method: "sessions.list", params: {} },
      { method: "sessions.preview", params: {} },
      { method: "sessions.get", params: { sessionKey: "session:main:s1" } },
      { method: "sessions.reset", params: { sessionKey: "session:main:s1" } },
      { method: "sessions.delete", params: { sessionKey: "session:main:s1" } },
      { method: "queue.enqueue", params: { sessionKey: "session:main:s1", userId: "u1", message: "m" } },
      { method: "queue.stats", params: {} },
      { method: "queue.pending", params: { sessionKey: "session:main:s1" } },
      { method: "queue.cancel", params: { sessionKey: "session:main:s1" } },
      {
        method: "exec.approval.request",
        params: {
          sessionKey: "session:main:s1",
          command: "echo hi",
          cwd: "/tmp",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          twoPhase: true,
        },
      },
      { method: "exec.approval.waitDecision", params: { id: "approval-1" } },
      {
        method: "exec.approval.resolve",
        params: { id: "approval-1", decision: "allow-once" },
      },
      { method: "cron.list", params: {} },
      { method: "cron.add", params: { sessionKey: "session:main:s1", userId: "u1", name: "n", scheduleKind: "every", scheduleValue: "1000", payload: "p" } },
      { method: "cron.update", params: { jobId: "c1", name: "updated" } },
      { method: "cron.remove", params: { jobId: "c1" } },
      { method: "cron.run", params: { jobId: "c1" } },
      { method: "browser.status", params: {} },
      { method: "browser.navigate", params: { url: "https://example.com" } },
      { method: "browser.snapshot", params: {} },
      { method: "browser.act", params: { action: { type: "click", ref: "1" } } },
      { method: "browser.screenshot", params: {} },
      { method: "browser.tabs", params: {} },
    ];

    for (const call of calls) {
      const response = await rpcCall(ws, call.method, call.params ?? {});
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
    }

    const subscribeResponse = await rpcCall(ws, "subscribe", {
      events: [
        "agent",
        "exec.approval.requested",
        "exec.approval.resolved",
      ],
      sessionKey: "session:main:s1",
    });
    expect(subscribeResponse.error).toBeUndefined();

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        if (payload.event === "agent") {
          resolve(payload);
        }
      });
    });
    const execEventsPromise = new Promise<void>((resolve) => {
      const seen = new Set<string>();
      ws.on("message", (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        if (
          payload.event === "exec.approval.requested" ||
          payload.event === "exec.approval.resolved"
        ) {
          seen.add(String(payload.event));
          if (
            seen.has("exec.approval.requested") &&
            seen.has("exec.approval.resolved")
          ) {
            resolve();
          }
        }
      });
    });

    runtime.broadcast(
      {
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: "session:main:s1",
          stream: "delta",
          seq: 1,
          ts: Date.now(),
          data: { text: "delta" },
        },
      },
      "s1",
    );

    const eventPayload = await eventPromise;
    expect(eventPayload.event).toBe("agent");

    runtime.broadcast({
      event: "exec.approval.requested",
      payload: {
        id: "approval-evt-1",
        request: {
          sessionKey: "session:main:s1",
          command: "echo hi",
          cwd: "/tmp",
          host: "gateway",
          security: "allowlist",
          ask: "always",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    });
    runtime.broadcast({
      event: "exec.approval.resolved",
      payload: {
        id: "approval-evt-1",
        decision: "allow-once",
        resolvedBy: "ws-e2e-user",
        ts: Date.now(),
      },
    });

    await execEventsPromise;

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    expect(queueProcessorMock.start).toHaveBeenCalledTimes(1);
    expect(cronServiceMock.start).toHaveBeenCalledTimes(1);
    expect(queueProcessorMock.stop).toHaveBeenCalledTimes(1);
    expect(cronServiceMock.stop).toHaveBeenCalledTimes(1);
  });

  test("advertises routed methods and event families in connect handshake", async () => {
    vi.resetModules();

    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${createTestJwt({ sub: "ws-connect-user" })}` },
    });

    const challengeNoncePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("connect.challenge timeout"));
      }, 3_000);

      const onMessage = (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString()) as {
            type?: string;
            event?: string;
            payload?: { nonce?: string };
          };
          if (
            parsed.type === "event" &&
            parsed.event === "connect.challenge" &&
            typeof parsed.payload?.nonce === "string"
          ) {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve(parsed.payload.nonce);
          }
        } catch {
          // ignore non-json frames
        }
      };

      ws.on("message", onMessage);
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    });

    const challengeNonce = await challengeNoncePromise;

    const connectResponse = await rpcCall<{
      connected: boolean;
      methods: string[];
      events: string[];
    }>(ws, "connect", {
      nonce: challengeNonce,
      client: {
        id: "gateway-rpc-contract",
        name: "gateway-rpc-contract",
        version: "1",
        platform: "test",
      },
      caps: ["chat.send", "tool-events"],
    });

    expect(connectResponse.error).toBeUndefined();
    expect(connectResponse.result?.connected).toBe(true);
    expect(connectResponse.result?.methods).toEqual(
      expect.arrayContaining([
        "chat.send",
        "chat.history",
        "chat.abort",
      ]),
    );
    expect(connectResponse.result?.events).toEqual(
      expect.arrayContaining([
        "connect.challenge",
        "chat",
        "agent",
      ]),
    );

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("returns parse error for malformed json payload", async () => {
    vi.resetModules();

    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${createTestJwt({ sub: "ws-e2e-user-2" })}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    });

    const responsePromise = new Promise<{ id: string; error?: { code: number } }>((resolve) => {
      const handler = (data: Buffer) => {
        const parsed = JSON.parse(data.toString()) as {
          type?: string;
          id?: string;
          ok?: boolean;
          error?: { code: number };
        };
        if (parsed.type !== "res") {
          return;
        }
        ws.off("message", handler);
        resolve({ id: parsed.id ?? "unknown", error: parsed.error });
      };
      ws.on("message", handler);
    });

    ws.send("{not-json");
    const response = await responsePromise;

    expect(response.id).toBe("unknown");
    expect(response.error?.code).toBe(-32700);

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("keeps heartbeat alive while another client remains subscribed", async () => {
    vi.resetModules();
    stopSessionHeartbeatMock.mockReset();

    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    methodMocks.subscribe.mockImplementation(
      async (params: { events?: string[] }, clientId: string) => ({
        subscribed: runtime.subscribe(clientId, params.events ?? [], "session-1"),
      }),
    );
    methodMocks.unsubscribe.mockImplementation(
      async (params: { events?: string[] }, clientId: string) => ({
        unsubscribed: runtime.unsubscribe(clientId, params.events ?? []),
      }),
    );

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);

    const wsA = await openWebSocket(`ws://127.0.0.1:${port}/ws`, {
      token: createTestJwt({ sub: "ws-e2e-user-a" }),
    });
    const wsB = await openWebSocket(`ws://127.0.0.1:${port}/ws`, {
      token: createTestJwt({ sub: "ws-e2e-user-b" }),
    });

    await rpcCall(wsA, "subscribe", {
      events: ["agent"],
      sessionKey: "session:main:session-1",
    });
    await rpcCall(wsB, "subscribe", {
      events: ["agent"],
      sessionKey: "session:main:session-1",
    });

    wsA.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stopSessionHeartbeatMock).not.toHaveBeenCalled();

    wsB.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stopSessionHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(stopSessionHeartbeatMock).toHaveBeenCalledWith("session-1");

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("rejects removed external agent methods with migration error", async () => {
    vi.resetModules();

    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`, {
      token: createTestJwt({ sub: "ws-migration-user" }),
    });

    const response = await rpcCall(ws, "agent.run", {
      sessionKey: "session:main:s1",
      message: "legacy",
    });
    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toContain("chat.send");

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
