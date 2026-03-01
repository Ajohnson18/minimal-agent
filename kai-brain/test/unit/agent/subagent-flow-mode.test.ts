import { beforeEach, describe, expect, test, vi } from "vitest";

const selectLimitMock = vi.hoisted(() => vi.fn());
const updateWhereMock = vi.hoisted(() => vi.fn());
const updateSetMock = vi.hoisted(() => vi.fn(() => ({ where: updateWhereMock })));
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: updateSetMock })));
const selectMock = vi.hoisted(() =>
  vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: selectLimitMock,
      })),
    })),
  })),
);

const configState = vi.hoisted(() => ({
  subagents: {
    orchestration: {
      mode: "async",
      allowSessionOverride: true,
      supervisor: {
        maxAttempts: 3,
        baseBackoffMs: 5000,
        maxBackoffMs: 60000,
        maxWorkflowMs: 3600000,
        statusUpdateMs: 30000,
      },
    },
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  db: {
    select: selectMock,
    update: updateMock,
  },
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: () => configState,
}));

describe("subagent flow mode resolver", () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
    updateWhereMock.mockReset();
    updateSetMock.mockClear();
    updateMock.mockClear();
    selectMock.mockClear();
    configState.subagents.orchestration.mode = "async";
    configState.subagents.orchestration.allowSessionOverride = true;
  });

  test("resolves metadata override when session override is enabled", async () => {
    const { resolveSubagentFlowModeFromMetadata } = await import(
      "../../../src/agent/subagent-flow-mode.js"
    );
    const mode = resolveSubagentFlowModeFromMetadata({
      metadata: { subagentFlowMode: "supervisor" },
    });
    expect(mode).toBe("supervisor");
  });

  test("ignores metadata override when session override is disabled", async () => {
    configState.subagents.orchestration.allowSessionOverride = false;
    const { resolveSubagentFlowModeFromMetadata } = await import(
      "../../../src/agent/subagent-flow-mode.js"
    );
    const mode = resolveSubagentFlowModeFromMetadata({
      metadata: { subagentFlowMode: "supervisor" },
    });
    expect(mode).toBe("async");
  });

  test("persists and clears session override via setSessionSubagentFlowMode", async () => {
    selectLimitMock.mockResolvedValue([{ metadata: {} }]);
    updateWhereMock.mockResolvedValue([]);

    const { setSessionSubagentFlowMode } = await import(
      "../../../src/agent/subagent-flow-mode.js"
    );

    const effective = await setSessionSubagentFlowMode("sess-1", "supervisor");
    expect(effective).toBe("supervisor");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const firstSetArg = updateSetMock.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(firstSetArg.metadata.subagentFlowMode).toBe("supervisor");

    await setSessionSubagentFlowMode("sess-1", "default");
    const secondSetArg = updateSetMock.mock.calls[1][0] as {
      metadata: Record<string, unknown>;
    };
    expect(secondSetArg.metadata.subagentFlowMode).toBeUndefined();
  });
});
