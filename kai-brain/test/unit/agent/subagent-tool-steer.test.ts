import { beforeEach, describe, expect, test, vi } from "vitest";

const spawnSubagentMock = vi.hoisted(() => vi.fn());
const killRunMock = vi.hoisted(() => vi.fn());
const registerRunMock = vi.hoisted(() => vi.fn());
const resolveSessionSubagentFlowModeMock = vi.hoisted(() => vi.fn());
const runStore = vi.hoisted(() => new Map<string, any>());
const getConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    subagents: {
      maxDepth: 2,
      defaultTimeoutMs: 0,
      orchestration: {
        mode: "async",
        allowSessionOverride: true,
        supervisor: {
          maxAttempts: 2,
          baseBackoffMs: 1,
          maxBackoffMs: 2,
          maxWorkflowMs: 30_000,
          statusUpdateMs: 1_000,
        },
      },
    },
  })),
);

vi.mock("../../../src/agent/subagent-executor.js", () => ({
  spawnSubagent: spawnSubagentMock,
}));

vi.mock("../../../src/agent/subagent-flow-mode.js", () => ({
  resolveSessionSubagentFlowMode: resolveSessionSubagentFlowModeMock,
}));

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../../../src/agent/tools/subagent-registry.js", () => ({
  registerRun: (run: any) => {
    runStore.set(run.id, run);
    registerRunMock(run);
  },
  completeRun: vi.fn(),
  failRun: vi.fn(),
  timeoutRun: vi.fn(),
  killRun: (id: string) => killRunMock(id),
  killAllForParent: vi.fn(() => 0),
  listRunsDurable: vi.fn(async () => ({ running: [], completed: [] })),
  getRun: (id: string) => runStore.get(id),
  getRunDurable: vi.fn(async (id: string) => runStore.get(id)),
  canSpawn: vi.fn(() => true),
  formatRunStatus: vi.fn(() => "status"),
}));

describe("spawn_subagent steer", () => {
  beforeEach(() => {
    runStore.clear();
    spawnSubagentMock.mockReset();
    killRunMock.mockReset();
    registerRunMock.mockReset();
    resolveSessionSubagentFlowModeMock.mockReset();
    resolveSessionSubagentFlowModeMock.mockResolvedValue("async");
    getConfigMock.mockReset();
    getConfigMock.mockReturnValue({
      subagents: {
        maxDepth: 2,
        defaultTimeoutMs: 0,
        orchestration: {
          mode: "async",
          allowSessionOverride: true,
          supervisor: {
            maxAttempts: 2,
            baseBackoffMs: 1,
            maxBackoffMs: 2,
            maxWorkflowMs: 30_000,
            statusUpdateMs: 1_000,
          },
        },
      },
    });
  });

  test("restarts in same child session with restart metadata", async () => {
    const existingRunId = "run-old";
    const childSessionId = "child-session-1";

    runStore.set(existingRunId, {
      id: existingRunId,
      userId: "user-1",
      task: "Investigate issue",
      type: "general",
      parentSessionId: "parent-session-1",
      sessionId: childSessionId,
      depth: 0,
      mode: "run",
      cleanup: true,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
      announceMode: "full",
      spawnPromise: Promise.resolve(),
    });

    killRunMock.mockImplementation((id: string) => {
      const run = runStore.get(id);
      if (!run || run.status !== "running") return false;
      run.status = "killed";
      return true;
    });

    spawnSubagentMock.mockResolvedValue({
      success: true,
      content: "done",
      toolsUsed: [],
      sessionId: childSessionId,
      durationMs: 100,
    });

    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-1",
    });

    const result = await tool.execute("call-1", {
      action: "steer",
      run_id: existingRunId,
      steer_message: "Focus only on retry path",
    });

    expect(killRunMock).toHaveBeenCalledWith(existingRunId);
    expect(spawnSubagentMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionId: childSessionId,
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        steered: true,
        mode: "restart",
        previousRunId: existingRunId,
        sessionId: childSessionId,
      }),
    );
  });

  test("runs supervisor flow in-band and retries before succeeding", async () => {
    resolveSessionSubagentFlowModeMock.mockResolvedValue("supervisor");
    spawnSubagentMock
      .mockResolvedValueOnce({
        success: false,
        content: "",
        toolsUsed: [],
        error: "Subagent timed out after 30s before completing.",
        sessionId: "child-session-2",
        durationMs: 30_000,
      })
      .mockResolvedValueOnce({
        success: true,
        content: "Found the Langfuse stack in ECS service langfuse-prod.",
        toolsUsed: ["exec", "web_search"],
        sessionId: "child-session-2",
        durationMs: 1_000,
      });

    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-2",
    });

    const result = await tool.execute("call-2", {
      action: "spawn",
      task: "Find self-hosted Langfuse",
      timeout: 30,
    });

    expect(registerRunMock).not.toHaveBeenCalled();
    expect(spawnSubagentMock).toHaveBeenCalledTimes(2);
    expect(spawnSubagentMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        announceMode: "silent",
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "completed",
        flowMode: "supervisor",
        attempts: 2,
        maxAttempts: 2,
      }),
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain(
        "Found the Langfuse stack in ECS service langfuse-prod.",
      );
    }
  });

  test("returns deterministic supervisor failure after attempts are exhausted", async () => {
    resolveSessionSubagentFlowModeMock.mockResolvedValue("supervisor");
    spawnSubagentMock
      .mockResolvedValueOnce({
        success: false,
        content: "",
        toolsUsed: ["exec"],
        error: "Subagent timed out after 60s before completing.",
        sessionId: "child-session-3",
        durationMs: 60_000,
      })
      .mockResolvedValueOnce({
        success: false,
        content: "",
        toolsUsed: ["exec"],
        error: "Subagent timed out after 60s before completing.",
        sessionId: "child-session-3",
        durationMs: 60_000,
      });

    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-3",
    });

    const result = await tool.execute("call-3", {
      action: "spawn",
      task: "Long-running query",
      timeout: 60,
    });

    expect(registerRunMock).not.toHaveBeenCalled();
    expect(spawnSubagentMock).toHaveBeenCalledTimes(2);
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "failed",
        flowMode: "supervisor",
        attempts: 2,
        maxAttempts: 2,
      }),
    );
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Attempt history");
      expect(result.content[0].text).toContain("1. timeout");
      expect(result.content[0].text).toContain("2. timeout");
    }
  });

  test("returns aborted supervisor outcome when parent signal is already aborted", async () => {
    resolveSessionSubagentFlowModeMock.mockResolvedValue("supervisor");
    const abortController = new AbortController();
    abortController.abort("user-stop");

    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-4",
    });

    const result = await tool.execute(
      "call-4",
      {
        action: "spawn",
        task: "Should abort",
      },
      abortController.signal,
    );

    expect(spawnSubagentMock).not.toHaveBeenCalled();
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "aborted",
        flowMode: "supervisor",
      }),
    );
  });

  test("propagates currentDepth to async spawn and registry run metadata", async () => {
    spawnSubagentMock.mockResolvedValue({
      success: true,
      content: "done",
      toolsUsed: [],
      sessionId: "child-session-depth",
      durationMs: 100,
    });

    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-depth",
      currentDepth: 1,
    });

    const result = await tool.execute("call-depth", {
      action: "spawn",
      task: "Depth propagation check",
    });

    expect(registerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-session-depth",
        depth: 1,
      }),
    );
    expect(spawnSubagentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-session-depth",
        currentDepth: 1,
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        status: "accepted",
        depth: 1,
        maxDepth: 2,
      }),
    );
  });

  test("returns deterministic max_depth_reached guard for nested spawn limit", async () => {
    const { createSpawnSubagentTool } = await import(
      "../../../src/agent/tools/subagent.tool.js"
    );
    const tool = createSpawnSubagentTool({
      userId: "user-1",
      sessionId: "parent-session-depth-limit",
      currentDepth: 2,
    });

    const result = await tool.execute("call-depth-limit", {
      action: "spawn",
      task: "Should be rejected",
    });

    expect(spawnSubagentMock).not.toHaveBeenCalled();
    expect(registerRunMock).not.toHaveBeenCalled();
    expect(result.details).toEqual(
      expect.objectContaining({
        error: "max_depth_reached",
        depth: 2,
        maxDepth: 2,
      }),
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("maximum nesting depth reached");
    }
  });
});
