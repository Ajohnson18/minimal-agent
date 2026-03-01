/**
 * Markdown IR Renderer
 *
 * Renders a MarkdownIR to a target format using style markers and escape functions.
 */
import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";

export type RenderStyleMarker = { open: string; close: string };
export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;

export type RenderLink = { start: number; end: number; open: string; close: string };

export type RenderOptions = {
  styleMarkers: RenderStyleMap;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
};

const STYLE_ORDER: MarkdownStyle[] = ["blockquote", "code_block", "code", "bold", "italic", "strikethrough", "spoiler"];
const STYLE_RANK = new Map(STYLE_ORDER.map((style, index) => [style, index]));

function buildInlineCodeMarker(segment: string): { open: string; close: string } {
  let longestRun = 0;
  let currentRun = 0;
  for (const ch of segment) {
    if (ch === "`") {
      currentRun += 1;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  const marker = "`".repeat(Math.max(1, longestRun + 1));
  if (segment.startsWith("`") || segment.endsWith("`")) {
    return { open: `${marker} `, close: ` ${marker}` };
  }
  return { open: marker, close: marker };
}

export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) return "";

  const { styleMarkers } = options;
  const styled = [...ir.styles]
    .filter((s) => Boolean(styleMarkers[s.style]))
    .sort((a, b) => a.start - b.start || b.end - a.end || (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0));

  const boundaries = new Set<number>([0, text.length]);
  const startsAt = new Map<number, MarkdownStyleSpan[]>();

  for (const span of styled) {
    if (span.start === span.end) continue;
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) bucket.push(span);
    else startsAt.set(span.start, [span]);
  }

  for (const spans of startsAt.values()) {
    spans.sort((a, b) => b.end - a.end || (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0));
  }

  const linkStarts = new Map<number, RenderLink[]>();
  if (options.buildLink) {
    for (const link of ir.links) {
      if (link.start === link.end) continue;
      const rendered = options.buildLink(link, text);
      if (!rendered) continue;
      boundaries.add(rendered.start);
      boundaries.add(rendered.end);
      const bucket = linkStarts.get(rendered.start);
      if (bucket) bucket.push(rendered);
      else linkStarts.set(rendered.start, [rendered]);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const stack: { close: string; end: number }[] = [];
  let out = "";

  for (let i = 0; i < points.length; i++) {
    const pos = points[i];

    while (stack.length && stack[stack.length - 1]?.end === pos) {
      out += stack.pop()!.close;
    }

    type OpenItem = { end: number; open: string; close: string; kind: "link" | "style"; style?: MarkdownStyle; index: number };
    const openItems: OpenItem[] = [];

    const openLinks = linkStarts.get(pos);
    if (openLinks) {
      for (const [index, link] of openLinks.entries()) {
        openItems.push({ end: link.end, open: link.open, close: link.close, kind: "link", index });
      }
    }

    const openStyles = startsAt.get(pos);
    if (openStyles) {
      for (const [index, span] of openStyles.entries()) {
        const marker =
          span.style === "code"
            ? buildInlineCodeMarker(text.slice(span.start, span.end))
            : styleMarkers[span.style];
        if (!marker) continue;
        openItems.push({ end: span.end, open: marker.open, close: marker.close, kind: "style", style: span.style, index });
      }
    }

    if (openItems.length > 0) {
      openItems.sort((a, b) => {
        if (a.end !== b.end) return b.end - a.end;
        if (a.kind !== b.kind) return a.kind === "link" ? -1 : 1;
        if (a.kind === "style" && b.kind === "style") {
          return (STYLE_RANK.get(a.style!) ?? 0) - (STYLE_RANK.get(b.style!) ?? 0);
        }
        return a.index - b.index;
      });
      for (const item of openItems) {
        out += item.open;
        stack.push({ close: item.close, end: item.end });
      }
    }

    const next = points[i + 1];
    if (next === undefined) break;
    if (next > pos) out += options.escapeText(text.slice(pos, next));
  }

  return out;
}
