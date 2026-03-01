import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const postMessageMock = vi.hoisted(() => vi.fn());

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
  runOutboundPumpOnce,
  resetOutboundPumpForTests,
  setOutboundPumpHandler,
} from "../../src/gateway/services/outbound-delivery-pump.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import {
  assertExactlyOnceByIdempotencyKey,
  resetReliabilityRuntimeForTests,
  waitForReliabilityIdle,
} from "../helpers/reliability-harness.js";
import {
  listOutboundJobs,
  truncateReliabilityTables,
} from "../helpers/reliability-db.js";
import { waitFor } from "../helpers/wait.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("reliability: restart recovery", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ok: true, ts: "1.1" });
  });

  afterEach(() => {
    resetOutboundPumpForTests();
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("durable enqueue before pump availability still delivers exactly once after recovery", async () => {
    const session = await createTestSession({
      userId: uniqueId("recovery-user"),
      source: "slack",
      externalId: "slack:C123:1.200",
    });
    sessions.add(session.id);

    // Simulate a restart window where pump handler is not available.
    const restoreNull = setOutboundPumpHandler(null);

    const idempotencyKey = uniqueId("announce");
    const enqueued = await deliverToChannel(
      {
        channel: "slack",
        externalId: "slack:C123:1.200",
        slack: { channelId: "C123", threadTs: "1.200" },
      },
      "durable payload",
      {
        durability: "durable",
        idempotencyKey,
        sessionId: session.id,
        reason: "restart-recovery-test",
      },
    );

    expect(enqueued).toBe(true);

    await waitFor(async () => {
      const jobs = await listOutboundJobs({ idempotencyKey });
      return jobs.length === 1;
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(postMessageMock).not.toHaveBeenCalled();

    // Restore default pump behavior and process backlog as if process restarted.
    restoreNull();
    resetOutboundPumpForTests();

    const result = await runOutboundPumpOnce({ reason: "post-restart" });
    expect(result.status).toBe("ran");

    await waitFor(() => postMessageMock.mock.calls.length === 1, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });

    await waitForReliabilityIdle({ timeoutMs: 8_000, pollMs: 25 });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1.200",
        text: "durable payload",
      }),
    );

    await assertExactlyOnceByIdempotencyKey(idempotencyKey, {
      expectSentJob: true,
    });
  });
});
