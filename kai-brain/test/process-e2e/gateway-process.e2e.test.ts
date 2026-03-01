import { afterAll, afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createTestJwt } from "../helpers/auth.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { canBindLocalPort } from "../helpers/network.js";
import {
  spawnGatewayProcess,
  stopGatewayProcess,
  type ProcessGatewayInstance,
} from "../helpers/process-gateway.js";
import { db } from "../../src/db/client.js";
import { avaMessages } from "../../src/db/schema/index.js";
import { sessionKeyResolverService } from "../../src/services/session-key-resolver.service.js";
import { closeWebSocket, openWebSocket, rpcCall } from "../helpers/ws.js";

const dbReady = await isTestDatabaseReady();
const canListen = await canBindLocalPort();
const describeIfReady = dbReady && canListen ? describe : describe.skip;

interface ProcessMessage {
  type?: string;
  id?: string;
  event?: string;
  result?: Record<string, unknown>;
  ok?: boolean;
  error?: { code: number; message: string };
  payload?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

function collectProcessMessages(ws: WebSocket): ProcessMessage[] {
  const messages: ProcessMessage[] = [];
  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as ProcessMessage;
      if (parsed.type === "res") {
        messages.push({
          type: parsed.type,
          id: parsed.id,
          ok: parsed.ok,
          result: parsed.payload,
          error: parsed.error,
        });
      } else if (parsed.type === "event") {
        messages.push({
          type: parsed.type,
          event: parsed.event,
          payload: parsed.payload,
        });
      } else {
        messages.push(parsed);
      }
    } catch {
      // Ignore malformed frames in tests.
    }
  });
  return messages;
}

function sendRpcMessage(
  ws: WebSocket,
  params: {
    id: string;
    method: string;
    body?: Record<string, unknown>;
  },
): void {
  ws.send(
    JSON.stringify({
      type: "req",
      id: params.id,
      method: params.method,
      params: params.body ?? {},
    }),
  );
}

async function waitForMessageMatch<T>(
  messages: ProcessMessage[],
  selector: (message: ProcessMessage) => T | undefined,
  opts?: { timeoutMs?: number; pollMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const pollMs = opts?.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const message of messages) {
      const match = selector(message);
      if (typeof match !== "undefined") {
        return match;
      }
    }
    await sleep(pollMs);
  }
  const recent = messages.slice(-20).map((message) => JSON.stringify(message)).join("\n");
  throw new Error(
    `Timed out waiting for message (${opts?.label ?? "unknown"}).\nRecent messages:\n${recent}`,
  );
}

function extractRunIdFromResult(result: Record<string, unknown> | undefined): string {
  const runId = result?.runId;
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error(`Missing runId in result: ${JSON.stringify(result ?? null)}`);
  }
  return runId;
}

describeIfReady("process-e2e: gateway", () => {
  const sessions = new Set<string>();
  const processes: ProcessGatewayInstance[] = [];

  afterEach(async () => {
    while (processes.length > 0) {
      const instance = processes.pop();
      if (instance) {
        await stopGatewayProcess(instance);
      }
    }
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("rejects websocket connections without auth token", async () => {
    const gateway = await spawnGatewayProcess();
    processes.push(gateway);

    const closeInfo = await new Promise<{ code: number; reason: string }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}${gateway.path}`);
        ws.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString("utf8") });
        });
        ws.once("error", (error) => reject(error));
      },
    );

    expect(closeInfo.code).toBe(4401);
    expect(closeInfo.reason.toLowerCase()).toContain("token");
  });

  test("enforces per-user session authorization over real process gateway", async () => {
    const ownerId = uniqueId("process-owner");
    const outsiderId = uniqueId("process-outsider");
    const session = await createTestSession({ userId: ownerId, title: "process-private" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess();
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: outsiderId }) },
    );

    const getResponse = await rpcCall(ws, "sessions.get", {
      sessionKey: identity.sessionKey,
    });
    expect(getResponse.error?.code).toBe(-32001);

    const subscribeResponse = await rpcCall(ws, "subscribe", {
      events: ["agent"],
      sessionKey: identity.sessionKey,
    });
    expect(subscribeResponse.error?.code).toBe(-32001);

    ws.close();
  });

  test("does not lose middle chat delta events when subscribe and send are sent back-to-back", async () => {
    const ownerId = uniqueId("process-owner");
    const session = await createTestSession({ userId: ownerId, title: "process-stream" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "35",
      },
    });
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const messages = collectProcessMessages(ws);

    sendRpcMessage(ws, {
      id: "sub-1",
      method: "subscribe",
      body: {
        events: ["chat"],
        sessionKey: identity.sessionKey,
      },
    });
    sendRpcMessage(ws, {
      id: "run-1",
      method: "chat.send",
      body: {
        sessionKey: identity.sessionKey,
        message: "stream-test",
        idempotencyKey: uniqueId("proc-stream"),
      },
    });

    const subscribeResult = await waitForMessageMatch(
      messages,
      (message) => (message.id === "sub-1" ? message.result : undefined),
      { label: "subscribe response" },
    );
    expect(Array.isArray(subscribeResult?.subscribed)).toBe(true);

    const runResult = await waitForMessageMatch(
      messages,
      (message) => (message.id === "run-1" ? message.result : undefined),
      { label: "run response" },
    );
    const runId = extractRunIdFromResult(runResult);

    await waitForMessageMatch(
      messages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "chat final event" },
    );

    const deltaEvents = messages.filter(
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "delta" &&
        typeof message.payload?.message === "object",
    );
    expect(deltaEvents).toHaveLength(3);

    await closeWebSocket(ws);
  });

  test("returns chat acceptance before completion and emits one final event", async () => {
    const ownerId = uniqueId("process-owner");
    const session = await createTestSession({ userId: ownerId, title: "process-non-blocking-run" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "60",
      },
    });
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const messages = collectProcessMessages(ws);

    sendRpcMessage(ws, {
      id: "sub-fast",
      method: "subscribe",
      body: {
        events: ["chat"],
        sessionKey: identity.sessionKey,
      },
    });

    const acceptedStart = Date.now();
    sendRpcMessage(ws, {
      id: "run-fast",
      method: "chat.send",
      body: {
        sessionKey: identity.sessionKey,
        message: "non-blocking-check",
        idempotencyKey: uniqueId("proc-fast"),
      },
    });

    const runResult = await waitForMessageMatch(
      messages,
      (message) => (message.id === "run-fast" ? message.result : undefined),
      { label: "run accepted response" },
    );
    const acceptanceLatencyMs = Date.now() - acceptedStart;
    const runId = extractRunIdFromResult(runResult);

    expect(["started", "in_flight"]).toContain(runResult?.status);
    expect(acceptanceLatencyMs).toBeLessThan(500);

    await waitForMessageMatch(
      messages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "single chat final event" },
    );

    await sleep(200);
    const completionEvents = messages.filter(
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final",
    );
    expect(completionEvents).toHaveLength(1);

    await closeWebSocket(ws);
  });

  test("processes internal-fallback queue messages proactively without a new user prompt", async () => {
    const ownerId = uniqueId("process-owner");
    const session = await createTestSession({ userId: ownerId, title: "process-internal-fallback-queue" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "35",
      },
    });
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const messages = collectProcessMessages(ws);

    const subscribeResponse = await rpcCall(ws, "subscribe", {
      events: ["chat"],
      sessionKey: identity.sessionKey,
    });
    expect(subscribeResponse.error).toBeUndefined();

    const enqueueResponse = await rpcCall(ws, "queue.enqueue", {
      sessionKey: identity.sessionKey,
      message: "Subagent completion fallback content for proactive websocket handling.",
      source: "heartbeat-internal-fallback",
      mode: "followup",
    });
    expect(enqueueResponse.error).toBeUndefined();

    const finalPayload = await waitForMessageMatch(
      messages,
      (message) =>
        message.event === "chat" &&
        message.payload?.state === "final" &&
        typeof message.payload?.runId === "string"
          ? message.payload
          : undefined,
      { label: "internal fallback final chat event" },
    );
    expect(typeof finalPayload.runId).toBe("string");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.sessionKey).toBe(identity.sessionKey);

    await closeWebSocket(ws);
  });

  test("does not leak session-scoped chat events to subscribers without sessionKey", async () => {
    const ownerId = uniqueId("owner");
    const watcherId = uniqueId("watcher");
    const session = await createTestSession({ userId: ownerId, title: "process-isolation" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "35",
      },
    });
    processes.push(gateway);

    const ownerWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const watcherWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: watcherId }) },
    );

    const ownerMessages = collectProcessMessages(ownerWs);
    const watcherMessages = collectProcessMessages(watcherWs);

    sendRpcMessage(ownerWs, {
      id: "owner-sub",
      method: "subscribe",
      body: { events: ["chat"], sessionKey: identity.sessionKey },
    });
    sendRpcMessage(watcherWs, {
      id: "watcher-sub",
      method: "subscribe",
      body: { events: ["chat"] },
    });
    sendRpcMessage(ownerWs, {
      id: "owner-run",
      method: "chat.send",
      body: {
        sessionKey: identity.sessionKey,
        message: "isolation-test",
        idempotencyKey: uniqueId("proc-isolation"),
      },
    });

    const runResult = await waitForMessageMatch(
      ownerMessages,
      (message) => (message.id === "owner-run" ? message.result : undefined),
      { label: "owner run response" },
    );
    const runId = extractRunIdFromResult(runResult);

    await waitForMessageMatch(
      ownerMessages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "owner final event" },
    );

    await sleep(250);
    const leakedEvents = watcherMessages.filter(
      (message) => message.event === "chat" && message.payload?.runId === runId,
    );
    expect(leakedEvents).toHaveLength(0);

    await closeWebSocket(ownerWs);
    await closeWebSocket(watcherWs);
  });

  test("streams chat events to subscribed peer clients in the same session", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-peer-stream" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "35",
      },
    });
    processes.push(gateway);

    const senderWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const peerWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const senderMessages = collectProcessMessages(senderWs);
    const peerMessages = collectProcessMessages(peerWs);

    await rpcCall(senderWs, "subscribe", {
      events: ["chat"],
      sessionKey: identity.sessionKey,
    });
    await rpcCall(peerWs, "subscribe", {
      events: ["chat"],
      sessionKey: identity.sessionKey,
    });

    const runResponse = await rpcCall(senderWs, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "peer-stream-check",
      idempotencyKey: uniqueId("proc-peer"),
    });
    const runId = extractRunIdFromResult(runResponse.result);

    await waitForMessageMatch(
      senderMessages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "sender final chat event" },
    );
    await waitForMessageMatch(
      peerMessages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "peer final chat event" },
    );

    const senderDeltaCount = senderMessages.filter(
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "delta",
    ).length;
    const peerDeltaCount = peerMessages.filter(
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "delta",
    ).length;

    expect(senderDeltaCount).toBeGreaterThan(0);
    expect(peerDeltaCount).toBe(senderDeltaCount);

    await closeWebSocket(senderWs);
    await closeWebSocket(peerWs);
  });

  test("emits tool events only to clients advertising tool-events capability", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-tool-events-cap" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "30",
      },
    });
    processes.push(gateway);

    const capWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      {
        token: createTestJwt({ sub: ownerId }),
        caps: ["chat.send", "chat.history", "tool-events"],
      },
    );
    const noCapWs = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const capMessages = collectProcessMessages(capWs);
    const noCapMessages = collectProcessMessages(noCapWs);

    await rpcCall(capWs, "subscribe", {
      events: ["chat", "agent"],
      sessionKey: identity.sessionKey,
    });
    await rpcCall(noCapWs, "subscribe", {
      events: ["chat", "agent"],
      sessionKey: identity.sessionKey,
    });

    const runResponse = await rpcCall(capWs, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "tool-events-cap-check",
      idempotencyKey: uniqueId("proc-tool-cap"),
    });
    const runId = extractRunIdFromResult(runResponse.result);

    await waitForMessageMatch(
      capMessages,
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final"
          ? true
          : undefined,
      { label: "cap client final chat event" },
    );

    const capThinkingEvents = capMessages.filter(
      (message) =>
        message.event === "agent" &&
        message.payload?.runId === runId &&
        message.payload?.stream === "thinking",
    );
    expect(capThinkingEvents.length).toBeGreaterThan(0);

    const capToolEvents = capMessages.filter(
      (message) =>
        message.event === "agent" &&
        message.payload?.runId === runId &&
        message.payload?.stream === "tool",
    );

    const capToolPhases = new Set(capToolEvents.map((message) => message.payload?.data?.phase));
    expect(capToolPhases).toEqual(new Set(["call", "result"]));

    const resultEvent = capToolEvents.find((message) => message.payload?.data?.phase === "result");
    expect(resultEvent?.payload?.data?.result).toBeUndefined();

    await sleep(150);
    const noCapToolEvents = noCapMessages.filter(
      (message) =>
        message.event === "agent" &&
        message.payload?.runId === runId,
    );
    expect(noCapToolEvents).toHaveLength(0);

    await closeWebSocket(capWs);
    await closeWebSocket(noCapWs);
  });

  test("rejects malformed chat.send attachments payloads with deterministic invalid-params error", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-chat-attachments-reject" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess();
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const response = await rpcCall(ws, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "attachments-check",
      idempotencyKey: uniqueId("proc-attach"),
      attachments: "not-an-array",
    });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("array");

    await closeWebSocket(ws);
  });

  test("accepts chat.send image attachments and redacts binary data from chat.history", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-chat-attachments-image" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "30",
      },
    });
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const sendResponse = await rpcCall(ws, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "",
      idempotencyKey: uniqueId("proc-attach-image"),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${TEST_PNG_BASE64}`,
        },
      ],
    });
    expect(sendResponse.error).toBeUndefined();
    expect(sendResponse.result?.runId).toBeDefined();

    await db.insert(avaMessages).values({
      sessionId: session.id,
      role: "user",
      content: "",
      metadata: {
        structuredContent: [
          {
            type: "image",
            fileName: "dot.png",
            mimeType: "image/png",
            data: TEST_PNG_BASE64,
          },
        ],
      },
    });

    await sleep(300);
    const historyResponse = await rpcCall(ws, "chat.history", {
      sessionKey: identity.sessionKey,
      limit: 20,
    });
    expect(historyResponse.error).toBeUndefined();
    const messages = Array.isArray(historyResponse.result?.messages)
      ? historyResponse.result?.messages
      : [];
    const userWithImage = messages.find((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        return false;
      }
      return content.some((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const record = block as Record<string, unknown>;
        return record.type === "image" && record.omitted === true && typeof record.bytes === "number";
      });
    });

    expect(userWithImage).toBeDefined();
    const content = (userWithImage as { content?: unknown }).content as Array<Record<string, unknown>>;
    const imageBlock = content.find((block) => block.type === "image");
    expect(imageBlock?.data).toBeUndefined();
    expect(imageBlock?.base64).toBeUndefined();

    await closeWebSocket(ws);
  });

  test("rejects unsupported document attachment types", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-chat-attachments-unsupported-doc" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess();
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const response = await rpcCall(ws, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "",
      idempotencyKey: uniqueId("proc-attach-unsupported"),
      attachments: [
        {
          type: "file",
          mimeType: "application/zip",
          fileName: "archive.zip",
          content: "aGVsbG8=",
        },
      ],
    });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("unsupported");

    await closeWebSocket(ws);
  });

  test("cancels active chat run when final subscriber disconnects", async () => {
    const ownerId = uniqueId("owner");
    const session = await createTestSession({ userId: ownerId, title: "process-disconnect-cancel" });
    sessions.add(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session key");
    }

    const gateway = await spawnGatewayProcess({
      env: {
        AVA_TEST_FAKE_AGENT_MODE: "1",
        AVA_TEST_FAKE_AGENT_DELAY_MS: "80",
      },
    });
    processes.push(gateway);

    const ws = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );

    const subscribeResponse = await rpcCall(ws, "subscribe", {
      events: ["chat"],
      sessionKey: identity.sessionKey,
    });
    expect(subscribeResponse.error).toBeUndefined();

    const runResponse = await rpcCall(ws, "chat.send", {
      sessionKey: identity.sessionKey,
      message: "disconnect-cancel-test",
      idempotencyKey: uniqueId("proc-disconnect"),
    });
    const runId = extractRunIdFromResult(runResponse.result);

    await closeWebSocket(ws);
    await sleep(250);

    const reconnect = await openWebSocket(
      `ws://127.0.0.1:${gateway.port}${gateway.path}`,
      { token: createTestJwt({ sub: ownerId }) },
    );
    const abortResponse = await rpcCall(reconnect, "chat.abort", {
      sessionKey: identity.sessionKey,
      runId,
    });
    // Final-subscriber disconnect should already have cancelled the run.
    expect(abortResponse.result?.aborted).toBe(0);

    await closeWebSocket(reconnect);
  });
});
