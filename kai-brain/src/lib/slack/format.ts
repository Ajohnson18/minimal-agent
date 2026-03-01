/**
 * Slack Markdown Formatter
 *
 * Converts standard markdown to Slack mrkdwn format using the markdown IR.
 */
import { markdownToIR, type MarkdownLinkSpan } from "../markdown/ir.js";
import { renderMarkdownWithMarkers, type RenderLink } from "../markdown/render.js";

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) return false;
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnSegment(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_~])/g, "\\$1");
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) return text;

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (let match = SLACK_ANGLE_TOKEN_RE.exec(text); match; match = SLACK_ANGLE_TOKEN_RE.exec(text)) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) return text;
  return text
    .split("\n")
    .map((line) => line.startsWith("> ") ? `> ${escapeSlackMrkdwnContent(line.slice(2))}` : escapeSlackMrkdwnContent(line))
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string): RenderLink | null {
  const href = link.href.trim();
  if (!href) return null;
  const label = text.slice(link.start, link.end).trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  if (!label || label === href || label === comparableHref) return null;
  const safeHref = escapeSlackMrkdwnSegment(href);
  return { start: link.start, end: link.end, open: `<${safeHref}|`, close: ">" };
}

export function markdownToSlackMrkdwn(markdown: string): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: "code",  // Always use code blocks for tables (preserves structure)
  });
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
      spoiler: { open: "_(spoiler: ", close: ")_" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildSlackLink,
  });
}

export function markdownToSlackMrkdwnChunked(markdown: string, limit: number): string[] {
  const mrkdwn = markdownToSlackMrkdwn(markdown);
  if (mrkdwn.length <= limit) return [mrkdwn];

  // Simple chunking that respects code blocks
  const chunks: string[] = [];
  let remaining = mrkdwn;
  let openFence = "";

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push((openFence ? openFence + "\n" : "") + remaining);
      break;
    }

    let breakAt = -1;
    const slice = remaining.slice(0, limit);
    const paraBreak = slice.lastIndexOf("\n\n");
    if (paraBreak > limit * 0.3) breakAt = paraBreak;
    if (breakAt === -1) {
      const lineBreak = slice.lastIndexOf("\n");
      if (lineBreak > limit * 0.3) breakAt = lineBreak;
    }
    if (breakAt === -1) breakAt = limit;

    const cut = remaining.slice(0, breakAt);
    const fenceCount = (cut.match(/^```/gm) || []).length;
    let chunkText = (openFence ? openFence + "\n" : "") + cut;
    if (fenceCount % 2 !== 0) {
      chunkText += "\n```";
      openFence = "```";
    } else {
      openFence = "";
    }

    chunks.push(chunkText);
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}
