/**
 * Image Analysis Tool
 *
 * Allows the agent to proactively analyze images (file path, URL, or base64).
 * Supports multiple images in a single call (up to 20).
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const MAX_IMAGES = 20;

const ImageSchema = Type.Object({
  image: Type.String({
    description: "Image source: file path, URL, or base64 data URL (data:image/png;base64,...)",
  }),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Additional images to analyze together (up to ${MAX_IMAGES} total). Each can be a file path, URL, or base64 data URL.`,
    })
  ),
  prompt: Type.Optional(
    Type.String({ description: "What to analyze (default: general description)" })
  ),
});

type ImageArgs = Static<typeof ImageSchema>;

interface ImageData {
  base64: string;
  mimeType: string;
}

/**
 * Resolve an image source (path/URL/data URL) to base64 + mimeType.
 */
async function resolveImage(source: string): Promise<ImageData> {
  if (source.startsWith("data:")) {
    const match = source.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL format");
    return { base64: match[2], mimeType: match[1] };
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const ct = response.headers.get("content-type");
    return {
      base64: buffer.toString("base64"),
      mimeType: ct?.split(";")[0] || "image/jpeg",
    };
  }

  // File path
  const buffer = await readFile(source);
  const ext = basename(source).split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  return {
    base64: buffer.toString("base64"),
    mimeType: mimeMap[ext || ""] || "image/jpeg",
  };
}

export function createImageTool(): ToolDefinition {
  return {
    name: "analyze_image",
    label: "Analyze Image",
    description: `Analyze an image using vision AI. Accepts file paths, URLs, or base64 data URLs.
Use this to examine screenshots, charts, photos, or any visual content.`,
    parameters: ImageSchema,
    execute: async (
      _toolCallId: string,
      args: ImageArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const prompt = args.prompt || "Describe this image concisely. Focus on key content, text, data, or information shown.";

        // Collect all image sources
        const sources = [args.image];
        if (args.images?.length) {
          sources.push(...args.images);
        }

        if (sources.length > MAX_IMAGES) {
          return text(`Error: Too many images (${sources.length}). Maximum is ${MAX_IMAGES}. Do not retry with more than ${MAX_IMAGES} images.`);
        }

        // Resolve all images in parallel
        const imageResults = await Promise.allSettled(
          sources.map((s, i) => resolveImage(s).catch(e => {
            throw new Error(`Image ${i + 1}: ${e instanceof Error ? e.message : e}`);
          }))
        );

        // Build parts for the API call
        const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];
        const errors: string[] = [];

        for (let i = 0; i < imageResults.length; i++) {
          const result = imageResults[i];
          if (result.status === 'fulfilled') {
            parts.push({
              inlineData: { data: result.value.base64, mimeType: result.value.mimeType },
            });
          } else {
            errors.push(`Image ${i + 1}: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
          }
        }

        if (parts.length === 0) {
          return text(`Error: All images failed to load:\n${errors.join('\n')}\nDo not retry without valid image sources.`);
        }

        // Add prompt as text part
        const imageCountNote = sources.length > 1 ? `\n\n(Analyzing ${parts.length} image(s)${errors.length > 0 ? `, ${errors.length} failed to load` : ''})` : '';
        parts.push({ text: prompt + imageCountNote });

        // Call Gemini vision
        const { getAccessToken } = await import("../../services/auth.service.js");
        const accessToken = await getAccessToken();
        const projectId = process.env.VERTEX_AI_PROJECT_ID;
        const { getConfig } = await import("../../lib/config-loader.js");
        const location = getConfig().vertex.location;

        if (!projectId) return text("Error: VERTEX_AI_PROJECT_ID not set. Do not retry — this is a configuration issue.");

        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/gemini-2.0-flash:generateContent`;
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
          }),
        });

        if (!response.ok) return text(`Error: Gemini API ${response.status} ${response.statusText}`);
        const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "(No description generated)";

        // Prepend warnings for any failed images
        const prefix = errors.length > 0 ? `⚠️ Some images failed to load:\n${errors.join('\n')}\n\n` : '';
        return text(prefix + result);
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
