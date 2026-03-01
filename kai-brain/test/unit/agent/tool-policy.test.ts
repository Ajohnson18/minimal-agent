import { beforeEach, describe, expect, test, vi } from "vitest";

const slackExecuteSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
    details: { ok: true },
  })),
);

vi.mock("../../../src/agent/tools/slack-message.tool.js", () => ({
  createSlackMessageTool: () => ({
    name: "slack_message",
    label: "Slack Message",
    description: "mock",
    parameters: {},
    execute: slackExecuteSpy,
  }),
}));

describe("tool policy wrapper path", () => {
  beforeEach(() => {
    slackExecuteSpy.mockClear();
  });

  test("blocks subagent slack_message without explicit target", async () => {
    const { createCustomTools } = await import("../../../src/agent/pi-converter.js");

    const tools = createCustomTools({
      userId: "u-1",
      sessionId: "s-1",
      sessionSource: "subagent",
    });

    const slackTool = tools.find((tool) => tool.name === "slack_message");
    expect(slackTool).toBeDefined();

    const result = await slackTool!.execute!(
      "call-1",
      { message: "hello" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(slackExecuteSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      error: "tool_policy_blocked",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Tool blocked by policy"),
    });
  });

  test("allows subagent slack_message with explicit target", async () => {
    const { createCustomTools } = await import("../../../src/agent/pi-converter.js");

    const tools = createCustomTools({
      userId: "u-2",
      sessionId: "s-2",
      sessionSource: "subagent",
    });

    const slackTool = tools.find((tool) => tool.name === "slack_message");
    expect(slackTool).toBeDefined();

    const result = await slackTool!.execute!(
      "call-2",
      {
        target: "channel:C123",
        message: "hello",
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(slackExecuteSpy).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ ok: true });
  });

  test("allows non-subagent slack_message without explicit target", async () => {
    const { createCustomTools } = await import("../../../src/agent/pi-converter.js");

    const tools = createCustomTools({
      userId: "u-3",
      sessionId: "s-3",
      sessionSource: "slack",
    });

    const slackTool = tools.find((tool) => tool.name === "slack_message");
    expect(slackTool).toBeDefined();

    await slackTool!.execute!(
      "call-3",
      { message: "hello" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(slackExecuteSpy).toHaveBeenCalledTimes(1);
  });
});
