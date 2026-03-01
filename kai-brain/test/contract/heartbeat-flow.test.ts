import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const claimSystemEventsMock = vi.hoisted(() => vi.fn());
const finalizeSystemEventClaimMock = vi.hoisted(() => vi.fn());
const releaseSystemEventClaimMock = vi.hoisted(() => vi.fn());
const deliverToChannelMock = vi.hoisted(() => vi.fn());
const getDeliveryTargetForSessionMock = vi.hoisted(() => vi.fn());
const parseDeliveryTargetMock = vi.hoisted(() => vi.fn());
const queueEnqueueMock = vi.hoisted(() => vi.fn());
const hasSessionSubscribersMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../src/gateway/services/system-events.js", () => ({
  claimSystemEvents: claimSystemEventsMock,
  finalizeSystemEventClaim: finalizeSystemEventClaimMock,
  releaseSystemEventClaim: releaseSystemEventClaimMock,
}));

vi.mock("../../src/gateway/services/queue.js", () => ({
  queueService: {
    isSessionProcessing: vi.fn(async () => false),
    getStats: vi.fn(async () => ({ pending: 0, processing: 0 })),
    enqueue: queueEnqueueMock,
  },
}));

vi.mock("../../src/gateway/runtime.js", () => ({
  runtime: {
    hasSessionSubscribers: hasSessionSubscribersMock,
  },
}));

vi.mock("../../src/agent/delivery.js", () => ({
  getDeliveryTargetForSession: getDeliveryTargetForSessionMock,
  deliverToChannel: deliverToChannelMock,
  deliverToChannelResult: vi.fn(async (...args: unknown[]) => {
    const delivered = await deliverToChannelMock(...args);
    if (
      typeof delivered === "object" &&
      delivered !== null &&
      "status" in delivered
    ) {
      return delivered;
    }
    return delivered
      ? { status: "sent" as const }
      : { status: "failed" as const, reason: "delivery-failed" };
  }),
  parseDeliveryTarget: parseDeliveryTargetMock,
}));

import {
  resetHeartbeatsForTests,
  startHeartbeat,
  wakeHeartbeat,
} from "../../src/gateway/services/heartbeat.service.js";
import { resetHeartbeatWakeStateForTests } from "../../src/gateway/services/heartbeat-wake.js";
import { waitFor } from "../helpers/wait.js";

function controlEnvelope(payload: {
  action: "deliver" | "suppress" | "heartbeat_ack";
  message?: string;
  reason?: string;
}): string {
  return JSON.stringify({
    v: 1,
    action: payload.action,
    ...(payload.message ? { message: payload.message } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
  });
}

describe("e2e: heartbeat flow", () => {
  beforeEach(() => {
    executeAgentWithPiMock.mockReset();
    claimSystemEventsMock.mockReset();
    finalizeSystemEventClaimMock.mockReset();
    releaseSystemEventClaimMock.mockReset();
    deliverToChannelMock.mockReset();
    getDeliveryTargetForSessionMock.mockReset();
    parseDeliveryTargetMock.mockReset();
    queueEnqueueMock.mockReset();
    hasSessionSubscribersMock.mockReset();
    hasSessionSubscribersMock.mockReturnValue(false);
    finalizeSystemEventClaimMock.mockResolvedValue(1);
    releaseSystemEventClaimMock.mockResolvedValue(1);

    getDeliveryTargetForSessionMock.mockResolvedValue({
      channel: "slack",
      externalId: "slack:C1:1.1",
      slack: {
        channelId: "C1",
        threadTs: "1.1",
      },
    });
    deliverToChannelMock.mockResolvedValue(true);
    queueEnqueueMock.mockResolvedValue({
      id: "queue-1",
      sessionId: "s1",
      userId: "u1",
      message: "queued",
      status: "pending",
      mode: "followup",
      priority: 0,
      source: "heartbeat-internal-fallback",
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

  afterEach(() => {
    resetHeartbeatsForTests();
    resetHeartbeatWakeStateForTests();
  });

  test("event wake consumes pending events and suppresses heartbeat_ack", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-1",
      events: [
        {
          id: "evt-1",
          kind: "exec.completion",
          payload: {
            text: "Process finished",
          },
        },
      ],
    });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "heartbeat_ack",
        reason: "idle",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s1",
    });

    wakeHeartbeat("s1", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });

    await waitFor(() => executeAgentWithPiMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-1");
    expect(deliverToChannelMock).not.toHaveBeenCalled();
  });

  test("suppresses heartbeat relay when heartbeat target is set to none", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-target-none",
      events: [
        {
          id: "evt-target-none",
          kind: "exec.completion",
          payload: {
            text: "Background check finished",
          },
        },
      ],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-target-none",
      target: "none",
    });

    wakeHeartbeat("s-target-none", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });

    await waitFor(() => finalizeSystemEventClaimMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(deliverToChannelMock).not.toHaveBeenCalled();
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-target-none");
  });

  test("suppresses explicit control envelope and clears pending events", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-no-reply",
      events: [
        {
          id: "evt-no-reply",
          kind: "subagent.completion",
          payload: {
            text: "Subagent completed",
          },
        },
      ],
    });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "suppress",
        reason: "already-delivered",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-no-reply",
    });

    wakeHeartbeat("s-no-reply", {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(() => executeAgentWithPiMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-no-reply");
    expect(deliverToChannelMock).not.toHaveBeenCalled();
  });

  test("queues internal fallback when no delivery target exists but websocket subscribers are active", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-internal-fallback",
      events: [
        {
          id: "evt-internal-fallback",
          kind: "subagent.completion",
          payload: {
            text: "Subagent completed with useful findings",
            outcome: "completed",
          },
        },
      ],
    });
    getDeliveryTargetForSessionMock.mockResolvedValueOnce(null);
    hasSessionSubscribersMock.mockReturnValue(true);

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-internal-fallback",
    });

    wakeHeartbeat("s-internal-fallback", {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(() => queueEnqueueMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(deliverToChannelMock).not.toHaveBeenCalled();
    expect(queueEnqueueMock).toHaveBeenCalledWith(
      "s-internal-fallback",
      "u1",
      expect.stringContaining("Internal fallback"),
      expect.objectContaining({
        source: "heartbeat-internal-fallback",
      }),
    );
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-internal-fallback");
  });

  test("releases claim and waits for subscriber when no websocket subscribers are active", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-no-subscribers",
      events: [
        {
          id: "evt-no-subscribers",
          kind: "subagent.completion",
          payload: {
            text: "Subagent completed with useful findings",
            outcome: "completed",
          },
        },
      ],
    });
    getDeliveryTargetForSessionMock.mockResolvedValueOnce(null);
    hasSessionSubscribersMock.mockReturnValue(false);

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-no-subscribers",
    });

    wakeHeartbeat("s-no-subscribers", {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(() => releaseSystemEventClaimMock.mock.calls.length >= 1, {
      timeoutMs: 3_000,
    });

    expect(queueEnqueueMock).not.toHaveBeenCalled();
    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(releaseSystemEventClaimMock).toHaveBeenCalledWith("claim-no-subscribers");
    expect(finalizeSystemEventClaimMock).not.toHaveBeenCalledWith("claim-no-subscribers");
  });

  test("finalizes silently suppressed events without executing relay turn", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-suppressed",
      events: [
        {
          id: "evt-suppressed",
          kind: "exec.completion",
          payload: {
            text: "Internal scaffolding server exited",
            completionPolicy: {
              relay: "silent",
              relevance: "internal",
              reason: "internal-scaffolding",
            },
          },
        },
      ],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-suppressed",
    });

    wakeHeartbeat("s-suppressed", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });

    await waitFor(() => finalizeSystemEventClaimMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(deliverToChannelMock).not.toHaveBeenCalled();
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-suppressed");
  });

  test("finalizes silent subagent announce events without executing relay turn", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-subagent-silent",
      events: [
        {
          id: "evt-subagent-silent",
          kind: "subagent.completion",
          payload: {
            text: "Subagent internal prep finished",
            announceMode: "silent",
          },
          metadata: {
            announceMode: "silent",
          },
        },
      ],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-subagent-silent",
    });

    wakeHeartbeat("s-subagent-silent", {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(() => finalizeSystemEventClaimMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(executeAgentWithPiMock).not.toHaveBeenCalled();
    expect(deliverToChannelMock).not.toHaveBeenCalled();
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-subagent-silent");
  });

  test("filters suppressed events while relaying user-relevant events", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-mixed",
      events: [
        {
          id: "evt-internal",
          kind: "exec.completion",
          payload: {
            text: "Internal scaffolding server exited",
            completionPolicy: {
              relay: "silent",
              relevance: "internal",
              reason: "internal-scaffolding",
            },
          },
        },
        {
          id: "evt-user",
          kind: "exec.completion",
          payload: {
            text: "Build finished with 2 warnings",
            completionPolicy: {
              relay: "always",
              relevance: "user",
              reason: "user-command",
            },
          },
        },
      ],
    });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Build completed. 2 warnings were detected.",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-mixed",
    });

    wakeHeartbeat("s-mixed", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });

    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    const firstCallArg = executeAgentWithPiMock.mock.calls[0]?.[0] as
      | { prompt?: string }
      | undefined;
    const prompt = firstCallArg?.prompt ?? "";

    expect(prompt).toContain("Build finished with 2 warnings");
    expect(prompt).not.toContain("Internal scaffolding server exited");
  });

  test("suppresses duplicate alerts within the duplicate window", async () => {
    claimSystemEventsMock
      .mockResolvedValueOnce({
        claimToken: "claim-2a",
        events: [
          {
            id: "evt-2a",
            kind: "exec.completion",
            payload: {
              text: "Process finished",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        claimToken: "claim-2b",
        events: [
          {
            id: "evt-2b",
            kind: "exec.completion",
            payload: {
              text: "Process finished",
            },
          },
        ],
      });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Action required: restart worker",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s2",
    });

    wakeHeartbeat("s2", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });
    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    wakeHeartbeat("s2", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });
    await waitFor(() => executeAgentWithPiMock.mock.calls.length === 2, {
      timeoutMs: 3_000,
    });

    expect(deliverToChannelMock).toHaveBeenCalledTimes(1);
  });

  test("prefers deliveryExternalId from pending event metadata for thread routing", async () => {
    const hintedExternalId = "slack:C_HINT:1700000000.123456";

    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-3",
      events: [
        {
          id: "evt-3",
          kind: "subagent.completion",
          payload: {
            text: "Subagent failed: Process restarted during execution",
            outcome: "failed",
          },
          metadata: {
            deliveryExternalId: hintedExternalId,
          },
        },
      ],
    });

    parseDeliveryTargetMock.mockReturnValue({
      channel: "slack",
      externalId: hintedExternalId,
      slack: {
        channelId: "C_HINT",
        threadTs: "1700000000.123456",
      },
    });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Action required: subagent failed during restart",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s3",
      externalId: "slack:C_FALLBACK:1.1",
    });

    wakeHeartbeat("s3", {
      kind: "event",
      eventKind: "subagent.completion",
      source: "subagent",
    });

    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(parseDeliveryTargetMock).toHaveBeenCalledWith(hintedExternalId);
    expect(getDeliveryTargetForSessionMock).not.toHaveBeenCalled();
    expect(executeAgentWithPiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s3",
        externalId: hintedExternalId,
      }),
    );
    expect(deliverToChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        slack: expect.objectContaining({
          channelId: "C_HINT",
          threadTs: "1700000000.123456",
        }),
      }),
      expect.any(String),
      expect.objectContaining({
        durability: "durable",
        reason: "heartbeat",
        sessionId: "s3",
        expiresAt: expect.any(Date),
      }),
    );
  });

  test("uses explicit heartbeat slack target over last-session route", async () => {
    claimSystemEventsMock.mockResolvedValue({
      claimToken: "claim-explicit-target",
      events: [
        {
          id: "evt-explicit-target",
          kind: "exec.completion",
          payload: {
            text: "Worker failed health check",
          },
        },
      ],
    });

    parseDeliveryTargetMock.mockImplementation((externalId: string) => {
      if (externalId === "slack:C_TARGET") {
        return {
          channel: "slack",
          externalId,
          slack: {
            channelId: "C_TARGET",
          },
        };
      }
      if (externalId === "slack:C1:1.1") {
        return {
          channel: "slack",
          externalId,
          slack: {
            channelId: "C1",
            threadTs: "1.1",
          },
        };
      }
      return null;
    });

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Health check failed for worker service.",
      }),
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      messages: [],
    });

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir: process.cwd(),
      userId: "u1",
      sessionId: "s-explicit-target",
      target: "slack",
      to: "channel:C_TARGET",
    });

    wakeHeartbeat("s-explicit-target", {
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
    });

    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(parseDeliveryTargetMock).toHaveBeenCalledWith("slack:C_TARGET");
    expect(getDeliveryTargetForSessionMock).not.toHaveBeenCalled();
    expect(deliverToChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        slack: expect.objectContaining({
          channelId: "C_TARGET",
        }),
      }),
      expect.any(String),
      expect.objectContaining({
        reason: "heartbeat",
      }),
    );
  });
});
