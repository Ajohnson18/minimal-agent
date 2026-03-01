import { beforeEach, describe, expect, test, vi } from "vitest";

const queueAnnounceMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agent/subagent-announce.js", () => ({
  queueAnnounce: queueAnnounceMock,
}));

import {
  canSpawn,
  completeRun,
    failRun,
    formatRunStatus,
    getChildRuns,
  getRun,
  killAllForParent,
  killRun,
  listRuns,
  registerRun,
  resetSubagentRegistryForTests,
  timeoutRun,
} from "../../../src/agent/tools/subagent-registry.js";

describe("subagent-registry", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    queueAnnounceMock.mockReset();
  });

  test("tracks lifecycle transitions and announce triggers", () => {
    registerRun({
      id: "r1",
      task: "do work",
      type: "general",
      parentSessionId: "p1",
      sessionId: "s1",
      depth: 0,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
    });

    completeRun("r1", "done", ["web_search"], "summary");

    const run = getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.toolsUsed).toEqual(["web_search"]);
    expect(run?.announceSummary).toBe("summary");
    expect(queueAnnounceMock).toHaveBeenCalledTimes(1);
  });

  test("persists run references (session key + full result path) on completion", () => {
    registerRun({
      id: "r1-refs",
      task: "collect findings",
      type: "general",
      parentSessionId: "p1",
      sessionId: "s1-refs",
      depth: 0,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
    });

    completeRun("r1-refs", "done", ["web_search"], "summary", {
      sessionKey: "agent:main:subagent:abc123",
      fullResultPath: "/tmp/subagent-results/r1-refs.md",
    });

    const run = getRun("r1-refs");
    expect(run?.childSessionKey).toBe("agent:main:subagent:abc123");
    expect(run?.fullResultPath).toBe("/tmp/subagent-results/r1-refs.md");
    expect(formatRunStatus(run!)).toContain("Session key");
    expect(formatRunStatus(run!)).toContain("Full result path");
  });

  test("handles fail and timeout states", () => {
    registerRun({
      id: "r2",
      task: "failing task",
      type: "general",
      parentSessionId: "p2",
      sessionId: "s2",
      depth: 0,
      status: "running",
      startedAt: Date.now() - 2000,
      toolsUsed: [],
    });

    failRun("r2", "boom");
    expect(getRun("r2")?.status).toBe("failed");

    registerRun({
      id: "r3",
      task: "slow task",
      type: "general",
      parentSessionId: "p2",
      sessionId: "s3",
      depth: 0,
      status: "running",
      startedAt: Date.now() - 10_000,
      toolsUsed: [],
    });

    timeoutRun("r3");
    expect(getRun("r3")?.status).toBe("timeout");
  });

  test("enforces global running capacity via canSpawn", () => {
    expect(canSpawn()).toBe(true);

    for (let i = 0; i < 5; i++) {
      registerRun({
        id: `r-${i}`,
        task: `task-${i}`,
        type: "general",
        parentSessionId: "parent-cap",
        sessionId: `session-${i}`,
        depth: 0,
        status: "running",
        startedAt: Date.now(),
        toolsUsed: [],
      });
    }

    expect(canSpawn()).toBe(false);
  });

  test("kill cascades to child runs and list/get APIs reflect state", () => {
    const parentAbort = { abort: vi.fn() } as unknown as AbortController;
    const childAbort = { abort: vi.fn() } as unknown as AbortController;

    registerRun({
      id: "parent-run",
      task: "parent",
      type: "general",
      parentSessionId: "parent-session",
      sessionId: "parent-sub-session",
      depth: 0,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
      abortController: parentAbort,
    });

    registerRun({
      id: "child-run",
      task: "child",
      type: "general",
      parentSessionId: "parent-sub-session",
      sessionId: "child-sub-session",
      depth: 1,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
      abortController: childAbort,
    });

    expect(getChildRuns("parent-sub-session")).toHaveLength(1);

    const killed = killRun("parent-run");
    expect(killed).toBe(true);

    expect(getRun("parent-run")?.status).toBe("killed");
    expect(getRun("child-run")?.status).toBe("killed");
    expect(parentAbort.abort).toHaveBeenCalledTimes(1);
    expect(childAbort.abort).toHaveBeenCalledTimes(1);

    const { running, completed } = listRuns("parent-sub-session");
    expect(running).toHaveLength(0);
    expect(completed.length).toBeGreaterThanOrEqual(1);

    // Late completion callbacks from a killed run must not emit announce.
    completeRun("parent-run", "late-result", ["exec"], "late-summary");
    expect(queueAnnounceMock).toHaveBeenCalledTimes(0);

    expect(killAllForParent("parent-sub-session")).toBe(0);
  });
});
