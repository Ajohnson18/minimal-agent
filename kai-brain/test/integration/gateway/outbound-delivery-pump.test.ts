import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const postMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/slack/app.js", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        postMessage: postMessageMock,
      },
    },
  }),
}));

import { eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import { avaOutboundDeliveryJobs } from "../../../src/db/schema/outbound-delivery-jobs.js";
import { avaSessions } from "../../../src/db/schema/sessions.js";
import {
  resetOutboundPumpForTests,
  runOutboundPumpOnce,
} from "../../../src/gateway/services/outbound-delivery-pump.js";
import { outboundDeliveryQueueService } from "../../../src/services/outbound-delivery-queue.service.js";
import { outboundIdempotencyService } from "../../../src/services/outbound-idempotency.service.js";
import { sessionBindingService } from "../../../src/services/session-binding.service.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";
import { truncateReliabilityTables } from "../../helpers/reliability-db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: outbound delivery pump", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetOutboundPumpForTests();
    await truncateReliabilityTables();
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ ok: true, ts: "1.1" });
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("claims ready jobs and marks sent on successful delivery", async () => {
    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.100" },
      payload: { content: "hello from pump" },
      reason: "integration-test",
    });

    const result = await runOutboundPumpOnce({ reason: "test" });
    expect(result.status).toBe("ran");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1.100",
        text: "hello from pump",
      }),
    );

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("sent");
  });

  test("formats markdown before Slack delivery", async () => {
    await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.100" },
      payload: { content: "**Bold** and [Docs](https://example.com/docs)" },
      reason: "integration-markdown",
    });

    const result = await runOutboundPumpOnce({ reason: "markdown-test" });
    expect(result.status).toBe("ran");

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1.100",
        text: "*Bold* and <https://example.com/docs|Docs>",
      }),
    );
  });

  test("failed delivery retries then transitions to dead at max attempts", async () => {
    postMessageMock.mockRejectedValue(new Error("slack unavailable"));

    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.101" },
      payload: { content: "will fail" },
      reason: "integration-retry",
    });

    await db
      .update(avaOutboundDeliveryJobs)
      .set({ attemptCount: 6 })
      .where(eq(avaOutboundDeliveryJobs.id, job.id));

    const result = await runOutboundPumpOnce({ reason: "test-retry" });
    expect(result.status).toBe("ran");

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("dead");
    expect(stored?.lastError).toContain("delivery-retries-exhausted");
  });

  test("prefers current session binding over route snapshot", async () => {
    const session = await createTestSession({
      userId: uniqueId("pump-user"),
      source: "slack",
      externalId: "slack:COLD:1.200",
    });
    sessions.add(session.id);

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:CNEW:1.201",
    });

    await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId: session.id,
      routeSnapshot: { externalId: "slack:COLD:1.200" },
      payload: { content: "route churn" },
      reason: "route-churn",
    });

    await runOutboundPumpOnce({ reason: "route-test" });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "CNEW",
        thread_ts: "1.201",
      }),
    );
  });

  test("marks job dead when session is archived", async () => {
    const session = await createTestSession({
      userId: uniqueId("pump-user"),
      source: "slack",
      externalId: "slack:C123:1.300",
    });
    sessions.add(session.id);

    await db
      .update(avaSessions)
      .set({ status: "archived", lifecycleState: "archived" })
      .where(eq(avaSessions.id, session.id));

    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId: session.id,
      routeSnapshot: { externalId: "slack:C123:1.300" },
      payload: { content: "blocked by lifecycle" },
      reason: "lifecycle",
    });

    await runOutboundPumpOnce({ reason: "lifecycle-test" });

    expect(postMessageMock).not.toHaveBeenCalled();

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("dead");
    expect(stored?.lastError).toContain("session-not-deliverable");
  });

  test("does not send when idempotency key is already sent", async () => {
    const key = uniqueId("idem-sent");

    await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "seed-job",
    });
    await outboundIdempotencyService.markSent({
      key,
      deliveryJobId: "seed-job",
    });

    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.400" },
      payload: { content: "duplicate" },
      idempotencyKey: key,
      reason: "idempotency",
    });

    await runOutboundPumpOnce({ reason: "idempotency-test" });

    expect(postMessageMock).not.toHaveBeenCalled();

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);
    expect(stored?.status).toBe("sent");
  });

  test("treats inflight idempotency reservations as duplicate sends", async () => {
    const key = uniqueId("idem-inflight");

    await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "owner-a",
    });

    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.500" },
      payload: { content: "inflight duplicate" },
      idempotencyKey: key,
      reason: "idempotency-inflight",
    });

    await runOutboundPumpOnce({ reason: "idempotency-inflight-test" });

    expect(postMessageMock).not.toHaveBeenCalled();

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("sent");
    expect(stored?.providerMeta).toMatchObject({
      reason: "idempotency-inflight",
    });
  });
});
