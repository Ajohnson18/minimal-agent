import { beforeEach, describe, expect, test, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const postMessageMock = vi.fn();
  const chatUpdateMock = vi.fn();
  const chatDeleteMock = vi.fn();
  const conversationsOpenMock = vi.fn();
  const conversationsRepliesMock = vi.fn();
  const conversationsHistoryMock = vi.fn();
  const reactionsAddMock = vi.fn();
  const reactionsRemoveMock = vi.fn();
  const reactionsGetMock = vi.fn();
  const pinsAddMock = vi.fn();
  const pinsRemoveMock = vi.fn();
  const pinsListMock = vi.fn();
  const usersInfoMock = vi.fn();
  const emojiListMock = vi.fn();
  const authTestMock = vi.fn();

  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const sendSlackMessageWithMediaMock = vi.fn();

  return {
    postMessageMock,
    chatUpdateMock,
    chatDeleteMock,
    conversationsOpenMock,
    conversationsRepliesMock,
    conversationsHistoryMock,
    reactionsAddMock,
    reactionsRemoveMock,
    reactionsGetMock,
    pinsAddMock,
    pinsRemoveMock,
    pinsListMock,
    usersInfoMock,
    emojiListMock,
    authTestMock,
    limitMock,
    whereMock,
    fromMock,
    selectMock,
    sendSlackMessageWithMediaMock,
  };
});

vi.mock("../../../src/lib/slack/app.js", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        postMessage: mockState.postMessageMock,
        update: mockState.chatUpdateMock,
        delete: mockState.chatDeleteMock,
      },
      conversations: {
        open: mockState.conversationsOpenMock,
        replies: mockState.conversationsRepliesMock,
        history: mockState.conversationsHistoryMock,
      },
      reactions: {
        add: mockState.reactionsAddMock,
        remove: mockState.reactionsRemoveMock,
        get: mockState.reactionsGetMock,
      },
      pins: {
        add: mockState.pinsAddMock,
        remove: mockState.pinsRemoveMock,
        list: mockState.pinsListMock,
      },
      users: {
        info: mockState.usersInfoMock,
      },
      emoji: {
        list: mockState.emojiListMock,
      },
      auth: {
        test: mockState.authTestMock,
      },
    },
  }),
}));

vi.mock("../../../src/lib/slack/files.js", () => ({
  sendSlackMessageWithMedia: mockState.sendSlackMessageWithMediaMock,
}));

vi.mock("../../../src/db/client.js", () => ({
  db: {
    select: mockState.selectMock,
  },
}));

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("integration: slack_actions tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockState.limitMock.mockResolvedValue([
      {
        source: "slack",
        externalId: "slack:C123:1700000000.123456",
      },
    ]);

    mockState.postMessageMock.mockResolvedValue({ ts: "1700001111.222222" });
    mockState.chatUpdateMock.mockResolvedValue({});
    mockState.chatDeleteMock.mockResolvedValue({});
    mockState.conversationsOpenMock.mockResolvedValue({ channel: { id: "D123" } });
    mockState.conversationsRepliesMock.mockResolvedValue({ messages: [], has_more: false });
    mockState.conversationsHistoryMock.mockResolvedValue({ messages: [], has_more: false });
    mockState.reactionsAddMock.mockResolvedValue({});
    mockState.reactionsRemoveMock.mockResolvedValue({});
    mockState.reactionsGetMock.mockResolvedValue({ message: { reactions: [] } });
    mockState.pinsAddMock.mockResolvedValue({});
    mockState.pinsRemoveMock.mockResolvedValue({});
    mockState.pinsListMock.mockResolvedValue({ items: [] });
    mockState.usersInfoMock.mockResolvedValue({ user: null });
    mockState.emojiListMock.mockResolvedValue({ emoji: {} });
    mockState.authTestMock.mockResolvedValue({ user_id: "U_BOT" });
    mockState.sendSlackMessageWithMediaMock.mockResolvedValue({ ok: true });
  });

  async function createTool() {
    const { createSlackActionsTool } = await import("../../../src/agent/tools/slack-actions.tool.js");
    return createSlackActionsTool({ userId: "user-1", sessionId: "session-1" });
  }

  test("react adds a reaction", async () => {
    const tool = await createTool();
    const result = await tool.execute("call-1", {
      action: "react",
      channelId: "channel:C1",
      messageId: "123.456",
      emoji: "white_check_mark",
    });

    expect(mockState.reactionsAddMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
    expect((result.details as { ok?: boolean }).ok).toBe(true);
  });

  test("react remove=true removes a specific reaction", async () => {
    const tool = await createTool();
    await tool.execute("call-2", {
      action: "react",
      channelId: "C1",
      messageId: "123.456",
      emoji: "white_check_mark",
      remove: true,
    });

    expect(mockState.reactionsRemoveMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
  });

  test("react with empty emoji removes own reactions", async () => {
    mockState.reactionsGetMock.mockResolvedValue({
      message: {
        reactions: [
          { name: "thumbsup", users: ["U_BOT", "U_OTHER"] },
          { name: "eyes", users: ["U_OTHER"] },
        ],
      },
    });

    const tool = await createTool();
    const result = await tool.execute("call-3", {
      action: "react",
      channelId: "C1",
      messageId: "123.456",
      emoji: "",
    });

    expect(mockState.reactionsRemoveMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "thumbsup",
    });

    const details = result.details as { removed?: string[] };
    expect(details.removed).toEqual(["thumbsup"]);
  });

  test("reactions lists message reactions", async () => {
    mockState.reactionsGetMock.mockResolvedValue({
      message: {
        reactions: [{ name: "thumbsup", count: 2, users: ["U1", "U2"] }],
      },
    });

    const tool = await createTool();
    const result = await tool.execute("call-4", {
      action: "reactions",
      channelId: "C1",
      messageId: "123.456",
    });

    const details = result.details as {
      reactions?: Array<{ name?: string; count?: number }>;
    };
    expect(details.reactions?.[0]?.name).toBe("thumbsup");
    expect(details.reactions?.[0]?.count).toBe(2);
  });

  test("sendMessage supports explicit threadTs", async () => {
    const tool = await createTool();

    await tool.execute("call-5", {
      action: "sendMessage",
      to: "channel:C999",
      content: "Hello thread",
      threadTs: "1234567890.123456",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C999",
      text: "Hello thread",
      thread_ts: "1234567890.123456",
      mrkdwn: true,
    });
  });

  test("sendMessage converts markdown to Slack mrkdwn", async () => {
    const tool = await createTool();

    await tool.execute("call-5b", {
      action: "sendMessage",
      to: "channel:C999",
      content: "**Bold** and [Docs](https://example.com/docs)",
      threadTs: "1234567890.123456",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C999",
      text: "*Bold* and <https://example.com/docs|Docs>",
      thread_ts: "1234567890.123456",
      mrkdwn: true,
    });
  });

  test("sendMessage accepts blocks JSON", async () => {
    const tool = await createTool();

    await tool.execute("call-6", {
      action: "sendMessage",
      to: "channel:C123",
      blocks: JSON.stringify([{ type: "divider" }]),
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C123",
      text: " ",
      thread_ts: "1700000000.123456",
      blocks: [{ type: "divider" }],
      mrkdwn: true,
    });
  });

  test("sendMessage accepts blocks arrays", async () => {
    const tool = await createTool();

    await tool.execute("call-7", {
      action: "sendMessage",
      to: "channel:C123",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C123",
      text: " ",
      thread_ts: "1700000000.123456",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
      mrkdwn: true,
    });
  });

  test("sendMessage rejects invalid and empty blocks", async () => {
    const tool = await createTool();

    const invalid = await tool.execute("call-8a", {
      action: "sendMessage",
      to: "channel:C123",
      blocks: "{bad-json",
    });
    const empty = await tool.execute("call-8b", {
      action: "sendMessage",
      to: "channel:C123",
      blocks: "[]",
    });

    expect(getText(invalid)).toContain("blocks must be valid JSON");
    expect(getText(empty)).toContain("blocks must contain at least one block");
  });

  test("sendMessage rejects mediaUrl with blocks", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-9", {
      action: "sendMessage",
      to: "channel:C123",
      mediaUrl: "https://example.com/image.png",
      blocks: [{ type: "divider" }],
    });

    expect(getText(result)).toContain("does not support blocks with mediaUrl");
  });

  test("sendMessage requires content, mediaUrl, or blocks", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-10", {
      action: "sendMessage",
      to: "channel:C123",
      content: "",
    });

    expect(getText(result)).toContain("requires content, blocks, or mediaUrl");
  });

  test("editMessage supports blocks-only updates", async () => {
    const tool = await createTool();

    await tool.execute("call-11", {
      action: "editMessage",
      channelId: "C123",
      messageId: "123.456",
      blocks: [{ type: "divider" }],
    });

    expect(mockState.chatUpdateMock).toHaveBeenCalledWith({
      channel: "C123",
      ts: "123.456",
      text: " ",
      blocks: [{ type: "divider" }],
    });
  });

  test("readMessages supports before/after and thread replies-only behavior", async () => {
    mockState.conversationsRepliesMock.mockResolvedValue({
      messages: [
        { ts: "123.456", text: "parent" },
        { ts: "123.457", text: "reply", user: "U1" },
      ],
      has_more: true,
    });

    const tool = await createTool();
    const result = await tool.execute("call-12", {
      action: "readMessages",
      channelId: "channel:C1",
      threadId: "123.456",
      before: "200",
      after: "100",
      limit: 10,
    });

    expect(mockState.conversationsRepliesMock).toHaveBeenCalledWith({
      channel: "C1",
      ts: "123.456",
      limit: 10,
      latest: "200",
      oldest: "100",
    });

    const details = result.details as {
      hasMore?: boolean;
      messages?: Array<{ ts?: string; timestampMs?: number; timestampUtc?: string }>;
    };

    expect(details.hasMore).toBe(true);
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.ts).toBe("123.457");
    expect(typeof details.messages?.[0]?.timestampMs).toBe("number");
    expect(typeof details.messages?.[0]?.timestampUtc).toBe("string");
  });

  test("listPins includes normalized pin timestamps", async () => {
    mockState.pinsListMock.mockResolvedValue({
      items: [{ type: "message", message: { ts: "1735689600.789", text: "pinned" } }],
    });

    const tool = await createTool();
    const result = await tool.execute("call-13", {
      action: "listPins",
      channelId: "C1",
    });

    const details = result.details as {
      pins?: Array<{
        message?: { timestampMs?: number; timestampUtc?: string };
      }>;
    };

    expect(typeof details.pins?.[0]?.message?.timestampMs).toBe("number");
    expect(typeof details.pins?.[0]?.message?.timestampUtc).toBe("string");
  });

  test("emojiList returns full and limited deterministic sets", async () => {
    mockState.emojiListMock.mockResolvedValue({
      emoji: {
        wave: "url1",
        smile: "url2",
        heart: "url3",
      },
    });

    const tool = await createTool();
    const full = await tool.execute("call-14a", {
      action: "emojiList",
    });
    const limited = await tool.execute("call-14b", {
      action: "emojiList",
      limit: 2,
    });

    const fullEmoji = (full.details as { emojis?: { emoji?: Record<string, string> } }).emojis?.emoji;
    const limitedEmoji = (limited.details as { emojis?: { emoji?: Record<string, string> } }).emojis
      ?.emoji;

    expect(Object.keys(fullEmoji || {})).toHaveLength(3);
    expect(Object.keys(limitedEmoji || {})).toHaveLength(2);
    expect(Object.keys(limitedEmoji || {})).toEqual(["heart", "smile"]);
  });

  test("memberInfo succeeds and validates required userId", async () => {
    mockState.usersInfoMock.mockResolvedValue({ user: { id: "U1", real_name: "Test User" } });

    const tool = await createTool();
    const success = await tool.execute("call-15a", {
      action: "memberInfo",
      userId: "U1",
    });

    expect((success.details as { ok?: boolean }).ok).toBe(true);

    const missing = await tool.execute("call-15b", {
      action: "memberInfo",
    });

    expect(getText(missing)).toContain("userId is required for memberInfo");
  });

  test("legacy and unknown actions return actionable migration errors", async () => {
    const tool = await createTool();

    const legacy = await tool.execute("call-16a", {
      action: "read_messages",
      channelId: "C1",
    });
    const unknown = await tool.execute("call-16b", {
      action: "wat",
    });

    expect(getText(legacy)).toContain("Legacy action \"read_messages\"");
    expect(getText(legacy)).toContain("readMessages");
    expect(getText(unknown)).toContain("Unknown action");
  });
});
