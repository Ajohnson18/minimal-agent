import { beforeEach, describe, expect, test } from "vitest";

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import { avaOutboundDeliveryJobs } from "../../../src/db/schema/outbound-delivery-jobs.js";
import { outboundDeliveryQueueService } from "../../../src/services/outbound-delivery-queue.service.js";
import { isTestDatabaseReady, uniqueId } from "../../helpers/db.js";
import { truncateReliabilityTables } from "../../helpers/reliability-db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: outbound delivery queue service", () => {
  beforeEach(async () => {
    await truncateReliabilityTables();
  });

  test("enqueue -> claim -> mark sent lifecycle", async () => {
    const sessionId = uniqueId("sess");
    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId,
      routeSnapshot: { externalId: "slack:C123:1.1" },
      payload: { content: "hello" },
      idempotencyKey: uniqueId("idem"),
      reason: "test",
    });

    const claimed = await outboundDeliveryQueueService.claimReadyJobs("worker-1", 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].status).toBe("sending");

    await outboundDeliveryQueueService.markJobSent(job.id, { ok: true });

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("sent");
    expect(stored?.providerMeta).toMatchObject({ ok: true });
  });

  test("mark retry increments attempt count and stores error", async () => {
    const job = await outboundDeliveryQueueService.enqueueOutboundJob({
      routeSnapshot: { externalId: "slack:C123:1.1" },
      payload: { content: "retry me" },
      reason: "test-retry",
    });

    await outboundDeliveryQueueService.markJobRetry(
      job.id,
      "network-failure",
      new Date(Date.now() + 5_000),
    );

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("retry");
    expect(stored?.attemptCount).toBe(1);
    expect(stored?.lastError).toBe("network-failure");
  });

  test("recoverStuckJobs moves stale sending jobs back to retry", async () => {
    const stale = new Date(Date.now() - 60_000);
    const [job] = await db
      .insert(avaOutboundDeliveryJobs)
      .values({
        status: "sending",
        attemptCount: 2,
        nextAttemptAt: new Date(Date.now() - 30_000),
        routeSnapshot: { externalId: "slack:C123:1.1" },
        payload: { content: "stale" },
        claimedBy: "worker-old",
        claimedAt: stale,
        claimExpiresAt: stale,
      })
      .returning();

    const recovered = await outboundDeliveryQueueService.recoverStuckJobs("worker-new");
    expect(recovered).toBeGreaterThanOrEqual(1);

    const [stored] = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe("retry");
    expect(stored?.claimedBy).toBeNull();
    expect(stored?.lastError).toContain("Recovered stale sending claim");
  });

  test("cancelPendingForSession marks queued jobs as dead", async () => {
    const sessionId = uniqueId("sess-cancel");

    await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId,
      routeSnapshot: { externalId: "slack:C123:1.1" },
      payload: { content: "a" },
    });

    await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId,
      routeSnapshot: { externalId: "slack:C123:1.1" },
      payload: { content: "b" },
      nextAttemptAt: new Date(Date.now() + 10_000),
    });

    const cancelled = await outboundDeliveryQueueService.cancelPendingForSession(sessionId);
    expect(cancelled).toBe(2);

    const stored = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.sessionId, sessionId));

    expect(stored.length).toBe(2);
    for (const row of stored) {
      expect(row.status).toBe("dead");
      expect(row.lastError).toContain("Session archived/deleted");
    }

    const stillActive = await db
      .select({ id: avaOutboundDeliveryJobs.id })
      .from(avaOutboundDeliveryJobs)
      .where(
        and(
          eq(avaOutboundDeliveryJobs.sessionId, sessionId),
          eq(avaOutboundDeliveryJobs.status, "pending"),
        ),
      );
    expect(stillActive).toHaveLength(0);
  });
});
