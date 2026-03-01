/**
 * TTS Service
 *
 * Text-to-speech synthesis for automatic reply audio.
 * Supports OpenAI TTS API and ElevenLabs.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../lib/config-loader.js";

export type TtsMode = "off" | "final";

export function resolveTtsMode(): TtsMode {
  const raw = getConfig().slack.ttsMode.toLowerCase();
  return raw === "final" ? "final" : "off";
}

export interface TtsSynthResult {
  filePath: string;
  sizeBytes: number;
}

export async function synthesizeSpeech(text: string): Promise<TtsSynthResult | null> {
  const provider = getConfig().tts.provider.toLowerCase();

  if (provider === "elevenlabs") {
    return synthesizeElevenLabs(text);
  }
  return synthesizeOpenAI(text);
}

async function synthesizeOpenAI(text: string): Promise<TtsSynthResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const voice = getConfig().tts.voice;
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text.slice(0, 4096),
      voice,
    }),
  });

  if (!response.ok) {
    console.error(`[TTS] OpenAI error: ${response.status} ${response.statusText}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = join(process.cwd(), ".sandbox", "tts");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `reply-${Date.now()}.mp3`);
  await writeFile(filePath, buffer);

  return { filePath, sizeBytes: buffer.length };
}

async function synthesizeElevenLabs(text: string): Promise<TtsSynthResult | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const voiceId = getConfig().tts.elevenLabsVoiceId;
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: "eleven_monolingual_v1",
    }),
  });

  if (!response.ok) {
    console.error(`[TTS] ElevenLabs error: ${response.status} ${response.statusText}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = join(process.cwd(), ".sandbox", "tts");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `reply-${Date.now()}.mp3`);
  await writeFile(filePath, buffer);

  return { filePath, sizeBytes: buffer.length };
}
