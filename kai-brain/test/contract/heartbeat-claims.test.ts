import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const claimSystemEventsMock = vi.hoisted(() => vi.fn());
const finalizeSystemEventClaimMock = vi.hoisted(() => vi.fn());
const releaseSystemEventClaimMock = vi.hoisted(() => vi.fn());
const deliverToChannelMock = vi.hoisted(() => vi.fn());
const getDeliveryTargetForSessionMock = vi.hoisted(() => vi.fn());
const parseDeliveryTargetMock = vi.hoisted(() => vi.fn());

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

describe("e2e: heartbeat claimed event flow", () => {
  let workspaceDir = "";

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ava-heartbeat-claims-"));

    executeAgentWithPiMock.mockReset();
    claimSystemEventsMock.mockReset();
    finalizeSystemEventClaimMock.mockReset();
    releaseSystemEventClaimMock.mockReset();
    deliverToChannelMock.mockReset();
    getDeliveryTargetForSessionMock.mockReset();
    parseDeliveryTargetMock.mockReset();

    executeAgentWithPiMock.mockResolvedValue({
      content: controlEnvelope({
        action: "deliver",
        message: "Action required: background task finished",
      }),
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [],
    });
    finalizeSystemEventClaimMock.mockResolvedValue(1);
    releaseSystemEventClaimMock.mockResolvedValue(1);
    getDeliveryTargetForSessionMock.mockResolvedValue({
      channel: "slack",
      externalId: "slack:C1:1.1",
      slack: { channelId: "C1", threadTs: "1.1" },
    });
    deliverToChannelMock.mockResolvedValue(true);
  });

  afterEach(() => {
    resetHeartbeatsForTests();
    resetHeartbeatWakeStateForTests();
  });

  test("two quick wakes process claimed events only once", async () => {
    claimSystemEventsMock
      .mockResolvedValueOnce({
        claimToken: "claim-1",
        events: [
          {
            id: "evt-1",
            kind: "subagent.completion",
            payload: {
              text: "subagent finished",
              outcome: "completed",
            },
          },
        ],
      })
      .mockResolvedValue(null);

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir,
      userId: "u-1",
      sessionId: "s-claim-1",
    });

    wakeHeartbeat("s-claim-1", { kind: "event", eventKind: "subagent.completion", source: "subagent" });
    wakeHeartbeat("s-claim-1", { kind: "event", eventKind: "subagent.completion", source: "subagent" });

    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    expect(executeAgentWithPiMock).toHaveBeenCalledTimes(1);
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-1");
    expect(deliverToChannelMock).toHaveBeenCalledTimes(1);
  });

  test("failed delivery releases claim and next wake can retry", async () => {
    claimSystemEventsMock
      .mockResolvedValueOnce({
        claimToken: "claim-fail-1",
        events: [
          {
            id: "evt-fail-1",
            kind: "exec.completion",
            payload: {
              text: "Process finished",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        claimToken: "claim-fail-2",
        events: [
          {
            id: "evt-fail-2",
            kind: "exec.completion",
            payload: {
              text: "Process finished",
            },
          },
        ],
      });

    deliverToChannelMock
      // wake #1: primary targetOverride attempt fails
      .mockResolvedValueOnce(false)
      // wake #1: same-run fallback route attempt also fails
      .mockResolvedValueOnce(false)
      // wake #2: retry succeeds
      .mockResolvedValueOnce(true);

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir,
      userId: "u-2",
      sessionId: "s-claim-2",
    });

    wakeHeartbeat("s-claim-2", { kind: "event", eventKind: "exec.completion", source: "exec" });
    await waitFor(() => releaseSystemEventClaimMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    wakeHeartbeat("s-claim-2", { kind: "event", eventKind: "exec.completion", source: "exec" });
    await waitFor(() => deliverToChannelMock.mock.calls.length === 3, {
      timeoutMs: 3_000,
    });

    expect(releaseSystemEventClaimMock).toHaveBeenCalledWith("claim-fail-1");
    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-fail-2");
  });

  test("successful finalize prevents resend on later wake with no claimed events", async () => {
    claimSystemEventsMock
      .mockResolvedValueOnce({
        claimToken: "claim-final",
        events: [
          {
            id: "evt-final",
            kind: "exec.completion",
            payload: {
              text: "Process finished",
            },
          },
        ],
      })
      .mockResolvedValueOnce(null);

    startHeartbeat({
      enabled: true,
      intervalMs: 60_000,
      workspaceDir,
      userId: "u-3",
      sessionId: "s-claim-3",
    });

    wakeHeartbeat("s-claim-3", { kind: "event", eventKind: "exec.completion", source: "exec" });
    await waitFor(() => deliverToChannelMock.mock.calls.length === 1, {
      timeoutMs: 3_000,
    });

    wakeHeartbeat("s-claim-3", { kind: "event", eventKind: "exec.completion", source: "exec" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(finalizeSystemEventClaimMock).toHaveBeenCalledWith("claim-final");
    expect(deliverToChannelMock).toHaveBeenCalledTimes(1);
  });
});
