import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import { avaOutboundDeliveryJobs } from "../../../src/db/schema/outbound-delivery-jobs.js";
import { avaQueue } from "../../../src/db/schema/queue.js";
import { avaSessionBindings } from "../../../src/db/schema/session-bindings.js";
import { avaSessions } from "../../../src/db/schema/sessions.js";
import { avaSystemEvents } from "../../../src/db/schema/system-events.js";
import {
  archiveSessionAndTerminateWork,
  canDeliverToSession,
  deleteSessionAndTerminateWork,
} from "../../../src/gateway/services/session-lifecycle-guard.js";
import { queueService } from "../../../src/gateway/services/queue.js";
import { queueSystemEvent } from "../../../src/gateway/services/system-events.js";
import { outboundDeliveryQueueService } from "../../../src/services/outbound-delivery-queue.service.js";
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

describeIfDb("integration: session lifecycle guard", () => {
  const createdSessions = new Set<string>();

  beforeEach(async () => {
    queueService.resetForTests();
    await truncateReliabilityTables();
  });

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("canDeliverToSession respects active vs archived lifecycle", async () => {
    const session = await createTestSession({
      userId: uniqueId("lifecycle-user"),
      source: "slack",
      externalId: `slack:C123:${Date.now()}`,
    });
    createdSessions.add(session.id);

    const deliverableBefore = await canDeliverToSession(session.id);
    expect(deliverableBefore).toBe(true);

    const archived = await archiveSessionAndTerminateWork(session.id, "test-archive");
    expect(archived).toBe(true);

    const deliverableAfter = await canDeliverToSession(session.id);
    expect(deliverableAfter).toBe(false);
  });

  test("archiveSessionAndTerminateWork cancels queue/events/outbound and invalidates binding", async () => {
    const session = await createTestSession({
      userId: uniqueId("lifecycle-user"),
      source: "slack",
      externalId: `slack:C123:${Date.now()}`,
    });
    createdSessions.add(session.id);

    await queueService.enqueue(session.id, session.userId, "pending-message", {
      mode: "followup",
    });

    await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "Subagent completed",
        outcome: "completed",
      },
      eventKey: uniqueId("evt"),
    });

    await outboundDeliveryQueueService.enqueueOutboundJob({
      sessionId: session.id,
      routeSnapshot: { externalId: session.externalId },
      payload: { content: "hello" },
      idempotencyKey: uniqueId("idem"),
    });

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: session.externalId!,
    });

    const archived = await archiveSessionAndTerminateWork(session.id, "archive-for-test");
    expect(archived).toBe(true);

    const [storedSession] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.id, session.id))
      .limit(1);
    expect(storedSession?.status).toBe("archived");
    expect(storedSession?.lifecycleState).toBe("archived");

    const queued = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.sessionId, session.id));
    expect(queued.length).toBe(1);
    expect(queued[0].status).toBe("cancelled");

    const events = await db
      .select()
      .from(avaSystemEvents)
      .where(eq(avaSystemEvents.sessionId, session.id));
    expect(events).toHaveLength(0);

    const outbound = await db
      .select()
      .from(avaOutboundDeliveryJobs)
      .where(eq(avaOutboundDeliveryJobs.sessionId, session.id));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].status).toBe("dead");

    const activeBindings = await db
      .select()
      .from(avaSessionBindings)
      .where(
        and(
          eq(avaSessionBindings.sessionId, session.id),
          eq(avaSessionBindings.status, "active"),
        ),
      );
    expect(activeBindings).toHaveLength(0);
  });

  test("deleteSessionAndTerminateWork makes session non-deliverable", async () => {
    const session = await createTestSession({
      userId: uniqueId("lifecycle-user"),
      source: "slack",
      externalId: `slack:C123:${Date.now()}`,
    });
    createdSessions.add(session.id);

    const deleted = await deleteSessionAndTerminateWork(session.id, "delete-for-test");
    expect(deleted).toBe(true);

    const deliverable = await canDeliverToSession(session.id);
    expect(deliverable).toBe(false);

    const [storedSession] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.id, session.id))
      .limit(1);
    expect(storedSession?.status).toBe("deleted");
    expect(storedSession?.lifecycleState).toBe("deleted");
  });
});
