import { afterAll, describe, expect, test } from "vitest";
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
} from "../helpers/process-gateway.js";
import { sessionKeyResolverService } from "../../src/services/session-key-resolver.service.js";
import { closeWebSocket, openWebSocket, rpcCall } from "../helpers/ws.js";

interface WsMessage {
  type?: string;
  event?: string;
  payload?: Record<string, unknown>;
}

function collectMessages(socket: { on(event: "message", cb: (data: Buffer) => void): void }): WsMessage[] {
  const messages: WsMessage[] = [];
  socket.on("message", (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as WsMessage);
    } catch {
      // ignore malformed frames
    }
  });
  return messages;
}

async function waitForFinalChatEvent(
  messages: WsMessage[],
  runId: string,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.some(
      (message) =>
        message.event === "chat" &&
        message.payload?.runId === runId &&
        message.payload?.state === "final",
    );
    if (found) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for final chat event for run ${runId}`);
}

const dbReady = await isTestDatabaseReady();
const canListen = await canBindLocalPort();
const describeIfReady = dbReady && canListen ? describe : describe.skip;

describeIfReady("reliability: websocket chat capability repeat", () => {
  const sessions = new Set<string>();

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("repeat: dual-client stream ordering and tool-event cap isolation", async () => {
    const rawRepeats = Number(process.env.AVA_WS_RELIABILITY_REPEATS ?? "10");
    const repeats = Number.isFinite(rawRepeats) && rawRepeats > 0 ? Math.floor(rawRepeats) : 10;

    for (let i = 0; i < repeats; i += 1) {
      const ownerId = uniqueId(`ws-rel-owner-${i}`);
      const session = await createTestSession({
        userId: ownerId,
        title: `ws-rel-${i}`,
      });
      sessions.add(session.id);

      const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
      if (!identity) {
        throw new Error(`Failed to resolve session key for iteration ${i}`);
      }

      const gateway = await spawnGatewayProcess({
        env: {
          AVA_TEST_FAKE_AGENT_MODE: "1",
          AVA_TEST_FAKE_AGENT_DELAY_MS: "25",
        },
      });

      try {
        const capWs = await openWebSocket(
          `ws://127.0.0.1:${gateway.port}${gateway.path}`,
          {
            token: createTestJwt({ sub: ownerId }),
            caps: ["chat.send", "chat.history", "tool-events"],
          },
        );
        const peerWs = await openWebSocket(
          `ws://127.0.0.1:${gateway.port}${gateway.path}`,
          { token: createTestJwt({ sub: ownerId }) },
        );

        try {
          const capMessages = collectMessages(capWs);
          const peerMessages = collectMessages(peerWs);

          await rpcCall(capWs, "subscribe", {
            events: ["chat", "agent"],
            sessionKey: identity.sessionKey,
          });
          await rpcCall(peerWs, "subscribe", {
            events: ["chat", "agent"],
            sessionKey: identity.sessionKey,
          });

          const sendResult = await rpcCall(capWs, "chat.send", {
            sessionKey: identity.sessionKey,
            message: `repeat-${i}`,
            idempotencyKey: uniqueId(`ws-rel-${i}`),
          });
          const runId = sendResult.result?.runId;
          if (typeof runId !== "string" || runId.length === 0) {
            throw new Error(`Missing runId in iteration ${i}`);
          }

          await Promise.all([
            waitForFinalChatEvent(capMessages, runId),
            waitForFinalChatEvent(peerMessages, runId),
          ]);

          const capThinkingEvents = capMessages.filter(
            (message) =>
              message.event === "agent" &&
              message.payload?.stream === "thinking" &&
              message.payload?.runId === runId,
          );
          expect(capThinkingEvents.length).toBeGreaterThan(0);

          const capToolEvents = capMessages.filter(
            (message) =>
              message.event === "agent" &&
              message.payload?.stream === "tool" &&
              message.payload?.runId === runId,
          );
          const capToolPhases = new Set(capToolEvents.map((message) => message.payload?.data?.phase));
          expect(capToolPhases).toEqual(new Set(["call", "result"]));

          const resultEvent = capToolEvents.find(
            (message) => message.payload?.data?.phase === "result",
          );
          expect(resultEvent?.payload?.data?.result).toBeUndefined();

          const peerToolEvents = peerMessages.filter(
            (message) =>
              message.event === "agent" &&
              message.payload?.runId === runId,
          );
          expect(peerToolEvents).toHaveLength(0);
        } finally {
          await closeWebSocket(capWs);
          await closeWebSocket(peerWs);
        }
      } finally {
        await stopGatewayProcess(gateway);
      }
    }
  });
});
