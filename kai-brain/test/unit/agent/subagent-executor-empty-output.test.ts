import { describe, expect, test, vi } from "vitest";

import { __testing } from "../../../src/agent/subagent-executor.js";

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

describe("subagent executor empty-output recovery", () => {
  test("returns existing assistant content without recovery prompt", async () => {
    const messages = [assistantMessage("Final answer from subagent.")];
    const prompt = vi.fn(async () => {});

    const content = await __testing.resolveFinalSubagentContent({
      messages,
      prompt,
    });

    expect(content).toBe("Final answer from subagent.");
    expect(prompt).not.toHaveBeenCalled();
  });

  test("runs one forced finalization prompt when initial content is empty", async () => {
    const messages = [assistantMessage("   ")];
    const prompt = vi.fn(async (recoveryPrompt: string) => {
      expect(recoveryPrompt).toContain("Do not call any tools in this step.");
      messages.push(assistantMessage("No data was found for this query."));
    });

    const content = await __testing.resolveFinalSubagentContent({
      messages,
      prompt,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(content).toBe("No data was found for this query.");
  });

  test("throws canonical empty-output error when recovery still yields nothing", async () => {
    const messages = [assistantMessage("")];
    const prompt = vi.fn(async () => {
      messages.push(assistantMessage("   "));
    });

    await expect(
      __testing.resolveFinalSubagentContent({
        messages,
        prompt,
      }),
    ).rejects.toThrow("empty-subagent-output");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
