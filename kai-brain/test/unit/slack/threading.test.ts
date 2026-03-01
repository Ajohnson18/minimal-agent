import { describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: () => ({
    slack: {
      replyToMode: "first",
    },
  }),
}));

import {
  createReplyDeliveryPlan,
  resolveReplyToMode,
  resolveReplyToModeForChatType,
} from "../../../src/lib/slack/threading.js";

describe("slack threading", () => {
  test("normalizes reply modes", () => {
    expect(resolveReplyToMode("off")).toBe("off");
    expect(resolveReplyToMode("first")).toBe("first");
    expect(resolveReplyToMode("all")).toBe("all");
    expect(resolveReplyToMode("unknown")).toBe("all");
  });

  test("uses global mode when no chat override env is present", () => {
    delete process.env.SLACK_REPLY_TO_MODE_CHANNEL;
    expect(resolveReplyToModeForChatType("channel")).toBe("first");
  });

  test("createReplyDeliveryPlan respects off/first/all behavior", () => {
    const offPlan = createReplyDeliveryPlan({
      replyToMode: "off",
      incomingThreadTs: undefined,
      messageTs: "100",
    });
    expect(offPlan.nextThreadTs()).toBeUndefined();

    const firstPlan = createReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "200",
    });
    expect(firstPlan.nextThreadTs()).toBe("200");
    firstPlan.markSent();
    expect(firstPlan.nextThreadTs()).toBeUndefined();

    const allPlan = createReplyDeliveryPlan({
      replyToMode: "all",
      incomingThreadTs: undefined,
      messageTs: "300",
    });
    expect(allPlan.nextThreadTs()).toBe("300");
    allPlan.markSent();
    expect(allPlan.nextThreadTs()).toBe("300");
  });

  test("always stays in existing thread regardless of mode", () => {
    const plan = createReplyDeliveryPlan({
      replyToMode: "off",
      incomingThreadTs: "thread-1",
      messageTs: "msg-1",
    });
    expect(plan.nextThreadTs()).toBe("thread-1");
  });
});
