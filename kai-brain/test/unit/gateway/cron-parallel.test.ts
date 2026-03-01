import { describe, expect, test } from "vitest";

import { runCronJobsBounded } from "../../../src/gateway/services/cron.js";

describe("cron bounded parallel runner", () => {
  test("respects global max concurrency", async () => {
    const jobs = [
      { id: "1", sessionId: "s1" },
      { id: "2", sessionId: "s2" },
      { id: "3", sessionId: "s3" },
      { id: "4", sessionId: "s4" },
    ];

    let active = 0;
    let maxActive = 0;

    await runCronJobsBounded(jobs, 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });

  test("serializes jobs for the same session", async () => {
    const jobs = [
      { id: "1", sessionId: "same" },
      { id: "2", sessionId: "same" },
      { id: "3", sessionId: "other" },
    ];

    const activeBySession = new Set<string>();
    let overlapDetected = false;

    await runCronJobsBounded(jobs, 4, async (job) => {
      if (activeBySession.has(job.sessionId)) {
        overlapDetected = true;
      }
      activeBySession.add(job.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeBySession.delete(job.sessionId);
    });

    expect(overlapDetected).toBe(false);
  });
});
