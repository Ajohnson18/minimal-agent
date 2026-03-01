import { afterEach, describe, expect, test, vi } from "vitest";

import { WebSocket } from "ws";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { canBindLocalPort } from "../helpers/network.js";
import { createTestJwt } from "../helpers/auth.js";
import { openWebSocket, rpcCall } from "../helpers/ws.js";
import { sessionKeyResolverService } from "../../src/services/session-key-resolver.service.js";

const dbReady = await isTestDatabaseReady();
const canListen = await canBindLocalPort();
const describeIfReady = dbReady && canListen ? describe : describe.skip;

async function resolveWsPort(wss: {
  address(): string | { port: number } | null;
  once(event: "listening" | "error", cb: (error?: Error) => void): void;
}): Promise<number> {
  const currentAddress = wss.address();
  if (currentAddress && typeof currentAddress !== "string") {
    return currentAddress.port;
  }

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (error?: Error) => reject(error ?? new Error("ws error")));
  });

  const finalAddress = wss.address();
  if (!finalAddress || typeof finalAddress === "string") {
    throw new Error("Failed to resolve websocket port");
  }

  return finalAddress.port;
}

describeIfReady("e2e: gateway authz", () => {
  const cleanupSessionIds = new Set<string>();

  afterEach(async () => {
    for (const sessionId of cleanupSessionIds) {
      await deleteSession(sessionId);
    }
    cleanupSessionIds.clear();
  });

  test("rejects websocket connection without token", async () => {
    vi.resetModules();
    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);

    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
      ws.once("error", (error) => reject(error));
    });

    expect(closeInfo.code).toBe(4401);
    expect(closeInfo.reason).toContain("bearer token");

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("blocks cross-user access to sessions and queue", async () => {
    vi.resetModules();
    const { createGatewayServer, runtime } = await import("../../src/gateway/server.js");
    runtime.resetForTests();

    const ownerId = uniqueId("owner");
    const outsiderId = uniqueId("outsider");
    const session = await createTestSession({ userId: ownerId, title: "private" });
    cleanupSessionIds.add(session.id);
    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session identity");
    }

    const token = createTestJwt({ sub: outsiderId });

    const wss = createGatewayServer({ port: 0, path: "/ws" });
    const port = await resolveWsPort(wss as never);

    const ws = await openWebSocket(`ws://127.0.0.1:${port}/ws`, { token });

    const sessionIdOnlyResponse = await rpcCall(ws, "sessions.get", {
      sessionId: session.id,
    });
    expect(sessionIdOnlyResponse.error?.code).toBe(-32602);

    const queueSessionIdOnlyResponse = await rpcCall(ws, "queue.enqueue", {
      sessionId: session.id,
      userId: outsiderId,
      message: "run this",
    });
    expect(queueSessionIdOnlyResponse.error?.code).toBe(-32602);

    const subscribeSessionIdOnlyResponse = await rpcCall(ws, "subscribe", {
      events: ["agent.*"],
      sessionId: session.id,
    });
    expect(subscribeSessionIdOnlyResponse.error?.code).toBe(-32602);

    const approvalSessionIdOnlyResponse = await rpcCall(ws, "exec.approval.request", {
      sessionId: session.id,
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "always",
      twoPhase: true,
    });
    expect(approvalSessionIdOnlyResponse.error?.code).toBe(-32602);

    const sessionResponse = await rpcCall(ws, "sessions.get", {
      sessionKey: identity.sessionKey,
    });
    expect(sessionResponse.error?.code).toBe(-32001);

    const subscribeResponse = await rpcCall(ws, "subscribe", {
      events: ["agent.*"],
      sessionKey: identity.sessionKey,
    });
    expect(subscribeResponse.error?.code).toBe(-32001);

    const queueResponse = await rpcCall(ws, "queue.enqueue", {
      sessionKey: identity.sessionKey,
      userId: outsiderId,
      message: "run this",
    });
    expect(queueResponse.error?.code).toBe(-32001);

    ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
