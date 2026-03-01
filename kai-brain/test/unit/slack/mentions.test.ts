import { describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: () => ({
    slack: {
      mentionPatterns: ["ava", "assistant\\s+please"],
    },
  }),
}));

import {
  buildMentionRegexes,
  checkMention,
  shouldProcessChannelMessage,
  stripBotMention,
} from "../../../src/lib/slack/mentions.js";

describe("slack mentions", () => {
  test("builds mention regexes from config", () => {
    const patterns = buildMentionRegexes();
    expect(patterns).toHaveLength(2);
    expect(patterns[0].test("AVA help")).toBe(true);
  });

  test("detects explicit, implicit, and pattern mentions", () => {
    const patterns = buildMentionRegexes();

    const explicit = checkMention({
      text: "<@UBOT> hello",
      config: { botUserId: "UBOT", patterns },
      threadParentUserId: undefined,
      isInThread: false,
    });
    expect(explicit.wasMentioned).toBe(true);
    expect(explicit.isExplicit).toBe(true);

    const implicit = checkMention({
      text: "hello",
      config: { botUserId: "UBOT", patterns },
      threadParentUserId: "UBOT",
      isInThread: true,
    });
    expect(implicit.isImplicit).toBe(true);

    const pattern = checkMention({
      text: "assistant please summarize",
      config: { botUserId: "UBOT", patterns },
      threadParentUserId: undefined,
      isInThread: true,
    });
    expect(pattern.isPattern).toBe(true);
  });

  test("mention gating allows command bypass for authorized sender", () => {
    const shouldProcess = shouldProcessChannelMessage({
      requireMention: true,
      mentionResult: {
        wasMentioned: false,
        isExplicit: false,
        isImplicit: false,
        isPattern: false,
      },
      isControlCommand: true,
      isAuthorizedSender: true,
    });

    expect(shouldProcess).toBe(true);
  });

  test("strips bot mention markers from text", () => {
    expect(stripBotMention("<@UBOT> status", "UBOT")).toBe("status");
  });
});
