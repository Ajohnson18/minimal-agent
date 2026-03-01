import { afterAll, describe, expect, test, vi } from "vitest";

import { notificationDeduplicator } from "../../../src/services/notification-deduplicator.js";
import { systemEventsService } from "../../../src/services/system-events.service.js";
import {
  hasEventKind,
  peekSystemEvents,
  queueSystemEvent,
  removeSystemEvent,
} from "../../../src/gateway/services/system-events.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: system events + dedupe", () => {
  const createdSessions: string[] = [];

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("queueSystemEvent deduplicates by event key", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    createdSessions.push(session.id);

    const eventKey = uniqueId("evt");

    const first = await queueSystemEvent({
      sessionId: session.id,
      kind: "exec.completion",
      payload: {
        text: "Process finished with exit code 0",
      },
      eventKey,
    });

    const second = await queueSystemEvent({
      sessionId: session.id,
      kind: "exec.completion",
      payload: {
        text: "Process finished with exit code 0",
      },
      eventKey,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("deduplication is scoped per session", async () => {
    const sessionA = await createTestSession({ userId: uniqueId("events-user") });
    const sessionB = await createTestSession({ userId: uniqueId("events-user") });
    createdSessions.push(sessionA.id, sessionB.id);

    const eventKey = uniqueId("evt-shared");

    const first = await queueSystemEvent({
      sessionId: sessionA.id,
      kind: "exec.completion",
      payload: {
        text: "Process finished with exit code 0",
      },
      eventKey,
    });

    const second = await queueSystemEvent({
      sessionId: sessionB.id,
      kind: "exec.completion",
      payload: {
        text: "Process finished with exit code 0",
      },
      eventKey,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  test("peek + mark processed removes pending visibility", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    createdSessions.push(session.id);

    const event = await systemEventsService.create({
      sessionId: session.id,
      kind: "subagent.completion",
      payload: {
        text: "subagent finished",
        outcome: "completed",
      },
      eventKey: uniqueId("subagent-event"),
    });

    expect(await hasEventKind(session.id, "subagent.completion")).toBe(true);

    const pending = await peekSystemEvents(session.id);
    expect(pending.some((e) => e.id === event.id)).toBe(true);

    const removed = await removeSystemEvent(session.id, event.id);
    expect(removed).toBe(true);

    const pendingAfter = await peekSystemEvents(session.id);
    expect(pendingAfter.some((e) => e.id === event.id)).toBe(false);
  });

  test("deduplicator fail-open path still creates event", async () => {
    const session = await createTestSession({ userId: uniqueId("events-user") });
    createdSessions.push(session.id);

    const spy = vi
      .spyOn(systemEventsService, "findByEventKey")
      .mockRejectedValueOnce(new Error("temporary failure"));

    const result = await notificationDeduplicator.checkAndCreate({
      sessionId: session.id,
      kind: "cursor.completion",
      payload: {
        text: "cursor done",
      },
      eventKey: uniqueId("cursor-event"),
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.event?.id).toBeDefined();

    spy.mockRestore();
  });
});
