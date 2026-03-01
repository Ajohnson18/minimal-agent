import { afterEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const claimSystemEventsMock = vi.hoisted(() => vi.fn());
const finalizeSystemEventClaimMock = vi.hoisted(() => vi.fn());
const releaseSystemEventClaimMock = vi.hoisted(() => vi.fn());
const deliverToChannelMock = vi.hoisted(() => vi.fn());
const getDeliveryTargetForSessionMock = vi.hoisted(() => vi.fn());
const parseDeliveryTargetMock = vi.hoisted(() => vi.fn());
const isSessionProcessingMock = vi.hoisted(() => vi.fn());
const getQueueStatsMock = vi.hoisted(() => vi.fn());

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
    isSessionProcessing: isSessionProcessingMock,
    getStats: getQueueStatsMock,
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

describe("e2e: subagent completion duplicate/late-reply regression", () => {
  afterEach(() => {
    resetHeartbeatsForTests();
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
  });

  test("multiple wakes + queue busy retry emits one completion and no late duplicate", async () => {
    vi.useFakeTimers();

    isSessionProcessingMock
      .mockResolvedValueOnce(true) // parent busy on initial wake
      .mockResolvedValue(false);
    getQueueStatsMock.mockResolvedValue({
      pending: 0,
      processing: 0,
      completed: 0,
      error: 0,
    });

    claimSystemEventsMock
      .mockResolvedValueOnce({
        claimToken: "claim-sub-1",
        events: [
          {
            id: "evt-sub-1",
            kind: "subagent.completion",
            payload: {
              text: "Subagent completed with result",
              outcome: "completed",
            },
          },
        ],
      })
      .mockResolvedValue(null);

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Subagent finished: here is the result.",
      }),
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [],
    });

    finalizeSystemEventClaimMock.mockResolvedValue(1);
    releaseSystemEventClaimMock.mockResolvedValue(1);
    deliverToChannelMock.mockResolvedValue(true);
    getDeliveryTargetForSessionMock.mockResolvedValue({
      channel: "slack",
      externalId: "slack:C123:1.1",
      slack: { channelId: "C123", threadTs: "1.1" },
    });
    parseDeliveryTargetMock.mockReturnValue(null);

    startHeartbeat({
      enabled: true,
      intervalMs: 24 * 60 * 60 * 1000, // avoid interval interference
      workspaceDir: process.cwd(),
      userId: "user-1",
      sessionId: "session-sub-regression",
    });

    // Burst wakes from subagent + retries should coalesce/retry safely.
    wakeHeartbeat("session-sub-regression", { kind: "event", eventKind: "subagent.completion", source: "subagent" });
    wakeHeartbeat("session-sub-regression", { kind: "event", eventKind: "subagent.completion", source: "subagent" });
    wakeHeartbeat("session-sub-regression", { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    // Initial run: queue busy -> retry scheduled.
    await vi.advanceTimersByTimeAsync(500);
    expect(deliverToChannelMock).toHaveBeenCalledTimes(0);

    // Retry run should process once and deliver once.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(executeAgentWithPiMock).toHaveBeenCalledTimes(1);
    expect(deliverToChannelMock).toHaveBeenCalledTimes(1);

    // Long passage of time should not produce late duplicate delivery.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(deliverToChannelMock).toHaveBeenCalledTimes(1);
  });
});
