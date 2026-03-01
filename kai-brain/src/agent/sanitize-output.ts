/**
 * Output Sanitization Pipeline
 *
 * Handles:
 * - stripReasoningTagsFromText
 * - stripMinimaxToolCallXml, stripDowngradedToolCallText, stripThinkingTagsFromText
 * - sanitizeUserFacingText, collapseConsecutiveDuplicateBlocks, stripFinalTagsFromText
 * - normalizeTextForComparison, isMessagingToolDuplicate
 */

// ===== reasoning-tags.ts =====

type ReasoningTagMode = "strict" | "preserve";
type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE_REASONING = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

interface CodeRegion {
  start: number;
  end: number;
}

function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start = (match.index ?? 0) + match[1].length;
    regions.push({ start, end: start + match[0].length - match[1].length });
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") return value;
  if (mode === "start") return value.trimStart();
  return value.trim();
}

function stripReasoningTagsFromText(
  text: string,
  options?: { mode?: ReasoningTagMode; trim?: ReasoningTagTrim },
): string {
  if (!text) return text;
  if (!QUICK_TAG_RE.test(text)) return text;

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";

  let cleaned = text;
  if (FINAL_TAG_RE_REASONING.test(cleaned)) {
    FINAL_TAG_RE_REASONING.lastIndex = 0;
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of cleaned.matchAll(FINAL_TAG_RE_REASONING)) {
      const start = match.index ?? 0;
      finalMatches.push({
        start,
        length: match[0].length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  } else {
    FINAL_TAG_RE_REASONING.lastIndex = 0;
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) continue;

    if (!inThinking) {
      result += cleaned.slice(lastIndex, idx);
      if (!isClose) inThinking = true;
    } else if (isClose) {
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  return applyTrim(result, trimMode);
}

// ===== pi-embedded-utils.ts =====

function stripMinimaxToolCallXml(text: string): string {
  if (!text) return text;
  if (!/minimax:tool_call/i.test(text)) return text;
  let cleaned = text.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, "");
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");
  return cleaned;
}

function stripDowngradedToolCallText(text: string): string {
  if (!text) return text;
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) return text;

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") { index++; continue; }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) { index++; continue; }
      break;
    }
    if (index >= input.length) return null;

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = index; i < input.length; i++) {
        const ch = input[i];
        if (inString) {
          if (escape) { escape = false; }
          else if (ch === "\\") { escape = true; }
          else if (ch === '"') { inString = false; }
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") { depth++; continue; }
        if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let i = index + 1; i < input.length; i++) {
        const ch = input[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') return i + 1;
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") end++;
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const markerRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(markerRe)) {
      const start = match.index ?? 0;
      if (start < cursor) continue;
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) index++;
      if (input[index] === "\r") { index++; if (input[index] === "\n") index++; }
      else if (input[index] === "\n") index++;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) index++;
      if (input.slice(index, index + 9).toLowerCase() === "arguments") {
        index += 9;
        if (input[index] === ":") index++;
        if (input[index] === " ") index++;
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) index = end;
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") index++;
        if (input[index] === "\n") index++;
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  let cleaned = stripToolCalls(text);
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");
  return cleaned.trim();
}

function stripThinkingTagsFromText(text: string): string {
  return stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
}

// ===== errors.ts (text transformations only) =====

const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;

function stripFinalTagsFromText(text: string): string {
  if (!text) return text;
  return text.replace(FINAL_TAG_RE, "");
}

function collapseConsecutiveDuplicateBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length < 2) return text;

  const normalizeBlock = (value: string) => value.trim().replace(/\s+/g, " ");
  const result: string[] = [];
  let lastNormalized: string | null = null;

  for (const block of blocks) {
    const normalized = normalizeBlock(block);
    if (lastNormalized && normalized === lastNormalized) continue;
    result.push(block.trim());
    lastNormalized = normalized;
  }

  if (result.length === blocks.length) return text;
  return result.join("\n\n");
}

function sanitizeUserFacingText(text: string): string {
  if (!text) return text;
  const stripped = stripFinalTagsFromText(text);
  const trimmed = stripped.trim();
  if (!trimmed) return stripped;
  return collapseConsecutiveDuplicateBlocks(stripped);
}

// ===== messaging-dedupe.ts =====

const MIN_DUPLICATE_TEXT_LENGTH = 10;

export function normalizeTextForComparison(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) return false;
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
    return normalized.includes(normalizedSent) || normalizedSent.includes(normalized);
  });
}

export function isMessagingToolDuplicate(text: string, sentTexts: string[]): boolean {
  if (sentTexts.length === 0) return false;
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
  return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}

// ===== Main export: sanitizeAssistantOutput =====
// Pipeline order:
// Per block: stripMinimaxToolCallXml -> stripDowngradedToolCallText -> stripThinkingTagsFromText -> trim
// Then: sanitizeUserFacingText (stripFinalTags -> collapseConsecutiveDuplicateBlocks)

export function sanitizeAssistantOutput(text: string): string {
  if (!text) return text;
  let result = text;
  result = stripMinimaxToolCallXml(result);
  result = stripDowngradedToolCallText(result);
  result = stripThinkingTagsFromText(result);
  result = result.replace(/\[\[\s*reply_to[^\]]*\]\]/g, "");
  result = result.trim();
  result = sanitizeUserFacingText(result);
  return result;
}
