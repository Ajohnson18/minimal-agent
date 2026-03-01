import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queueAnnounceMock = vi.hoisted(() => vi.fn());
const markRunningRunsFailedOnStartupMock = vi.hoisted(() => vi.fn());
const listRecentRunsMock = vi.hoisted(() => vi.fn());
const upsertRunMock = vi.hoisted(() => vi.fn());
const pruneOldArchivedRunsMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const listRunsForParentMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agent/subagent-announce.js", () => ({
  queueAnnounce: queueAnnounceMock,
}));

vi.mock("../../../src/services/subagent-runs.service.js", () => ({
  subagentRunsService: {
    markRunningRunsFailedOnStartup: markRunningRunsFailedOnStartupMock,
    listRecentRuns: listRecentRunsMock,
    upsertRun: upsertRunMock,
    pruneOldArchivedRuns: pruneOldArchivedRunsMock,
    getRun: getRunMock,
    listRunsForParent: listRunsForParentMock,
  },
}));

describe("subagent registry lifecycle parity", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    queueAnnounceMock.mockReset();
    queueAnnounceMock.mockResolvedValue("queued");
    markRunningRunsFailedOnStartupMock.mockReset();
    markRunningRunsFailedOnStartupMock.mockResolvedValue([]);
    listRecentRunsMock.mockReset();
    listRecentRunsMock.mockResolvedValue([]);
    upsertRunMock.mockReset();
    upsertRunMock.mockResolvedValue(undefined);
    pruneOldArchivedRunsMock.mockReset();
    pruneOldArchivedRunsMock.mockResolvedValue(0);
    getRunMock.mockReset();
    getRunMock.mockResolvedValue(null);
    listRunsForParentMock.mockReset();
    listRunsForParentMock.mockResolvedValue([]);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("resumes pending announce cleanup from persisted DB runs", async () => {
    listRecentRunsMock.mockResolvedValue([
      {
        runId: "resume-1",
        parentSessionId: "parent-1",
        childSessionId: "child-1",
        userId: "user-1",
        mode: "run",
        task: "resume task",
        type: "general",
        depth: 1,
        status: "completed",
        announceMode: "full",
        result: "done",
        toolsUsed: [],
        announceTriggered: true,
        cleanupHandled: false,
        announceRetryCount: 0,
        startedAt: Date.now() - 10_000,
        endedAt: Date.now() - 5_000,
      },
    ]);

    const registry = await import("../../../src/agent/tools/subagent-registry.js");
    registry.initRegistry();
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => {
      expect(queueAnnounceMock).toHaveBeenCalledTimes(1);
    });
  });

  test("announce retries use backoff and stop at max retries", async () => {
    queueAnnounceMock.mockResolvedValue("failed");
    const registry = await import("../../../src/agent/tools/subagent-registry.js");

    registry.resetSubagentRegistryForTests();
    registry.registerRun({
      id: "retry-1",
      userId: "user-r",
      task: "retry flow",
      type: "general",
      parentSessionId: "parent-r",
      sessionId: "child-r",
      depth: 0,
      status: "running",
      startedAt: Date.now() - 1_000,
      toolsUsed: [],
    });

    registry.completeRun("retry-1", "result", [], "summary");
    expect(queueAnnounceMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueAnnounceMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(queueAnnounceMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(queueAnnounceMock).toHaveBeenCalledTimes(3);

    const run = registry.getRun("retry-1");
    expect(run?.announceRetryCount).toBe(3);
    expect(run?.cleanupHandled).toBe(true);
    expect(run?.suppressAnnounceReason).toBe("announce-retries-exhausted");
  });

  test("expired announce records are completed without infinite retries", async () => {
    queueAnnounceMock.mockResolvedValue("failed");
    const registry = await import("../../../src/agent/tools/subagent-registry.js");

    registry.resetSubagentRegistryForTests();
    registry.registerRun({
      id: "expiry-1",
      userId: "user-e",
      task: "expiry flow",
      type: "general",
      parentSessionId: "parent-e",
      sessionId: "child-e",
      depth: 0,
      status: "running",
      startedAt: Date.now() - 20_000,
      toolsUsed: [],
    });

    registry.completeRun("expiry-1", "result", [], "summary");
    expect(queueAnnounceMock).toHaveBeenCalledTimes(1);

    const run = registry.getRun("expiry-1");
    expect(run).toBeDefined();
    // Force expiry before scheduled retry fires.
    if (run) {
      run.endedAt = Date.now() - 6 * 60 * 1000;
    }

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueAnnounceMock).toHaveBeenCalledTimes(1);

    const updated = registry.getRun("expiry-1");
    expect(updated?.cleanupHandled).toBe(true);
    expect(updated?.suppressAnnounceReason).toBe("announce-expired");
  });
});
