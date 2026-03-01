import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  claimSystemEvents,
  finalizeSystemEventClaim,
  queueSystemEvent,
  releaseSystemEventClaim,
  dropExpiredSystemEvents,
} from "../../../src/gateway/services/system-events.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";
import { truncateReliabilityTables } from "../../helpers/reliability-db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: system events claiming", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    await truncateReliabilityTables();
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("claim is exclusive until released", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    sessions.add(session.id);

    await queueSystemEvent({
      sessionId: session.id,
      kind: "exec.completion",
      payload: {
        text: "job done",
      },
      eventKey: uniqueId("evt-a"),
    });
    await queueSystemEvent({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "subagent done",
        outcome: "completed",
      },
      eventKey: uniqueId("evt-b"),
    });

    const claimA = await claimSystemEvents(session.id, {
      limit: 20,
      claimTtlSeconds: 120,
    });
    expect(claimA).not.toBeNull();
    expect(claimA?.events.length).toBe(2);

    const claimWhileHeld = await claimSystemEvents(session.id, {
      limit: 20,
      claimTtlSeconds: 120,
    });
    expect(claimWhileHeld).toBeNull();

    const released = await releaseSystemEventClaim(claimA!.claimToken);
    expect(released).toBe(2);

    const claimB = await claimSystemEvents(session.id, {
      limit: 20,
      claimTtlSeconds: 120,
    });
    expect(claimB).not.toBeNull();
    expect(claimB?.events.length).toBe(2);
  });

  test("finalize marks claimed events processed and non-claimable", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    sessions.add(session.id);

    await queueSystemEvent({
      sessionId: session.id,
      kind: "exec.completion",
      payload: {
        text: "job complete",
      },
      eventKey: uniqueId("evt-finalize"),
    });

    const claim = await claimSystemEvents(session.id, {
      limit: 10,
      claimTtlSeconds: 120,
    });
    expect(claim).not.toBeNull();
    expect(claim?.events.length).toBe(1);

    const finalized = await finalizeSystemEventClaim(claim!.claimToken);
    expect(finalized).toBe(1);

    const postFinalizeClaim = await claimSystemEvents(session.id, {
      limit: 10,
      claimTtlSeconds: 120,
    });
    expect(postFinalizeClaim).toBeNull();
  });

  test("dropExpiredSystemEvents removes expired pending events", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    sessions.add(session.id);

    await queueSystemEvent({
      sessionId: session.id,
      kind: "exec.completion",
      payload: {
        text: "expired event",
      },
      eventKey: uniqueId("evt-expired"),
      expiresAt: Date.now() - 1_000,
    });

    const dropped = await dropExpiredSystemEvents(session.id);
    expect(dropped).toBeGreaterThanOrEqual(1);

    const claim = await claimSystemEvents(session.id, {
      limit: 10,
      claimTtlSeconds: 120,
    });
    expect(claim).toBeNull();
  });
});
