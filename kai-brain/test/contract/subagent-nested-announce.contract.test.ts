import { beforeEach, describe, expect, test, vi } from "vitest";

const queueSystemEventWithStatusMock = vi.hoisted(() => vi.fn());
const wakeHeartbeatMock = vi.hoisted(() => vi.fn());
const routeDeliveryMock = vi.hoisted(() => vi.fn());
const canDeliverToSessionMock = vi.hoisted(() => vi.fn());
const queueEnqueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/gateway/services/system-events.js", () => ({
  queueSystemEventWithStatus: queueSystemEventWithStatusMock,
}));

vi.mock("../../src/gateway/services/heartbeat.service.js", () => ({
  wakeHeartbeat: wakeHeartbeatMock,
}));

vi.mock("../../src/gateway/services/delivery-router.js", () => ({
  routeDelivery: routeDeliveryMock,
}));

vi.mock("../../src/gateway/services/session-lifecycle-guard.js", () => ({
  canDeliverToSession: canDeliverToSessionMock,
}));

vi.mock("../../src/gateway/services/queue.js", () => ({
  queueService: {
    enqueue: queueEnqueueMock,
  },
}));

import { queueAnnounce } from "../../src/agent/subagent-announce.js";
import type { SubagentRun } from "../../src/agent/tools/subagent-registry.js";

function buildNestedRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "nested-run-1",
    userId: "nested-user-1",
    task: "Child worker analysis",
    type: "research",
    parentSessionId: "parent-subagent-session",
    sessionId: "child-session-1",
    depth: 1,
    status: "completed",
    startedAt: Date.now() - 5_000,
    endedAt: Date.now(),
    result: "Found 5 regressions and mapped remediation plan.",
    toolsUsed: ["read", "grep"],
    announceMode: "full",
    requesterIsSubagent: true,
    childSessionKey: "agent:main:subagent:child-1",
    fullResultPath: "/tmp/subagent-results/nested-run-1.md",
    ...overrides,
  };
}

describe("contract: nested subagent announce parity", () => {
  beforeEach(() => {
    queueSystemEventWithStatusMock.mockReset();
    queueSystemEventWithStatusMock.mockResolvedValue({
      status: "queued",
      event: { id: "evt-nested-1" },
    });
    wakeHeartbeatMock.mockReset();
    routeDeliveryMock.mockReset();
    canDeliverToSessionMock.mockReset();
    canDeliverToSessionMock.mockResolvedValue(true);
    queueEnqueueMock.mockReset();
    queueEnqueueMock.mockResolvedValue({
      id: "q-1",
      sessionId: "parent-subagent-session",
      userId: "nested-user-1",
      message: "queued",
      status: "pending",
      mode: "followup",
      priority: 0,
      source: "subagent-completion",
      sourceMetadata: null,
      batchId: null,
      runId: null,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    });
  });

  test("routes nested completion internally with descriptor references and no direct external attempt", async () => {
    const outcome = await queueAnnounce(buildNestedRun());

    expect(outcome).toBe("queued");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledWith(
      "parent-subagent-session",
      "nested-user-1",
      expect.stringContaining("Found 5 regressions and mapped remediation plan."),
      expect.objectContaining({
        source: "subagent-completion",
      }),
    );
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
  });
});
