import { beforeEach, describe, expect, test, vi } from "vitest";

const deliverToChannelResultMock = vi.hoisted(() => vi.fn());
const getDeliveryTargetForSessionMock = vi.hoisted(() => vi.fn());
const resolveBySessionIdMock = vi.hoisted(() => vi.fn());
const resolveBySessionKeyMock = vi.hoisted(() => vi.fn());
const resolveCurrentBindingBySessionKeyMock = vi.hoisted(() => vi.fn());
const resolveCurrentBindingMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agent/delivery.js", () => ({
  deliverToChannelResult: deliverToChannelResultMock,
  getDeliveryTargetForSession: getDeliveryTargetForSessionMock,
  parseDeliveryTarget: (externalId: string) => {
    if (!externalId.startsWith("slack:")) {
      return { channel: "unknown", externalId };
    }
    const parts = externalId.split(":");
    if (parts.length < 2) {
      return { channel: "unknown", externalId };
    }
    return {
      channel: "slack",
      externalId,
      slack: {
        channelId: parts[1] || "",
        threadTs: parts[2] || undefined,
      },
    };
  },
}));

vi.mock("../../../src/services/session-key-resolver.service.js", () => ({
  sessionKeyResolverService: {
    resolveBySessionId: resolveBySessionIdMock,
    resolveBySessionKey: resolveBySessionKeyMock,
  },
}));

vi.mock("../../../src/services/session-binding.service.js", () => ({
  sessionBindingService: {
    resolveCurrentBindingBySessionKey: resolveCurrentBindingBySessionKeyMock,
    resolveCurrentBinding: resolveCurrentBindingMock,
  },
}));

vi.mock("../../../src/hooks/index.js", () => ({
  runHookPhaseOutput: vi.fn(async () => ({})),
}));

import {
  resolveDeliveryRouteDetailed,
  routeDelivery,
} from "../../../src/gateway/services/delivery-router.js";

describe("delivery router", () => {
  beforeEach(() => {
    deliverToChannelResultMock.mockReset();
    getDeliveryTargetForSessionMock.mockReset();
    resolveBySessionIdMock.mockReset();
    resolveBySessionKeyMock.mockReset();
    resolveCurrentBindingBySessionKeyMock.mockReset();
    resolveCurrentBindingMock.mockReset();

    resolveBySessionIdMock.mockResolvedValue({
      sessionId: "session-1",
      sessionKey: "session:key:1",
    });
    resolveBySessionKeyMock.mockResolvedValue({
      sessionId: "session-1",
      sessionKey: "session:key:1",
    });
    resolveCurrentBindingBySessionKeyMock.mockResolvedValue(null);
    resolveCurrentBindingMock.mockResolvedValue(null);
    getDeliveryTargetForSessionMock.mockResolvedValue(null);
  });

  test("falls back to preferredExternalId when targetOverride is invalid", async () => {
    const resolved = await resolveDeliveryRouteDetailed({
      sessionId: "session-1",
      targetOverride: {
        channel: "unknown",
        externalId: "invalid-target",
      },
      preferredExternalId: "slack:C123:1700000000.000",
    });

    expect(resolved.route?.target.externalId).toBe("slack:C123:1700000000.000");
    expect(resolved.diagnostics.routeCandidateChain).toContain(
      "targetOverride:invalid-target-override",
    );
    expect(resolved.diagnostics.routeCandidateChain).toContain(
      "preferredExternalId:selected",
    );
  });

  test("retries routing without targetOverride when override delivery fails", async () => {
    deliverToChannelResultMock
      .mockResolvedValueOnce({ status: "failed", reason: "delivery-failed" })
      .mockResolvedValueOnce({ status: "sent" });

    const result = await routeDelivery({
      sessionId: "session-1",
      content: "hello",
      targetOverride: {
        channel: "slack",
        externalId: "slack:C_BAD:1700000000.000",
        slack: { channelId: "C_BAD", threadTs: "1700000000.000" },
      },
      preferredExternalId: "slack:C_OK:1700000001.000",
    });

    expect(deliverToChannelResultMock).toHaveBeenCalledTimes(2);
    expect(
      deliverToChannelResultMock.mock.calls[0]?.[0]?.externalId,
    ).toBe("slack:C_BAD:1700000000.000");
    expect(
      deliverToChannelResultMock.mock.calls[1]?.[0]?.externalId,
    ).toBe("slack:C_OK:1700000001.000");
    expect(result.status).toBe("sent");
  });
});
