import type { WebSocket } from "ws";
import { afterEach, describe, expect, test } from "vitest";
import { runtime } from "../../../src/gateway/runtime.js";
import { listPublicGatewayEvents, listPublicGatewayMethods } from "../../../src/gateway/server.js";

type MockSocket = {
  readyState: number;
  bufferedAmount: number;
  sent: Array<Record<string, unknown>>;
  send: (data: string, cb?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
};

function createMockSocket(): MockSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(data, cb) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
      cb?.();
    },
    close() {
      this.readyState = 3;
    },
  };
}

describe("gateway runtime capability routing", () => {
  afterEach(() => {
    runtime.resetForTests();
  });

  test("selects session clients by subscription + capability", () => {
    const socketWithCap = createMockSocket();
    const socketNoCap = createMockSocket();
    const socketOtherSession = createMockSocket();

    const clientWithCap = runtime.addClient(socketWithCap as unknown as WebSocket);
    const clientNoCap = runtime.addClient(socketNoCap as unknown as WebSocket);
    const clientOtherSession = runtime.addClient(socketOtherSession as unknown as WebSocket);

    runtime.markClientConnected(clientWithCap.id, { caps: ["tool-events"] });
    runtime.markClientConnected(clientNoCap.id, { caps: ["chat.send"] });
    runtime.markClientConnected(clientOtherSession.id, { caps: ["tool-events"] });

    runtime.subscribe(clientWithCap.id, ["agent"], "session-1");
    runtime.subscribe(clientNoCap.id, ["agent"], "session-1");
    runtime.subscribe(clientOtherSession.id, ["agent"], "session-2");

    const recipients = runtime.getSessionClientIds({
      sessionId: "session-1",
      eventType: "agent",
      requiredCaps: ["tool-events"],
    });

    expect(recipients).toEqual([clientWithCap.id]);
  });

  test("targets only selected clients when emitting direct events", () => {
    const socketA = createMockSocket();
    const socketB = createMockSocket();

    const clientA = runtime.addClient(socketA as unknown as WebSocket);
    runtime.addClient(socketB as unknown as WebSocket);

    runtime.sendEventToClients([clientA.id], "agent", {
      runId: "run-1",
      stream: "tool",
      seq: 1,
      ts: Date.now(),
      data: {
        phase: "call",
        toolName: "bash",
        args: { cmd: "echo hi" },
      },
    });

    expect(socketA.sent).toHaveLength(1);
    expect(socketA.sent[0]?.event).toBe("agent");
    expect(socketB.sent).toHaveLength(0);
  });
});

describe("gateway public contract lists", () => {
  test("exposes routed methods and excludes removed agent methods", () => {
    const methods = listPublicGatewayMethods();

    expect(methods).toEqual(
      expect.arrayContaining([
        "connect",
        "chat.send",
        "chat.history",
        "chat.abort",
      ]),
    );
    expect(methods).not.toContain("agent.run");
    expect(methods).not.toContain("agent.status");
    expect(methods).not.toContain("agent.cancel");
  });

  test("exposes public event families for connect handshake", () => {
    const events = listPublicGatewayEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        "connect.challenge",
        "chat",
        "agent",
      ]),
    );
  });
});
