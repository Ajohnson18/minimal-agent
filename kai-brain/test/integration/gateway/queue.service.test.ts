import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { db } from "../../../src/db/client.js";
import { avaQueue } from "../../../src/db/schema/queue.js";
import { and, eq } from "drizzle-orm";
import { queueService } from "../../../src/gateway/services/queue.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: queue service", () => {
  const createdSessions: string[] = [];

  beforeEach(() => {
    queueService.resetForTests();
  });

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("followup enqueue/dequeue/complete flow", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-user") });
    createdSessions.push(session.id);

    const item = await queueService.enqueue(
      session.id,
      session.userId,
      "hello queue",
      {
        mode: "followup",
      },
    );

    expect(item.status).toBe("pending");

    const dequeued = await queueService.dequeue(session.id);
    expect(dequeued?.id).toBe(item.id);
    expect(dequeued?.status).toBe("processing");

    await queueService.complete(item.id, "done", "run-1");

    const [updated] = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.id, item.id))
      .limit(1);

    expect(updated?.status).toBe("completed");
    expect(updated?.result).toBe("done");
    expect(updated?.runId).toBe("run-1");
  });

  test("interrupt mode cancels existing pending items", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-user") });
    createdSessions.push(session.id);

    await queueService.enqueue(session.id, session.userId, "first", { mode: "followup" });
    await queueService.enqueue(session.id, session.userId, "second", { mode: "interrupt" });

    const pending = await queueService.getPending(session.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toBe("second");

    const cancelled = await db
      .select()
      .from(avaQueue)
      .where(
        and(eq(avaQueue.sessionId, session.id), eq(avaQueue.status, "cancelled")),
      );
    expect(cancelled.length).toBe(1);
  });

  test("collect mode batches messages and dequeues combined payload", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-user") });
    createdSessions.push(session.id);

    const batchId = uniqueId("batch");

    await queueService.enqueue(session.id, session.userId, "message one", {
      mode: "collect",
      batchId,
    });

    await queueService.enqueue(session.id, session.userId, "message two", {
      mode: "collect",
      batchId,
    });

    // Clear debounce by waiting just over debounce interval.
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const dequeued = await queueService.dequeue(session.id);
    expect(dequeued).not.toBeNull();
    expect(dequeued?.message).toContain("Multiple messages received");
    expect(dequeued?.message).toContain("message one");
    expect(dequeued?.message).toContain("message two");
  });

  test("steer mode still enqueues when no active processing", async () => {
    const session = await createTestSession({ userId: uniqueId("queue-user") });
    createdSessions.push(session.id);

    const item = await queueService.enqueue(session.id, session.userId, "steer me", {
      mode: "steer",
      source: "test",
    });

    expect(item.mode).toBe("steer");
    expect(item.status).toBe("pending");

    const stats = await queueService.getStats(session.id);
    expect(stats.pending).toBe(1);
  });
});
