import { beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const sendFinalReplyMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../../src/agent/user-context.js", () => ({
  resolveUserContext: vi.fn(async () => ({ id: "user-ctx", role: "member" })),
}));

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: () => ({
    logging: {
      level: "info",
      pretty: false,
      redactPaths: [],
      includePid: false,
      includeHostname: false,
    },
    slack: {
      ackEmoji: "eyes",
      ackReactionScope: "all",
      chunkMode: "length",
      humanDelay: { mode: "off", minMs: 0, maxMs: 0 },
      maxConcurrentRuns: 4,
      threadHistoryLimit: 5,
      queueMode: "steer-backlog",
      bashEnabled: false,
      nativeStreaming: false,
    },
    subagents: {
      maxConcurrent: 8,
      maxArchived: 100,
      defaultTimeoutMs: 0,
      orchestration: {
        mode: "async",
        allowSessionOverride: true,
        supervisor: {
          maxAttempts: 3,
          baseBackoffMs: 1000,
          maxBackoffMs: 3000,
          maxWorkflowMs: 60_000,
          statusUpdateMs: 5000,
        },
      },
    },
  }),
}));

vi.mock("../../../src/hooks/index.js", () => ({
  emitMessageReceived: vi.fn(async () => {}),
}));

vi.mock("../../../src/gateway/services/session-lifecycle-guard.js", () => ({
  archiveSessionAndTerminateWork: vi.fn(async () => {}),
}));

vi.mock("../../../src/lib/slack/context.js", () => ({
  resolveUserName: vi.fn(async () => "Tester"),
  resolveChannelInfo: vi.fn(async () => ({ name: "test", topic: "", purpose: "" })),
  formatInboundEnvelope: vi.fn((x: { text: string }) => x.text),
  sanitizeInboundMessage: vi.fn((x: string) => x),
}));

vi.mock("../../../src/lib/slack/format.js", () => ({
  markdownToSlackMrkdwn: (input: string) => input,
}));

vi.mock("../../../src/lib/slack/reply-dispatcher.js", () => ({
  createReplyDispatcher: (opts: {
    deliver: (payload: { text: string }, meta: { kind: string }) => Promise<void>;
  }) => {
    let delivered = false;
    return {
      sendFinalReply: (text: string) => {
        delivered = true;
        sendFinalReplyMock(text);
        void opts.deliver({ text }, { kind: "final" });
      },
      sendBlockReply: vi.fn(),
      markComplete: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      didDeliver: () => delivered,
      getQueuedCounts: () => ({
        final: sendFinalReplyMock.mock.calls.length,
        block: 0,
      }),
    };
  },
}));

vi.mock("../../../src/services/tts.service.js", () => ({
  resolveTtsMode: () => "off",
  synthesizeSpeech: vi.fn(),
}));

vi.mock("../../../src/lib/slack/files.js", () => ({
  downloadSlackFile: vi.fn(),
  processFilesForAgent: vi.fn(),
  cleanupTempFile: vi.fn(),
  uploadFileToSlack: vi.fn(),
}));

vi.mock("../../../src/db/client.js", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  },
}));

import { __testing } from "../../../src/slack/monitor/runtime.js";

function createClient() {
  return {
    apiCall: vi.fn(async () => ({})),
    chat: {
      postMessage: vi.fn(async () => ({ ts: "1.1" })),
    },
    reactions: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
    auth: {
      test: vi.fn(async () => ({ team_id: "T1", user_id: "U_BOT" })),
    },
  };
}

describe("slack runtime final reply dedupe", () => {
  beforeEach(() => {
    sendFinalReplyMock.mockReset();
    executeAgentWithPiMock.mockReset();
  });

  test("suppresses final reply when slack_message already sent message payload", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockImplementation(async (opts: { onEvent?: (event: unknown) => void }) => {
      opts.onEvent?.({
        type: "tool_call",
        call: {
          name: "slack_message",
          args: { message: "Deployment completed successfully" },
        },
      });
      return {
        content: "Deployment completed successfully",
        toolCalls: [],
        usage: undefined,
        messages: [],
      };
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-1",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("suppresses final reply when slack_actions sendMessage already sent content", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockImplementation(async (opts: { onEvent?: (event: unknown) => void }) => {
      opts.onEvent?.({
        type: "tool_call",
        call: {
          name: "slack_actions",
          args: { action: "sendMessage", content: "Build finished" },
        },
      });
      return {
        content: "Build finished",
        toolCalls: [],
        usage: undefined,
        messages: [],
      };
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-2",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("keeps final reply for non-sendMessage slack_actions calls", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockImplementation(async (opts: { onEvent?: (event: unknown) => void }) => {
      opts.onEvent?.({
        type: "tool_call",
        call: {
          name: "slack_actions",
          args: { action: "readMessages", content: "ignored" },
        },
      });
      return {
        content: "Here is the final status update.",
        toolCalls: [],
        usage: undefined,
        messages: [],
      };
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-3",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).toHaveBeenCalledTimes(1);
  });

  test("suppresses final reply when model returns typed suppress control envelope", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockResolvedValue({
      content:
        '{"v":1,"action":"suppress","reason":"group-chat-no-response-needed"}',
      toolCalls: [],
      usage: undefined,
      messages: [],
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-4",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("delivers plain text when no typed suppress envelope is returned", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockResolvedValue({
      content: "No response needed - just casual acknowledgment from Alex.",
      toolCalls: [],
      usage: undefined,
      messages: [],
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-5",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).toHaveBeenCalledTimes(1);
  });

  test("suppresses legacy NO_REPLY token output", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockResolvedValue({
      content: "NO_REPLY",
      toolCalls: [],
      usage: undefined,
      messages: [],
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-6",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("suppresses wrapped legacy control tokens output", async () => {
    const client = createClient();
    executeAgentWithPiMock.mockResolvedValue({
      content: "<b>HEARTBEAT_OK</b>",
      toolCalls: [],
      usage: undefined,
      messages: [],
    });

    await __testing.runAgentAndRespond(
      client as never,
      "C123",
      "1700000000.100",
      "session-7",
      "U123",
      "do work",
      "1700000001.100",
      [],
    );

    expect(sendFinalReplyMock).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
