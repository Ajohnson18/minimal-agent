import { describe, expect, test } from "vitest";

import {
  isMessagingToolDuplicate,
  normalizeTextForComparison,
  sanitizeAssistantOutput,
} from "../../../src/agent/sanitize-output.js";

describe("sanitize-output", () => {
  test("strips reasoning/final tags and downgraded tool transcripts", () => {
    const input = [
      "<thinking>internal chain of thought</thinking>",
      "<final>Result below</final>",
      "[Tool Call: web_search]",
      "Arguments: {\"query\":\"test\"}",
      "[Tool Result for ID call_123]",
      "hidden output",
    ].join("\n");

    const output = sanitizeAssistantOutput(input);

    expect(output).toContain("Result below");
    expect(output).not.toContain("internal chain of thought");
    expect(output).not.toContain("Tool Call");
    expect(output).not.toContain("Tool Result");
  });

  test("preserves reasoning-like tags inside fenced code blocks", () => {
    const input = [
      "<thinking>hide me</thinking>",
      "```xml",
      "<thinking>should stay</thinking>",
      "</thinking>",
      "```",
      "visible",
    ].join("\n");

    const output = sanitizeAssistantOutput(input);

    expect(output).toContain("```xml");
    expect(output).toContain("<thinking>should stay</thinking>");
    expect(output).toContain("visible");
    expect(output).not.toContain("hide me");
  });

  test("collapses consecutive duplicate blocks", () => {
    const input = ["Hello world", "", "Hello   world", "", "Final"].join("\n");
    const output = sanitizeAssistantOutput(input);

    expect(output).toBe("Hello world\n\nFinal");
  });

  test("treats legacy control tokens as plain text", () => {
    expect(sanitizeAssistantOutput("NO_REPLY")).toBe("NO_REPLY");
    expect(sanitizeAssistantOutput("HEARTBEAT_OK")).toBe("HEARTBEAT_OK");
  });

  test("detects duplicate tool message content with normalization", () => {
    const sent = ["Deployment completed successfully 🎉"];
    expect(
      isMessagingToolDuplicate("deployment completed successfully", sent),
    ).toBe(true);

    const normalized = normalizeTextForComparison("Different output");
    expect(normalized).toBe("different output");
    expect(isMessagingToolDuplicate("Short", ["ok"])).toBe(false);
  });
});
