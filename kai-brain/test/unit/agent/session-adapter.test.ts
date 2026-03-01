import { describe, expect, test } from "vitest";

import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AvaMessage } from "../../../src/db/schema/messages.js";
import {
  dbMessagesToPiMessages,
  piMessageToDbMessage,
  repairToolUseResultPairing,
} from "../../../src/agent/session-adapter.js";

describe("session-adapter", () => {
  test("converts pi messages to db payload", () => {
    const userDb = piMessageToDbMessage(
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      } as Message,
      "session-1",
    );

    expect(userDb.role).toBe("user");
    expect(userDb.content).toBe("hello");

    const assistantDb = piMessageToDbMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          {
            type: "toolCall",
            id: "call-1",
            name: "web_search",
            arguments: { query: "x" },
          },
        ],
        usage: { totalTokens: 42 },
        timestamp: 2,
      } as AssistantMessage,
      "session-1",
    );

    expect(assistantDb.role).toBe("assistant");
    expect(assistantDb.content).toBe("answer");
    expect(assistantDb.toolCalls?.[0].function.name).toBe("web_search");
    expect(assistantDb.tokenCount).toBe(42);
  });

  test("persists structured user content metadata with binary fields redacted", () => {
    const userDb = piMessageToDbMessage(
      {
        role: "user",
        content: "see attachment",
        timestamp: 3,
        metadata: {
          structuredContent: [
            { type: "text", text: "see attachment" },
            {
              type: "image",
              fileName: "photo.png",
              mimeType: "image/png",
              data: "ZmFrZS1iYXNlNjQ=",
            },
          ],
        },
      } as Message,
      "session-1",
    );

    const metadata = (userDb.metadata ?? {}) as { structuredContent?: unknown[] };
    expect(Array.isArray(metadata.structuredContent)).toBe(true);
    const blocks = metadata.structuredContent as Array<Record<string, unknown>>;
    const imageBlock = blocks.find((block) => block.type === "image");
    expect(imageBlock?.data).toBeUndefined();
    expect(imageBlock?.omitted).toBe(true);
    expect(typeof imageBlock?.bytes).toBe("number");
  });

  test("converts db messages to pi messages and preserves id", () => {
    const dbMessages: AvaMessage[] = [
      {
        id: "m-user",
        sessionId: "s1",
        role: "user",
        content: "hello",
        toolCalls: null,
        toolCallId: null,
        name: null,
        tokenCount: null,
        isCompacted: false,
        metadata: {},
        createdAt: new Date(1000),
      },
      {
        id: "m-assistant",
        sessionId: "s1",
        role: "assistant",
        content: "I can help",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "exec",
              arguments: "{\"command\":\"ls\"}",
            },
          },
        ],
        toolCallId: null,
        name: null,
        tokenCount: 10,
        isCompacted: false,
        metadata: {},
        createdAt: new Date(2000),
      },
      {
        id: "m-tool",
        sessionId: "s1",
        role: "tool",
        content: "file1\nfile2",
        toolCalls: null,
        toolCallId: "call-1",
        name: "exec",
        tokenCount: null,
        isCompacted: false,
        metadata: {},
        createdAt: new Date(3000),
      },
    ];

    const converted = dbMessagesToPiMessages(dbMessages);
    expect(converted).toHaveLength(3);
    expect((converted[0] as Message & { id: string }).id).toBe("m-user");
    expect((converted[1] as Message & { id: string }).id).toBe("m-assistant");
    expect((converted[2] as Message & { id: string }).id).toBe("m-tool");

    const assistant = converted[1] as AssistantMessage;
    const toolCall = assistant.content.find((c) => c.type === "toolCall") as {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolCall.id).toBe("call-1");
    expect(toolCall.name).toBe("exec");
    expect(toolCall.arguments.command).toBe("ls");
  });

  test("repairs tool_call/tool_result pairing", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "a",
            name: "tool-a",
            arguments: {},
          },
          {
            type: "toolCall",
            id: "b",
            name: "tool-b",
            arguments: {},
          },
        ],
        timestamp: Date.now(),
      } as AssistantMessage,
      {
        role: "user",
        content: "between",
        timestamp: Date.now(),
      } as Message,
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "tool-b",
        content: [{ type: "text", text: "result-b" }],
        isError: false,
        timestamp: Date.now(),
      } as ToolResultMessage,
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "tool-b",
        content: [{ type: "text", text: "duplicate" }],
        isError: false,
        timestamp: Date.now(),
      } as ToolResultMessage,
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "none",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
        timestamp: Date.now(),
      } as ToolResultMessage,
    ];

    const repaired = repairToolUseResultPairing(messages);

    expect(repaired[0].role).toBe("assistant");
    expect(repaired[1].role).toBe("toolResult");
    expect((repaired[1] as ToolResultMessage).toolCallId).toBe("a");
    expect((repaired[1] as ToolResultMessage).isError).toBe(false);
    expect((repaired[1] as ToolResultMessage).content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("previous run interrupted"),
        }),
      ]),
    );
    expect(repaired[2].role).toBe("toolResult");
    expect((repaired[2] as ToolResultMessage).toolCallId).toBe("b");

    const orphanCount = repaired.filter(
      (m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "orphan",
    ).length;
    expect(orphanCount).toBe(0);
  });
});
