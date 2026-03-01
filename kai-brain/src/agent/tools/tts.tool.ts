/**
 * TTS (Text-to-Speech) Tool
 *
 * Converts text to speech audio using configurable providers.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const TtsSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech" }),
  voice: Type.Optional(Type.String({ description: "Voice name/ID (provider-specific)" })),
});

type TtsArgs = Static<typeof TtsSchema>;

export function createTtsTool(): ToolDefinition {
  return {
    name: "tts",
    label: "Text to Speech",
    description: `Convert text to speech audio. Returns a file path to the generated audio.
Use slack_message with filePath to share the audio with the user.`,
    parameters: TtsSchema,
    execute: async (
      _toolCallId: string,
      args: TtsArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return text("TTS not available: OPENAI_API_KEY not set. OpenAI's TTS API is used for speech generation.");
      }

      try {
        const voice = args.voice || "alloy";
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            input: args.text.slice(0, 4096),
            voice,
          }),
        });

        if (!response.ok) {
          return text(`TTS error: ${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const dir = join(process.cwd(), ".sandbox", "tts");
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `speech-${Date.now()}.mp3`);
        await writeFile(filePath, buffer);

        return text(`Audio generated (${(buffer.length / 1024).toFixed(1)} KB). File: ${filePath}\nUse slack_message with filePath to share.`);
      } catch (error) {
        return text(`TTS error: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
