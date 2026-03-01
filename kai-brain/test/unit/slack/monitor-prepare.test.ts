import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SlackMonitorContext } from "../../../src/slack/monitor/context.js";
import type { SlackMessageEvent } from "../../../src/slack/types.js";

const { resolveThreadDispatchStateMock } = vi.hoisted(() => ({
  resolveThreadDispatchStateMock: vi.fn(),
}));

vi.mock("../../../src/slack/monitor/runtime.js", () => ({
  resolveThreadDispatchState: resolveThreadDispatchStateMock,
}));

import { prepareSlackMessage } from "../../../src/slack/monitor/message-handler/prepare.js";

function createContext(
  overrides?: Partial<SlackMonitorContext> & {
    mentionPatterns?: RegExp[];
  },
): SlackMonitorContext {
  return {
    accountId: "default",
    mentionPatterns: overrides?.mentionPatterns ?? [],
    mentionGatingMode: "default",
    reactionMode: "off",
    inboundDebounceMs: 0,
    defaultRequireMention: true,
    threadHistoryScope: "thread",
    getMentionConfig: (botUserId?: string) => ({
      botUserId,
      patterns: overrides?.mentionPatterns ?? [],
    }),
    getChannelConfig: () => ({ requireMention: true }),
    markEventSeen: () => false,
    markInteractionSeen: () => false,
    threadTsResolver: {
      resolve: async ({ message }) => message,
    },
    setBotUserId: () => {},
    getBotUserId: () => "B1",
    ...overrides,
  };
}

function createMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "100.200",
    ...overrides,
  };
}

describe("slack monitor prepare", () => {
  beforeEach(() => {
    resolveThreadDispatchStateMock.mockReset();
  });

  test("routes top-level room explicit mention through dispatch", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: undefined,
        text: "<@B1> hello",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    if (prepared?.kind === "dispatch") {
      expect(prepared.sessionKey).toBe("100.200");
    }
  });

  test("treats thread_ts==ts without parent_user_id as non-thread reply", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({ thread_ts: "100.200" }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("pending-history");
    expect(resolveThreadDispatchStateMock).not.toHaveBeenCalled();
  });

  test("ignores room thread reply without mention when thread is inactive", async () => {
    resolveThreadDispatchStateMock.mockResolvedValueOnce(null);

    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "following up",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared).toBeNull();
    expect(resolveThreadDispatchStateMock).toHaveBeenCalledWith("C1", "100.100");
  });

  test("dispatches room thread reply without mention when thread is active", async () => {
    resolveThreadDispatchStateMock.mockResolvedValueOnce({
      sessionId: "S1",
      ownerUserId: "U1",
      hasActiveRun: false,
      hasPendingQueue: false,
      hasRunningSubagents: false,
    });

    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "following up",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    if (prepared?.kind === "dispatch") {
      expect(prepared.sessionKey).toBe("100.100");
    }
  });

  test("allows loose room thread behavior when defaultRequireMention is disabled", async () => {
    resolveThreadDispatchStateMock.mockResolvedValueOnce(null);

    const prepared = await prepareSlackMessage({
      ctx: createContext({
        defaultRequireMention: false,
        getChannelConfig: () => undefined,
      }),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "following up",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    expect(resolveThreadDispatchStateMock).not.toHaveBeenCalled();
  });

  test("ignores room thread reply mentioning another user without AVA signal", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "<@U2> can you handle this?",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared).toBeNull();
    expect(resolveThreadDispatchStateMock).not.toHaveBeenCalled();
  });

  test("dispatches active room thread reply containing channel mention without AVA mention", async () => {
    resolveThreadDispatchStateMock.mockResolvedValueOnce({
      sessionId: "S1",
      ownerUserId: "U1",
      hasActiveRun: false,
      hasPendingQueue: false,
      hasRunningSubagents: false,
    });

    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "post this in <#C42|ai-testing> with a short greeting",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    if (prepared?.kind === "dispatch") {
      expect(prepared.sessionKey).toBe("100.100");
      expect(prepared.text).toContain("<#C42|ai-testing>");
    }
  });

  test("dispatches when mention pattern matches even if another user is mentioned", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext({
        mentionPatterns: [/\bava\b/i],
      }),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "ava can you review this with <@U2>?",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    expect(resolveThreadDispatchStateMock).not.toHaveBeenCalled();
  });

  test("treats control command as directed and dispatches", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        thread_ts: "100.100",
        parent_user_id: "U_PARENT",
        text: "/status",
      }),
      opts: { source: "message", botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    expect(resolveThreadDispatchStateMock).not.toHaveBeenCalled();
  });

  test("routes app_mention through dispatch with thread key fallback", async () => {
    const prepared = await prepareSlackMessage({
      ctx: createContext(),
      message: createMessage({
        type: "app_mention" as unknown as "message",
        thread_ts: undefined,
      }),
      opts: { source: "app_mention", wasMentioned: true, botUserId: "B1" },
    });

    expect(prepared?.kind).toBe("dispatch");
    if (prepared?.kind === "dispatch") {
      expect(prepared.sessionKey).toBe("100.200");
    }
  });
});
