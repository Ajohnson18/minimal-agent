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
import { queueSystemEvent } from "../../src/gateway/services/system-events.js";
import { sessionBindingService } from "../../src/services/session-binding.service.js";
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
import { truncateReliabilityTables } from "../helpers/reliability-db.js";
import { waitFor } from "../helpers/wait.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("reliability: route churn", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content: '{"v":1,"action":"deliver","message":"Route-churn completion"}',
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

  test("completion sends to latest bound route instead of stale snapshot", async () => {
    const session = await createTestSession({
      userId: uniqueId("route-user"),
      source: "slack",
      externalId: "slack:COLD:3.100",
    });
    sessions.add(session.id);

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:CNEW:3.200",
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      workspaceDir: process.cwd(),
      userId: session.userId,
      sessionId: session.id,
      externalId: session.externalId ?? undefined,
    });

    await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "Subagent finished after route churn",
        outcome: "completed",
      },
      eventKey: uniqueId("route-churn"),
      metadata: {
        deliveryExternalId: "slack:COLD:3.100",
      },
    });

    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    await waitFor(() => postMessageMock.mock.calls.length === 1, {
      timeoutMs: 8_000,
      intervalMs: 25,
    });

    await waitForReliabilityIdle({ timeoutMs: 8_000, pollMs: 25 });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "CNEW",
        thread_ts: "3.200",
      }),
    );
  });
});
