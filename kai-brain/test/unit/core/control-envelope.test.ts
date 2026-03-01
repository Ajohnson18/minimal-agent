import { describe, expect, test } from "vitest";
import {
  parseControlEnvelope,
  parseControlEnvelopeWithLegacyFallback,
  toDeliveryControl,
} from "../../../src/core/control-envelope.js";

describe("control-envelope legacy token fallback", () => {
  test("keeps typed parser strict and JSON-only", () => {
    expect(parseControlEnvelope('{"v":1,"action":"suppress","reason":"ok"}')).toEqual({
      v: 1,
      action: "suppress",
      reason: "ok",
    });
    expect(parseControlEnvelope("NO_REPLY")).toBeNull();
  });

  test("suppresses NO_REPLY with markdown wrappers and punctuation", () => {
    const envelope = parseControlEnvelopeWithLegacyFallback("**NO_REPLY**.");
    const control = toDeliveryControl(envelope, "**NO_REPLY**.");
    expect(control).toEqual({
      mode: "suppress",
      reason: "legacy-no-reply-token",
    });
  });

  test("suppresses NO_REPLY when token appears as leading boundary token", () => {
    const envelope = parseControlEnvelopeWithLegacyFallback(
      "NO_REPLY no response needed for this thread",
    );
    const control = toDeliveryControl(
      envelope,
      "NO_REPLY no response needed for this thread",
    );
    expect(control.mode).toBe("suppress");
    expect(control.reason).toBe("legacy-no-reply-token");
  });

  test("suppresses HEARTBEAT_OK with html wrapping", () => {
    const envelope = parseControlEnvelopeWithLegacyFallback("<b>HEARTBEAT_OK</b>");
    const control = toDeliveryControl(envelope, "<b>HEARTBEAT_OK</b>");
    expect(control).toEqual({
      mode: "suppress",
      reason: "legacy-heartbeat-ok-token",
    });
  });

  test("suppresses ANNOUNCE_SKIP with trailing punctuation", () => {
    const envelope = parseControlEnvelopeWithLegacyFallback("ANNOUNCE_SKIP...");
    const control = toDeliveryControl(envelope, "ANNOUNCE_SKIP...");
    expect(control).toEqual({
      mode: "suppress",
      reason: "legacy-announce-skip-token",
    });
  });

  test("does not suppress plain text where token is not at boundaries", () => {
    const envelope = parseControlEnvelopeWithLegacyFallback(
      "The string NO_REPLY should be treated as plain text in docs examples.",
    );
    expect(envelope).toBeNull();
    expect(
      toDeliveryControl(
        envelope,
        "The string NO_REPLY should be treated as plain text in docs examples.",
      ),
    ).toEqual({
      mode: "deliver",
      text: "The string NO_REPLY should be treated as plain text in docs examples.",
    });
  });
});
