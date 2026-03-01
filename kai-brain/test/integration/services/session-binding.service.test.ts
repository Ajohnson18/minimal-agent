import { beforeEach, describe, expect, test } from "vitest";

import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import { avaSessionBindings } from "../../../src/db/schema/session-bindings.js";
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

describeIfDb("integration: session binding service", () => {
  const createdSessions: string[] = [];

  beforeEach(async () => {
    await truncateReliabilityTables();
  });

  afterEach(async () => {
    for (const sessionId of createdSessions.splice(0)) {
      await deleteSession(sessionId);
    }
  });

  test("updateBindingFromInbound creates active binding and resolveCurrentBinding returns it", async () => {
    const session = await createTestSession({
      userId: uniqueId("sess-bind-user"),
      source: "test",
    });
    createdSessions.push(session.id);

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:C123:1.100",
      threadTs: "1.100",
    });

    const resolved = await sessionBindingService.resolveCurrentBinding(session.id);
    expect(resolved).toMatchObject({
      channel: "slack",
      externalId: "slack:C123:1.100",
      threadTs: "1.100",
    });
  });

  test("updating with new externalId invalidates old active binding", async () => {
    const session = await createTestSession({
      userId: uniqueId("sess-bind-churn-user"),
      source: "test",
    });
    createdSessions.push(session.id);

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:C123:1.100",
    });

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:C123:1.200",
    });

    const activeRows = await db
      .select()
      .from(avaSessionBindings)
      .where(
        and(
          eq(avaSessionBindings.sessionId, session.id),
          eq(avaSessionBindings.status, "active"),
        ),
      );

    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].externalId).toBe("slack:C123:1.200");

    const inactiveRows = await db
      .select()
      .from(avaSessionBindings)
      .where(
        and(
          eq(avaSessionBindings.sessionId, session.id),
          eq(avaSessionBindings.status, "inactive"),
        ),
      );

    expect(inactiveRows.length).toBeGreaterThanOrEqual(1);
    expect(inactiveRows.some((row) => row.externalId === "slack:C123:1.100")).toBe(true);
  });

  test("invalidateBinding deactivates active entries", async () => {
    const session = await createTestSession({
      userId: uniqueId("sess-bind-invalidate-user"),
      source: "test",
    });
    createdSessions.push(session.id);

    await sessionBindingService.updateBindingFromInbound(session.id, {
      channel: "slack",
      externalId: "slack:C123:1.300",
    });

    const invalidated = await sessionBindingService.invalidateBinding(session.id);
    expect(invalidated).toBe(1);

    const resolved = await sessionBindingService.resolveCurrentBinding(session.id);
    expect(resolved).toBeNull();
  });
});
