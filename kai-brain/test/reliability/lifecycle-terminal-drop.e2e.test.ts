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

import { deliverToChannel } from "../../src/agent/delivery.js";
import {
  resetHeartbeatsForTests,
  runHeartbeatOnce,
  startHeartbeat,
  wakeHeartbeat,
} from "../../src/gateway/services/heartbeat.service.js";
import { runOutboundPumpOnce } from "../../src/gateway/services/outbound-delivery-pump.js";
import { archiveSessionAndTerminateWork } from "../../src/gateway/services/session-lifecycle-guard.js";
import { queueSystemEvent } from "../../src/gateway/services/system-events.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { resetReliabilityRuntimeForTests } from "../helpers/reliability-harness.js";
import {
  listOutboundJobs,
  truncateReliabilityTables,
} from "../helpers/reliability-db.js";
import { waitFor } from "../helpers/wait.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("reliability: lifecycle terminal delivery guard", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content: '{"v":1,"action":"deliver","message":"should not be emitted"}',
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

  test("heartbeat skips archived session and does not invoke executor or transport", async () => {
    const session = await createTestSession({
      userId: uniqueId("lifecycle-user"),
      source: "slack",
      externalId: "slack:C123:2.100",
    });
    sessions.add(session.id);

    const archived = await archiveSessionAndTerminateWork(session.id, "terminal-test");
    expect(archived).toBe(true);

    await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "late completion",
        outcome: "completed",
      },
      eventKey: uniqueId("late-event"),
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      workspaceDir: process.cwd(),
      userId: session.userId,
      sessionId: session.id,
      externalId: session.externalId ?? undefined,
    });

    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    const result = await runHeartbeatOnce({
      sessionId: session.id,
      reason: "manual",
    });

    expect(result).toEqual({ status: "skipped", reason: "session-not-deliverable" });
    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  test("outbound pump marks archived-session jobs dead and never sends", async () => {
    const session = await createTestSession({
      userId: uniqueId("lifecycle-user"),
      source: "slack",
      externalId: "slack:C123:2.200",
    });
    sessions.add(session.id);

    const archived = await archiveSessionAndTerminateWork(session.id, "terminal-outbound");
    expect(archived).toBe(true);

    const idempotencyKey = uniqueId("archived-job");

    const queued = await deliverToChannel(
      {
        channel: "slack",
        externalId: "slack:C123:2.200",
        slack: { channelId: "C123", threadTs: "2.200" },
      },
      "should be blocked",
      {
        durability: "durable",
        sessionId: session.id,
        idempotencyKey,
        reason: "archived-session",
      },
    );

    expect(queued).toBe(true);

    await runOutboundPumpOnce({ reason: "archive-test" });

    expect(postMessageMock).not.toHaveBeenCalled();

    await waitFor(async () => {
      const jobs = await listOutboundJobs({ idempotencyKey });
      return jobs.length === 1 && jobs[0].status === "dead";
    }, { timeoutMs: 5_000, intervalMs: 25 });
  });
});
