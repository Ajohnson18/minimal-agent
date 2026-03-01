import { describe, expect, test } from "vitest";

import { extractMessagingToolSentText } from "../../../src/slack/monitor/messaging-tool-dedupe.js";

describe("messaging tool dedupe helpers", () => {
  test("extracts slack_message.message before legacy fields", () => {
    const text = extractMessagingToolSentText({
      name: "slack_message",
      args: {
        message: "Primary message",
        text: "legacy text",
        caption: "legacy caption",
      },
    });

    expect(text).toBe("Primary message");
  });

  test("falls back to slack_message text and caption", () => {
    const fromText = extractMessagingToolSentText({
      name: "slack_message",
      args: { text: "Legacy text" },
    });
    const fromCaption = extractMessagingToolSentText({
      name: "slack_message",
      args: { caption: "File caption" },
    });

    expect(fromText).toBe("Legacy text");
    expect(fromCaption).toBe("File caption");
  });

  test("extracts slack_actions sendMessage content", () => {
    const text = extractMessagingToolSentText({
      name: "slack_actions",
      args: {
        action: "sendMessage",
        content: "Posted via sendMessage",
      },
    });

    expect(text).toBe("Posted via sendMessage");
  });

  test("ignores non-sendMessage slack_actions calls", () => {
    const text = extractMessagingToolSentText({
      name: "slack_actions",
      args: {
        action: "readMessages",
        content: "Should not count",
      },
    });

    expect(text).toBeNull();
  });
});
