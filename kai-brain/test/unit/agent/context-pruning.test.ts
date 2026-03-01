import { describe, expect, test } from "vitest";

import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import {
  DEFAULT_PRUNING_CONFIG,
  SEMANTIC_COMPRESSED_MARKER,
  estimateMessageTokens,
  estimateTokens,
  estimateTotalTokens,
  pruneContext,
  shouldCompact,
  type ContextPruningConfig,
} from "../../../src/agent/context-pruning.js";

function user(content: string): Message {
  return { role: "user", content, timestamp: Date.now() } as Message;
}

function assistant(content: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  } as Message;
}

function toolResult(toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${Math.random()}`,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage;
}

describe("context-pruning", () => {
  test("estimates tokens from character count", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345")).toBe(2);
    expect(estimateMessageTokens(user("12345678"))).toBe(2);
    expect(estimateTotalTokens([user("abcd"), assistant("efgh")])).toBe(2);
  });

  test("returns unchanged messages when mode is off", () => {
    const messages = [user("hello"), toolResult("exec", "output")];
    const config: ContextPruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      mode: "off",
    };

    const result = pruneContext(messages, 100, config);
    expect(result.pruned).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  test("soft trims old tool results while keeping recent assistant turns intact", () => {
    const large = "A".repeat(9_000);
    const messages: Message[] = [
      user("intro"),
      toolResult("web_fetch", large),
      assistant("recent assistant 1"),
      assistant("recent assistant 2"),
    ];

    const config: ContextPruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      keepLastAssistants: 1,
      minPrunableToolChars: 10,
      softTrimRatio: 0.1,
      hardClearRatio: 0.95,
      softTrim: {
        maxChars: 200,
        headChars: 50,
        tailChars: 50,
      },
      hardClear: {
        enabled: false,
        placeholder: "[cleared]",
      },
    };

    const result = pruneContext(messages, 500, config);
    expect(result.pruned).toBe(true);
    expect(result.toolResultsPruned).toBe(1);

    const trimmed = result.messages[1] as ToolResultMessage;
    const text = (trimmed.content[0] as { text: string }).text;
    expect(text).toContain("characters trimmed");
    expect(text.length).toBeLessThan(500);

    expect((result.messages[3] as Message).role).toBe("assistant");
  });

  test("hard clears when context exceeds hard threshold", () => {
    const large = "B".repeat(12_000);
    const messages: Message[] = [
      user("intro"),
      toolResult("exec", large),
      assistant("tail"),
    ];

    const config: ContextPruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      keepLastAssistants: 1,
      minPrunableToolChars: 10,
      softTrimRatio: 0.01,
      hardClearRatio: 0.02,
      hardClear: {
        enabled: true,
        placeholder: "[hard-cleared]",
      },
    };

    const result = pruneContext(messages, 100, config);
    expect(result.pruned).toBe(true);

    const cleared = result.messages[1] as ToolResultMessage;
    expect((cleared.content[0] as { text: string }).text).toBe("[hard-cleared]");
  });

  test("does not re-trim semantically compressed tool results", () => {
    const compressed = `${SEMANTIC_COMPRESSED_MARKER}50000 chars]\nsummary`;
    const messages: Message[] = [
      user("start"),
      toolResult("web_fetch", compressed),
      assistant("tail"),
    ];

    const config: ContextPruningConfig = {
      ...DEFAULT_PRUNING_CONFIG,
      keepLastAssistants: 1,
      minPrunableToolChars: 1,
      softTrimRatio: 0.01,
      hardClearRatio: 0.99,
    };

    const result = pruneContext(messages, 100, config);
    expect(result.pruned).toBe(false);
    expect(result.toolResultsPruned).toBe(0);
  });

  test("shouldCompact checks context threshold", () => {
    const messages: Message[] = [user("x".repeat(1_000))];
    expect(shouldCompact(messages, 1_000, 0.1)).toBe(true);
    expect(shouldCompact(messages, 1_000, 0.9)).toBe(false);
  });
});
