import { beforeEach, describe, expect, test, vi } from "vitest";

const queueSystemEventWithStatusMock = vi.hoisted(() => vi.fn());
const wakeHeartbeatMock = vi.hoisted(() => vi.fn());
const routeDeliveryMock = vi.hoisted(() => vi.fn());
const canDeliverToSessionMock = vi.hoisted(() => vi.fn());
const queueEnqueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/gateway/services/system-events.js", () => ({
  queueSystemEventWithStatus: queueSystemEventWithStatusMock,
}));

vi.mock("../../../src/gateway/services/heartbeat.service.js", () => ({
  wakeHeartbeat: wakeHeartbeatMock,
}));

vi.mock("../../../src/gateway/services/delivery-router.js", () => ({
  routeDelivery: routeDeliveryMock,
}));

vi.mock("../../../src/gateway/services/session-lifecycle-guard.js", () => ({
  canDeliverToSession: canDeliverToSessionMock,
}));

vi.mock("../../../src/gateway/services/queue.js", () => ({
  queueService: {
    enqueue: queueEnqueueMock,
  },
}));

import { queueAnnounce } from "../../../src/agent/subagent-announce.js";
import type { SubagentRun } from "../../../src/agent/tools/subagent-registry.js";

function buildRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    userId: "user-1",
    task: "Investigate flaky test",
    type: "research",
    parentSessionId: "parent-1",
    sessionId: "child-1",
    depth: 1,
    status: "failed",
    startedAt: Date.now() - 3_000,
    endedAt: Date.now(),
    error: "Process restarted during execution",
    toolsUsed: [],
    announceMode: "full",
    ...overrides,
  };
}

describe("subagent announce", () => {
  beforeEach(() => {
    queueSystemEventWithStatusMock.mockReset();
    queueSystemEventWithStatusMock.mockResolvedValue({
      status: "queued",
      event: { id: "evt-1" },
    });
    wakeHeartbeatMock.mockReset();
    routeDeliveryMock.mockReset();
    routeDeliveryMock.mockResolvedValue({
      status: "failed",
      reason: "no-delivery-target",
    });
    canDeliverToSessionMock.mockReset();
    canDeliverToSessionMock.mockResolvedValue(true);
    queueEnqueueMock.mockReset();
    queueEnqueueMock.mockResolvedValue({
      id: "queue-1",
      sessionId: "parent-1",
      userId: "user-1",
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

  test("passes deliveryExternalId metadata when available", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    const outcome = await queueAnnounce(
      buildRun({
        deliveryContext: {
          externalId: "slack:C123:1700000000.100200",
        },
      }),
    );

    expect(outcome).toBe("queued");
    expect(queueEnqueueMock).not.toHaveBeenCalled();
    expect(queueSystemEventWithStatusMock).toHaveBeenCalledTimes(1);
    expect(queueSystemEventWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-1",
        kind: "subagent.completion",
        payload: expect.objectContaining({
          subagentRunId: "run-1",
        }),
        metadata: expect.objectContaining({
          deliveryExternalId: "slack:C123:1700000000.100200",
        }),
      }),
    );
    expect(wakeHeartbeatMock).toHaveBeenCalledWith(
      "parent-1",
      {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
    );
  });

  test("suppresses announce when mode is silent", async () => {
    const outcome = await queueAnnounce(
      buildRun({
        announceMode: "silent",
      }),
    );

    expect(outcome).toBe("suppressed");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
  });

  test("omits deliveryExternalId when no delivery context exists", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    await queueAnnounce(buildRun({ deliveryContext: undefined }));

    const call = queueSystemEventWithStatusMock.mock.calls[0]?.[0] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(call?.metadata).toBeDefined();
    expect(call?.metadata).not.toHaveProperty("deliveryExternalId");
  });

  test("waits for event persistence before waking heartbeat", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    let resolveQueue:
      | ((value: unknown) => void)
      | undefined;
    queueSystemEventWithStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQueue = resolve;
        }),
    );

    const announcePromise = queueAnnounce(buildRun());
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(typeof resolveQueue).toBe("function");
    });

    resolveQueue?.({
      status: "queued",
      event: { id: "evt-2" },
    });
    await announcePromise;

    expect(wakeHeartbeatMock).toHaveBeenCalledWith(
      "parent-1",
      {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
    );
  });

  test("uses fallback message for completed run with empty output", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    await queueAnnounce(
      buildRun({
        status: "completed",
        error: undefined,
        result: undefined,
        announceSummary: undefined,
      }),
    );

    expect(queueSystemEventWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("finished but returned no results"),
        }),
      }),
    );
  });

  test("requires user-visible delivery for failure statuses", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    await queueAnnounce(
      buildRun({
        status: "failed",
        error: "Process restarted during execution",
      }),
    );

    expect(queueSystemEventWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("must always be communicated"),
        }),
      }),
    );
  });

  test("skips direct channel delivery when requester session is a subagent without deliveryContext", async () => {
    const outcome = await queueAnnounce(
      buildRun({
        requesterIsSubagent: true,
        deliveryContext: undefined,
      }),
    );

    expect(outcome).toBe("queued");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledTimes(1);
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
  });

  test("skips direct delivery for nested subagent even with deliveryContext", async () => {
    const outcome = await queueAnnounce(
      buildRun({
        requesterIsSubagent: true,
        deliveryContext: {
          externalId: "slack:C123:1700000000.100200",
        },
        status: "completed",
        result: "Task completed successfully",
      }),
    );

    expect(outcome).toBe("queued");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledWith(
      "parent-1",
      "user-1",
      expect.any(String),
      expect.objectContaining({
        source: "subagent-completion",
      }),
    );
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock.mock.calls[0]?.[2]).toContain(
      "Summary:\nTask completed successfully",
    );
  });

  test("queues internal brief announce for nested requester sessions", async () => {
    const outcome = await queueAnnounce(
      buildRun({
        requesterIsSubagent: true,
        announceMode: "brief",
        status: "completed",
        result: "Found 4 regressions and suggested remediations.",
      }),
    );

    expect(outcome).toBe("queued");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledTimes(1);
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock.mock.calls[0]?.[2]).toContain("Announce Mode: brief");
    expect(queueEnqueueMock.mock.calls[0]?.[2]).toContain(
      "Found 4 regressions and suggested remediations.",
    );
  });

  test("uses internal parent-session fallback when direct delivery has no target", async () => {
    const run = buildRun({
      status: "completed",
      result: "Found one actionable bug and fix.",
    });
    const outcome = await queueAnnounce(run);

    expect(routeDeliveryMock).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("queued");
    expect(queueEnqueueMock).toHaveBeenCalledTimes(1);
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
    expect(run.announceDeliveryPhases?.map((phase) => phase.phase)).toEqual([
      "direct-primary",
      "internal-session-fallback",
    ]);
  });

  test("falls back to heartbeat event when internal enqueue fails", async () => {
    queueEnqueueMock.mockRejectedValueOnce(new Error("queue write failed"));

    const outcome = await queueAnnounce(
      buildRun({
        status: "completed",
        result: "Found one actionable bug and fix.",
      }),
    );

    expect(outcome).toBe("queued");
    expect(queueEnqueueMock).toHaveBeenCalledTimes(1);
    expect(queueSystemEventWithStatusMock).toHaveBeenCalledTimes(1);
    expect(wakeHeartbeatMock).toHaveBeenCalledWith(
      "parent-1",
      {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
    );
  });

  test("suppresses nested requester announce when mode is silent", async () => {
    const outcome = await queueAnnounce(
      buildRun({
        requesterIsSubagent: true,
        announceMode: "silent",
      }),
    );

    expect(outcome).toBe("suppressed");
    expect(routeDeliveryMock).not.toHaveBeenCalled();
    expect(queueSystemEventWithStatusMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
  });

  test("does not truncate long completed results in announce payload", async () => {
    const longResult = "A".repeat(1800);
    routeDeliveryMock.mockResolvedValue({
      status: "sent",
      target: {
        channel: "slack",
        channelId: "C123",
        threadTs: "1700000000.100200",
        externalId: "slack:C123:1700000000.100200",
      },
    });

    const outcome = await queueAnnounce(
      buildRun({
        status: "completed",
        error: undefined,
        announceSummary: undefined,
        result: longResult,
      }),
    );

    expect(outcome).toBe("sent");
    const routeCall = routeDeliveryMock.mock.calls[0]?.[0] as
      | { content?: string }
      | undefined;
    expect(routeCall?.content).toContain("Summary:");
    expect(routeCall?.content).toContain(longResult);
    expect(routeCall?.content).not.toContain("...[truncated]");
  });

  test("includes full-result references in fallback payload metadata", async () => {
    routeDeliveryMock.mockResolvedValueOnce({
      status: "failed",
      reason: "delivery-failed",
      diagnostics: {
        routeFailureReason: "binding-invalid",
        routeCandidateChain: ["sessionIdBinding:binding-invalid"],
      },
    });
    await queueAnnounce(
      buildRun({
        status: "completed",
        error: undefined,
        announceSummary: "Found 3 issues and proposed fixes.",
        result: "Full result body",
        childSessionKey: "agent:main:subagent:child-123",
        fullResultPath: "/tmp/subagent-results/run-1.md",
      }),
    );

    expect(queueSystemEventWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          summary: "Found 3 issues and proposed fixes.",
          childSessionId: "child-1",
          childSessionKey: "agent:main:subagent:child-123",
          fullResultPath: "/tmp/subagent-results/run-1.md",
          text: expect.stringContaining("References:"),
        }),
      }),
    );
  });
});
