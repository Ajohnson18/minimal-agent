import { afterAll, describe, expect, test } from "vitest";

import { db } from "../../../src/db/client.js";
import { avaQueue } from "../../../src/db/schema/queue.js";
import { eq } from "drizzle-orm";
import { cronService } from "../../../src/gateway/services/cron.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: cron service", () => {
  const createdSessions: string[] = [];

  afterAll(async () => {
    cronService.stop();
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("create/update/trigger cron job enqueues isolated work", async () => {
    const session = await createTestSession({ userId: uniqueId("cron-user") });
    createdSessions.push(session.id);

    const job = await cronService.createJob({
      sessionId: session.id,
      userId: session.userId,
      name: "test-job",
      scheduleKind: "every",
      scheduleValue: "60000",
      payload: "say hello",
      source: "test",
      sourceMetadata: {
        jobName: "Test Job",
      },
    });

    expect(job.id).toBeDefined();
    expect(job.nextRunAt).not.toBeNull();

    const updated = await cronService.updateJob(job.id, {
      name: "updated-job",
      payload: "updated payload",
    });

    expect(updated?.name).toBe("updated-job");
    expect(updated?.payload).toBe("updated payload");

    const triggered = await cronService.triggerJob(job.id);
    expect(triggered).toBe(true);

    const queued = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.sessionId, session.id));

    expect(queued.length).toBeGreaterThan(0);
    expect(queued[0].mode).toBe("isolated");
    expect(queued[0].source).toBe("cron");
    expect(queued[0].sourceMetadata).toMatchObject({
      jobId: job.id,
    });
  });

  test("cron list filters disabled jobs by default", async () => {
    const session = await createTestSession({ userId: uniqueId("cron-user") });
    createdSessions.push(session.id);

    const job = await cronService.createJob({
      sessionId: session.id,
      userId: session.userId,
      name: "disabled-job",
      scheduleKind: "every",
      scheduleValue: "120000",
      payload: "noop",
    });

    await cronService.updateJob(job.id, { enabled: false });

    const enabledJobs = await cronService.listJobs(session.id, false);
    const allJobs = await cronService.listJobs(session.id, true);

    expect(enabledJobs.some((j) => j.id === job.id)).toBe(false);
    expect(allJobs.some((j) => j.id === job.id)).toBe(true);
  });
});
