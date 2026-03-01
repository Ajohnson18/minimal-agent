import { afterEach, describe, expect, test } from "vitest";

import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";
import { sessionKeyResolverService } from "../../../src/services/session-key-resolver.service.js";
import { sessionsGet } from "../../../src/gateway/methods/sessions.js";
import { queueEnqueue } from "../../../src/gateway/methods/queue.js";
import { cronAdd, cronRun } from "../../../src/gateway/methods/cron.js";
import { ErrorCodes } from "../../../src/gateway/protocol/types.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: gateway method authz", () => {
  const cleanupSessionIds = new Set<string>();

  afterEach(async () => {
    for (const sessionId of cleanupSessionIds) {
      await deleteSession(sessionId);
    }
    cleanupSessionIds.clear();
  });

  test("sessions.get hides sessions not owned by caller", async () => {
    const ownerId = uniqueId("owner");
    const outsiderId = uniqueId("outsider");
    const session = await createTestSession({ userId: ownerId, title: "private" });
    cleanupSessionIds.add(session.id);
    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) throw new Error("Failed to resolve session identity");

    const result = await sessionsGet({ sessionKey: identity.sessionKey }, outsiderId);

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe(ErrorCodes.NOT_FOUND);
    }
  });

  test("queue.enqueue rejects cross-user session writes", async () => {
    const ownerId = uniqueId("owner");
    const outsiderId = uniqueId("outsider");
    const session = await createTestSession({ userId: ownerId, title: "private" });
    cleanupSessionIds.add(session.id);
    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) throw new Error("Failed to resolve session identity");

    const result = await queueEnqueue(
      {
        sessionKey: identity.sessionKey,
        userId: outsiderId,
        message: "attempt",
      },
      outsiderId,
    );

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe(ErrorCodes.NOT_FOUND);
    }
  });

  test("cron add/run enforce ownership", async () => {
    const ownerId = uniqueId("owner");
    const outsiderId = uniqueId("outsider");
    const session = await createTestSession({ userId: ownerId, title: "private" });
    cleanupSessionIds.add(session.id);
    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) throw new Error("Failed to resolve session identity");

    const forbiddenAdd = await cronAdd(
      {
        sessionKey: identity.sessionKey,
        userId: outsiderId,
        name: "intrude",
        scheduleKind: "every",
        scheduleValue: "60000",
        payload: "test",
      },
      outsiderId,
    );

    expect("code" in forbiddenAdd).toBe(true);
    if ("code" in forbiddenAdd) {
      expect(forbiddenAdd.code).toBe(ErrorCodes.NOT_FOUND);
    }

    const ownerAdd = await cronAdd(
      {
        sessionKey: identity.sessionKey,
        userId: ownerId,
        name: "owner-job",
        scheduleKind: "every",
        scheduleValue: "60000",
        payload: "test",
      },
      ownerId,
    );

    expect("job" in ownerAdd).toBe(true);
    if (!("job" in ownerAdd)) {
      throw new Error("Expected owner cron add to succeed");
    }

    const outsiderRun = await cronRun({ jobId: ownerAdd.job.id }, outsiderId);
    expect("code" in outsiderRun).toBe(true);
    if ("code" in outsiderRun) {
      expect(outsiderRun.code).toBe(ErrorCodes.UNAUTHORIZED);
    }
  });
});
