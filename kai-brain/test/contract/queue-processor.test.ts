import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const slackPostMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../src/lib/slack/app.js", () => ({
  slackClient: {
    chat: {
      postMessage: slackPostMessageMock,
    },
  },
}));

import { db } from "../../src/db/client.js";
import { avaQueue } from "../../src/db/schema/queue.js";
import { eq } from "drizzle-orm";
import { queueProcessor } from "../../src/gateway/services/queue-processor.js";
import { queueService } from "../../src/gateway/services/queue.js";
import { runtime } from "../../src/gateway/runtime.js";
import { CONTROL_ENVELOPE_REQUIREMENT } from "../../src/core/control-envelope.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { waitFor } from "../helpers/wait.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

function controlEnvelope(payload: {
  action: "deliver" | "suppress" | "heartbeat_ack";
  message?: string;
  reason?: string;
}): string {
  return JSON.stringify({
    v: 1,
    action: payload.action,
    ...(payload.message ? { message: payload.message } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
  });
}

describeIfDb("e2e: queue processor", () => {
  const createdSessions: string[] = [];

  beforeEach(() => {
    runtime.resetForTests();
    queueService.resetForTests();
    queueProcessor.resetForTests();

    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content: "processed",
      toolCalls: [],
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      messages: [],
    });
    slackPostMessageMock.mockReset();
    slackPostMessageMock.mockResolvedValue({ ok: true, ts: "1.1" });
  });

  afterEach(() => {
    queueProcessor.resetForTests();
  });

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("dequeue -> execute -> complete end-to-end", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-e2e-user") });
    createdSessions.push(session.id);

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run this",
      {
        mode: "followup",
        source: "api",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    const [completed] = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.id, queued.id))
      .limit(1);

    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("processed");
    expect(completed?.runId).toBeTypeOf("string");

    const run = completed?.runId ? runtime.getRun(completed.runId) : undefined;
    expect(run?.status).toBe("completed");
    expect(run?.content).toBe("processed");

    expect(executeAgentWithPiMock).toHaveBeenCalledTimes(1);
  });

  test("does not dequeue while a runtime run is already active for the session", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-active-run-user") });
    createdSessions.push(session.id);

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "should stay pending while active run exists",
      {
        mode: "followup",
        source: "api",
      },
    );

    const activeRun = runtime.createRun(session.id, session.userId);
    runtime.updateRun(activeRun.runId, { status: "running" });

    queueProcessor.start();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const [pending] = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.id, queued.id))
      .limit(1);

    expect(pending?.status).toBe("pending");
    expect(executeAgentWithPiMock).not.toHaveBeenCalled();

    runtime.cancelRun(activeRun.runId);
    await queueService.cancelPending(session.id);
  });

  test("cron result with typed heartbeat_ack envelope is suppressed for Slack delivery", async () => {
    const session = await createTestSession({
      userId: uniqueId("queue-e2e-cron-heartbeat"),
      source: "slack",
      externalId: "slack:C123:1.200",
    });
    createdSessions.push(session.id);

    executeAgentWithPiMock.mockResolvedValueOnce({
      content: controlEnvelope({
        action: "heartbeat_ack",
        reason: "idle",
      }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      messages: [],
    });

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run cron heartbeat",
      {
        mode: "isolated",
        source: "cron",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(slackPostMessageMock).not.toHaveBeenCalled();
    expect(executeAgentWithPiMock).toHaveBeenCalledTimes(1);
    expect(executeAgentWithPiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(CONTROL_ENVELOPE_REQUIREMENT),
      }),
    );
  });

  test("cron result with typed suppress envelope is suppressed for Slack delivery", async () => {
    const session = await createTestSession({
      userId: uniqueId("queue-e2e-cron-silent"),
      source: "slack",
      externalId: "slack:C123:1.201",
    });
    createdSessions.push(session.id);

    executeAgentWithPiMock.mockResolvedValueOnce({
      content: controlEnvelope({
        action: "suppress",
        reason: "already-delivered",
      }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      messages: [],
    });

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run cron silent",
      {
        mode: "isolated",
        source: "cron",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(slackPostMessageMock).not.toHaveBeenCalled();
  });

  test("cron result literal NO_REPLY is suppressed via legacy control-token guard", async () => {
    const session = await createTestSession({
      userId: uniqueId("queue-e2e-cron-literal-token"),
      source: "slack",
      externalId: "slack:C123:1.202",
    });
    createdSessions.push(session.id);

    executeAgentWithPiMock.mockResolvedValueOnce({
      content: "NO_REPLY",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      messages: [],
    });

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run cron literal token",
      {
        mode: "isolated",
        source: "cron",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(slackPostMessageMock).not.toHaveBeenCalled();
  });

  test("cron result wrapped HEARTBEAT_OK is suppressed via legacy control-token guard", async () => {
    const session = await createTestSession({
      userId: uniqueId("queue-e2e-cron-wrapped-token"),
      source: "slack",
      externalId: "slack:C123:1.203",
    });
    createdSessions.push(session.id);

    executeAgentWithPiMock.mockResolvedValueOnce({
      content: "**HEARTBEAT_OK**",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      messages: [],
    });

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run cron wrapped token",
      {
        mode: "isolated",
        source: "cron",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(slackPostMessageMock).not.toHaveBeenCalled();
  });

  test("cron result that is not control text is delivered to Slack", async () => {
    const session = await createTestSession({
      userId: uniqueId("queue-e2e-cron-alert"),
      source: "slack",
      externalId: "slack:C555:9.300",
    });
    createdSessions.push(session.id);

    executeAgentWithPiMock.mockResolvedValueOnce({
      content: "Alert: CPU is 92% for 10m",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      messages: [],
    });

    const queued = await queueService.enqueue(
      session.id,
      session.userId,
      "run cron alert",
      {
        mode: "isolated",
        source: "cron",
      },
    );

    queueProcessor.start();

    await waitFor(async () => {
      const [item] = await db
        .select()
        .from(avaQueue)
        .where(eq(avaQueue.id, queued.id))
        .limit(1);
      return item?.status === "completed";
    }, { timeoutMs: 5_000, intervalMs: 50 });

    expect(slackPostMessageMock).toHaveBeenCalledTimes(1);
    expect(slackPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C555",
        thread_ts: "9.300",
        text: "Alert: CPU is 92% for 10m",
      }),
    );
  });
});
