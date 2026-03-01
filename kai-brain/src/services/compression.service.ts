/**
 * Semantic Compression Service
 *
 * Uses Gemini Flash to semantically compress large tool results,
 * preserving key information instead of mechanical head/tail truncation.
 */
import { getAccessToken } from "./auth.service.js";
import { getConfig } from "../lib/config-loader.js";
import { buildVertexUrl } from "../agent/pi-provider.js";

const COMPRESSION_MODEL = "gemini-2.0-flash";
const DEFAULT_TARGET_CHARS = 4_000;
const MIN_COMPRESS_CHARS = 10_000;

/** Tools whose exact output matters — skip semantic compression, use mechanical truncation. */
const SKIP_TOOLS = new Set([
  "exec",
  "process",
  "python_exec",
  "sql_query",
]);

export function shouldSkipCompression(toolName: string): boolean {
  return SKIP_TOOLS.has(toolName);
}

/**
 * Semantically compress text using Gemini Flash.
 * Falls back to mechanical truncation on failure.
 */
export async function semanticCompress(
  text: string,
  opts?: {
    question?: string;
    targetChars?: number;
    toolName?: string;
  },
): Promise<string> {
  const targetChars = opts?.targetChars ?? DEFAULT_TARGET_CHARS;

  if (text.length <= MIN_COMPRESS_CHARS) {
    return text;
  }

  try {
    const compressed = await callGeminiCompress(text, {
      question: opts?.question,
      targetChars,
      toolName: opts?.toolName,
    });
    const prefix = `[Semantically compressed from ${text.length} chars]\n\n`;
    return prefix + compressed;
  } catch (error) {
    console.error("[COMPRESSION] Gemini Flash compression failed, using mechanical fallback:", error);
    return mechanicalTruncate(text, targetChars);
  }
}

/**
 * Call Gemini Flash to produce a semantic summary.
 */
async function callGeminiCompress(
  text: string,
  opts: { question?: string; targetChars: number; toolName?: string },
): Promise<string> {
  const projectId = process.env.VERTEX_AI_PROJECT_ID;
  const location = getConfig().vertex.location;

  if (!projectId) {
    throw new Error("VERTEX_AI_PROJECT_ID not set");
  }

  const accessToken = await getAccessToken();
  const url = buildVertexUrl(projectId, location, COMPRESSION_MODEL, "generateContent");

  const relevanceHint = opts.question
    ? `The user's current question is: "${opts.question}"\nPrioritize information relevant to this question.\n\n`
    : "";

  const toolHint = opts.toolName
    ? `This content came from the "${opts.toolName}" tool.\n`
    : "";

  const prompt = `You are a precise information compressor. Compress the following content to approximately ${opts.targetChars} characters while preserving ALL of the following:
- Key facts, findings, and conclusions
- Names, dates, numbers, and specific data points
- URLs and references
- Code snippets and technical details
- Error messages and status information
- Structural relationships between pieces of information

${relevanceHint}${toolHint}Do NOT add commentary, introductions, or meta-text. Output ONLY the compressed content.

---
${text}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.ceil(opts.targetChars / 3),
        temperature: 0.1,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini Flash API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!result) {
    throw new Error("Empty response from Gemini Flash");
  }

  return result.trim();
}

/**
 * Mechanical fallback: head + tail truncation (same logic as the old truncateToolResult).
 */
function mechanicalTruncate(text: string, targetChars: number): string {
  const headChars = Math.floor(targetChars * 0.7);
  const tailChars = Math.floor(targetChars * 0.2);
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const removed = text.length - headChars - tailChars;
  return `${head}\n\n[...truncated ${removed} chars...]\n\n${tail}`;
}
