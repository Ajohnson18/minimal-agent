import { describe, expect, test } from "vitest";

import {
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunked,
} from "../../../src/lib/slack/format.js";

describe("slack format", () => {
  test("converts markdown links and styling to slack mrkdwn", () => {
    const out = markdownToSlackMrkdwn(
      "**Bold** and [OpenAI](https://openai.com) plus `code`",
    );

    expect(out).toContain("*Bold*");
    expect(out).toContain("<https://openai.com|OpenAI>");
    expect(out).toContain("`code`");
  });

  test("escapes unsafe angle bracket tokens", () => {
    const out = markdownToSlackMrkdwn("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;/script&gt;");
  });

  test("chunks long markdown while balancing code fences", () => {
    const markdown = [
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
      "",
      "Paragraph ".repeat(200),
    ].join("\n");

    const chunks = markdownToSlackMrkdwnChunked(markdown, 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }
  });

  test("preserves inline code when punctuation is adjacent", () => {
    const out = markdownToSlackMrkdwn("Use `foo()`., then `bar`!");
    expect(out).toContain("`foo()`.,");
    expect(out).toContain("`bar`!");
  });

  test("supports inline code containing backticks without marker collision", () => {
    const out = markdownToSlackMrkdwn("Value: ``a `tick` value``.");
    expect(out).toContain("``a `tick` value``.");
  });

  test("preserves list and paragraph line breaks", () => {
    const out = markdownToSlackMrkdwn([
      "- first item",
      "  continuation line",
      "",
      "- second item",
    ].join("\n"));

    expect(out).toContain("• first item");
    expect(out).toContain("continuation line");
    expect(out).toContain("• second item");
  });
});
