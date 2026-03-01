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
import { runOutboundPumpOnce } from "../../src/gateway/services/outbound-delivery-pump.js";
import { queueService } from "../../src/gateway/services/queue.js";
import { queueSystemEvent } from "../../src/gateway/services/system-events.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { resetReliabilityRuntimeForTests } from "../helpers/reliability-harness.js";
import { listOutboundJobs, truncateReliabilityTables } from "../helpers/reliability-db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

async function advanceTimersUntil(
  predicate: () => boolean | Promise<boolean>,
  opts?: { stepMs?: number; maxMs?: number },
): Promise<boolean> {
  const stepMs = opts?.stepMs ?? 250;
  const maxMs = opts?.maxMs ?? 15_000;
  const safeStepMs = Math.max(1, Math.floor(stepMs));
  const safeMaxMs = Math.max(safeStepMs, Math.floor(maxMs));

  let elapsed = 0;
  while (elapsed < safeMaxMs) {
    if (await predicate()) {
      return true;
    }
    await vi.advanceTimersByTimeAsync(safeStepMs);
    await Promise.resolve();
    elapsed += safeStepMs;
  }

  return predicate();
}

describeIfDb("reliability: zombie-message regression", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    queueService.resetForTests();
    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content:
        '{"v":1,"action":"deliver","message":"Subagent completed: final answer"}',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [],
    });

    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ok: true, ts: "1.1" });
  });

  afterEach(() => {
    resetHeartbeatsForTests();
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("busy parent + repeated wakes produces one completion and no delayed duplicate", async () => {
    vi.useFakeTimers();

    const session = await createTestSession({
      userId: uniqueId("zombie-user"),
      source: "slack",
      externalId: "slack:C123:4.100",
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

    await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "Subagent complete payload",
        outcome: "completed",
      },
      eventKey: uniqueId("zombie-event"),
    });

    // Keep queue busy initially so first heartbeat run is skipped and retried.
    await queueService.enqueue(session.id, session.userId, "busy item", {
      mode: "followup",
    });

    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });
    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });
    wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    await vi.advanceTimersByTimeAsync(500);
    expect(postMessageMock).toHaveBeenCalledTimes(0);

    await queueService.cancelPending(session.id);

    const outboundQueued = await advanceTimersUntil(
      async () => {
        const jobs = await listOutboundJobs({ sessionId: session.id });
        return jobs.length > 0;
      },
      { stepMs: 250, maxMs: 15_000 },
    );
    expect(outboundQueued).toBe(true);

    const delivered = await advanceTimersUntil(
      async () => {
        if (postMessageMock.mock.calls.length >= 1) {
          return true;
        }
        await runOutboundPumpOnce({ reason: "zombie-repro-test" });
        return postMessageMock.mock.calls.length >= 1;
      },
      { stepMs: 250, maxMs: 10_000 },
    );
    expect(delivered).toBe(true);
    expect(postMessageMock).toHaveBeenCalledTimes(1);

    // Allow trailing retries and timers to drain before long-idle assertion.
    await vi.advanceTimersByTimeAsync(10_000);

    // Simulate long idle period; no duplicate completion should surface later.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(postMessageMock).toHaveBeenCalledTimes(1);
  });
});
