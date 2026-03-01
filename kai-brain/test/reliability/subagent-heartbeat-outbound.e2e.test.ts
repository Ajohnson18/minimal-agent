import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const postMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../src/lib/slack/app.js", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        postMessage: postMessageMock,
      },
    },
  }),
}));

import {
  resetHeartbeatsForTests,
  startHeartbeat,
  wakeHeartbeat,
} from "../../src/gateway/services/heartbeat.service.js";
import { runtime } from "../../src/gateway/runtime.js";
import { queueService } from "../../src/gateway/services/queue.js";
import { queueSystemEvent } from "../../src/gateway/services/system-events.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import {
  resetReliabilityRuntimeForTests,
  waitForReliabilityIdle,
} from "../helpers/reliability-harness.js";
import {
  listPendingSystemEvents,
  truncateReliabilityTables,
} from "../helpers/reliability-db.js";
import { waitFor } from "../helpers/wait.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("reliability: subagent heartbeat outbound", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content:
        '{"v":1,"action":"deliver","message":"Subagent completed successfully. Here is the final output."}',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [],
    });

    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ok: true, ts: "1.1" });
  });

  afterEach(() => {
    resetHeartbeatsForTests();
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("processes claimed subagent-completion event and delivers exactly once", async () => {
    const session = await createTestSession({
      userId: uniqueId("reliability-user"),
      source: "slack",
      externalId: "slack:C123:1.100",
    });
    sessions.add(session.id);

    startHeartbeat({
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      workspaceDir: process.cwd(),
      userId: session.userId,
      sessionId: session.id,
      externalId: session.externalId ?? undefined,
    });

    const queued = await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "Subagent final summary payload",
        outcome: "completed",
      },
      eventKey: uniqueId("subagent-event"),
    });
    expect(queued).not.toBeNull();

    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    await waitFor(() => postMessageMock.mock.calls.length === 1, {
      timeoutMs: 8_000,
      intervalMs: 50,
    });

    await waitForReliabilityIdle({ timeoutMs: 8_000, pollMs: 25 });

    expect(executeAgentWithPiMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1.100",
      }),
    );

    const pending = await listPendingSystemEvents(session.id);
    expect(pending).toHaveLength(0);
  });

  test("websocket sessions with no external binding use internal heartbeat fallback instead of retry loops", async () => {
    const session = await createTestSession({
      userId: uniqueId("reliability-user-ws"),
      source: "api",
    });
    sessions.add(session.id);

    const fakeWs = {
      readyState: 1,
      send: (_payload: unknown, cb?: (error?: Error) => void) => cb?.(),
    };
    const client = runtime.addClient(fakeWs as never, undefined);
    runtime.subscribe(client.id, ["agent.*"], session.id);

    startHeartbeat({
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      workspaceDir: process.cwd(),
      userId: session.userId,
      sessionId: session.id,
    });

    const queued = await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "Subagent final summary payload",
        outcome: "completed",
      },
      eventKey: uniqueId("subagent-event-ws"),
    });
    expect(queued).not.toBeNull();

    wakeHeartbeat(session.id, {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(async () => {
      const pendingQueue = await queueService.getPending(session.id);
      return pendingQueue.some(
        (item) => item.source === "heartbeat-internal-fallback",
      );
    }, {
      timeoutMs: 8_000,
      intervalMs: 50,
    });

    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    const pendingEvents = await listPendingSystemEvents(session.id);
    expect(pendingEvents).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const pendingQueueItems = await queueService.getPending(session.id);
    expect(
      pendingQueueItems.filter(
        (item) => item.source === "heartbeat-internal-fallback",
      ),
    ).toHaveLength(1);

    runtime.removeClient(client.id);
  });
});
