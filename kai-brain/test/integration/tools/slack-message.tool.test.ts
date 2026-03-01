import { beforeEach, describe, expect, test, vi } from "vitest";

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const mockState = vi.hoisted(() => {
  const postMessageMock = vi.fn();
  const conversationsOpenMock = vi.fn();

  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const uploadFileToSlackMock = vi.fn();
  const sendSlackMessageWithMediaMock = vi.fn();

  return {
    postMessageMock,
    conversationsOpenMock,
    limitMock,
    whereMock,
    fromMock,
    selectMock,
    uploadFileToSlackMock,
    sendSlackMessageWithMediaMock,
  };
});

vi.mock("../../../src/lib/slack/app.js", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        postMessage: mockState.postMessageMock,
      },
      conversations: {
        open: mockState.conversationsOpenMock,
      },
    },
  }),
}));

vi.mock("../../../src/lib/slack/files.js", () => ({
  uploadFileToSlack: mockState.uploadFileToSlackMock,
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

describe("integration: slack_message tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockState.limitMock.mockResolvedValue([
      {
        source: "slack",
        externalId: "slack:C123:1700000000.123456",
      },
    ]);

    mockState.postMessageMock.mockResolvedValue({ ts: "1700001111.222222" });
    mockState.conversationsOpenMock.mockResolvedValue({ channel: { id: "D123" } });
    mockState.uploadFileToSlackMock.mockResolvedValue({ ok: true, fileId: "F123" });
    mockState.sendSlackMessageWithMediaMock.mockResolvedValue({ ok: true });
  });

  async function createTool() {
    const { createSlackMessageTool } = await import("../../../src/agent/tools/slack-message.tool.js");
    return createSlackMessageTool({ userId: "user-1", sessionId: "session-1" });
  }

  test("sends text in current thread by default", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-1", {
      message: "Hello",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C123",
      text: "Hello",
      thread_ts: "1700000000.123456",
      mrkdwn: true,
    });
    expect((result.details as { ok?: boolean }).ok).toBe(true);
  });

  test("converts markdown to Slack mrkdwn when sending text", async () => {
    const tool = await createTool();

    await tool.execute("call-1b", {
      message: "**Bold** and [Docs](https://example.com/docs)",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C123",
      text: "*Bold* and <https://example.com/docs|Docs>",
      thread_ts: "1700000000.123456",
      mrkdwn: true,
    });
  });

  test("opens DM channel for U... targets", async () => {
    const tool = await createTool();

    await tool.execute("call-2", {
      target: "U999",
      message: "Direct hello",
    });

    expect(mockState.conversationsOpenMock).toHaveBeenCalledWith({ users: "U999" });
    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "D123",
      text: "Direct hello",
      mrkdwn: true,
    });
  });

  test("sends URL media via media upload flow", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-3", {
      target: "channel:C777",
      media: "https://example.com/chart.png",
      message: "Latest chart",
    });

    expect(mockState.sendSlackMessageWithMediaMock).toHaveBeenCalledWith({
      channelId: "C777",
      threadTs: undefined,
      text: "Latest chart",
      mediaUrl: "https://example.com/chart.png",
    });

    expect((result.details as { operation?: string }).operation).toBe("sendMedia");
  });

  test("uploads filePath and enforces path validation", async () => {
    const tool = await createTool();
    const tempFile = join("/tmp", `ava-slack-message-${Date.now()}.txt`);
    await writeFile(tempFile, "hello", "utf-8");

    try {
      const success = await tool.execute("call-4a", {
        filePath: tempFile,
        message: "Report",
      });

      expect(mockState.uploadFileToSlackMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: tempFile,
          filename: expect.stringMatching(/ava-slack-message-/),
          initialComment: "Report",
        }),
      );
      expect((success.details as { operation?: string }).operation).toBe("uploadFilePath");

      const invalid = await tool.execute("call-4b", {
        filePath: "/etc/passwd",
        message: "should fail",
      });

      expect(getText(invalid)).toContain("File path must be within the project directory or /tmp");
    } finally {
      await rm(tempFile, { force: true });
    }
  });

  test("uploads base64 buffer payloads", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-5", {
      buffer: Buffer.from("hello world").toString("base64"),
      filename: "hello.txt",
      message: "Buffer upload",
    });

    expect(mockState.uploadFileToSlackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "hello.txt",
        initialComment: "Buffer upload",
      }),
    );
    expect((result.details as { operation?: string }).operation).toBe("uploadBuffer");
  });

  test("uploads inline content payloads", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-6", {
      content: "a,b\n1,2",
      filename: "data.csv",
      message: "CSV",
    });

    expect(mockState.uploadFileToSlackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "a,b\n1,2",
        filename: "data.csv",
        initialComment: "CSV",
      }),
    );
    expect((result.details as { operation?: string }).operation).toBe("uploadContent");
  });

  test("threadId overrides current thread", async () => {
    const tool = await createTool();

    await tool.execute("call-7", {
      message: "Thread override",
      threadId: "9999999999.999999",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C123",
      text: "Thread override",
      thread_ts: "9999999999.999999",
      mrkdwn: true,
    });
  });

  test("legacy params are rejected with migration guidance", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-8", {
      text: "legacy",
    });

    expect(getText(result)).toContain('Legacy parameter "text"');
    expect(getText(result)).toContain('Use "message"');
  });

  test("successful sends always return structured details", async () => {
    const tool = await createTool();

    const result = await tool.execute("call-9", {
      message: "Hello details",
    });

    const details = result.details as {
      ok?: boolean;
      operation?: string;
      channelId?: string;
      messageId?: string;
    };

    expect(details.ok).toBe(true);
    expect(details.operation).toBe("sendMessage");
    expect(details.channelId).toBe("C123");
    expect(details.messageId).toBe("1700001111.222222");
  });

  test("subagent session without explicit target is rejected", async () => {
    mockState.limitMock.mockResolvedValueOnce([
      {
        source: "subagent",
        externalId: null,
      },
    ]);

    const tool = await createTool();
    const result = await tool.execute("call-subagent-1", {
      message: "Should not send implicitly",
    });

    expect(getText(result)).toContain("must provide an explicit Slack target");
    expect(mockState.postMessageMock).not.toHaveBeenCalled();
  });

  test("subagent session with explicit target is allowed", async () => {
    mockState.limitMock.mockResolvedValueOnce([
      {
        source: "subagent",
        externalId: null,
      },
    ]);

    const tool = await createTool();
    const result = await tool.execute("call-subagent-2", {
      target: "channel:C777",
      message: "Explicit target send",
    });

    expect(mockState.postMessageMock).toHaveBeenCalledWith({
      channel: "C777",
      text: "Explicit target send",
      mrkdwn: true,
    });
    expect((result.details as { ok?: boolean }).ok).toBe(true);
  });
});
