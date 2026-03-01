/**
 * Media Understanding Service
 *
 * Processes media files (images, audio, video, PDFs) before the agent sees them.
 * Features: multi-provider (Gemini + OpenAI Whisper fallback), video support,
 * concurrency control, vision-skip optimization.
 */
import { readFile } from "node:fs/promises";
import type { DownloadedFile } from "../lib/slack/files.js";
import { getConfig } from "../lib/config-loader.js";
import { buildVertexUrl } from "../agent/pi-provider.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "wma"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv"]);
const PDF_EXTENSIONS = new Set(["pdf"]);

const MAX_CONCURRENT = 2;

export interface MediaResult {
  fileName: string;
  type: "image" | "audio" | "video" | "pdf" | "unknown";
  description?: string;
  error?: string;
  skipped?: boolean;
}

function getFileExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function getMediaType(file: DownloadedFile): MediaResult["type"] {
  const ext = getFileExtension(file.name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (file.mimetype?.startsWith("image/")) return "image";
  if (file.mimetype?.startsWith("audio/")) return "audio";
  if (file.mimetype?.startsWith("video/")) return "video";
  if (file.mimetype === "application/pdf") return "pdf";
  return "unknown";
}

// --- Gemini provider ---

async function callGeminiWithMedia(
  base64Data: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const projectId = process.env.VERTEX_AI_PROJECT_ID;
  const location = getConfig().vertex.location;
  const model = "gemini-2.0-flash";

  if (!projectId) return "(Media analysis unavailable: VERTEX_AI_PROJECT_ID not set)";

  const { getAccessToken } = await import("./auth.service.js");
  const accessToken = await getAccessToken();

  const url = buildVertexUrl(projectId, location, model, "generateContent");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: base64Data, mimeType } },
            { text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "(No description generated)";
}

// --- OpenAI Whisper fallback ---

async function transcribeWithWhisper(filePath: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const fileData = await readFile(filePath);
    const fileName = filePath.split("/").pop() || "audio.mp3";

    const formData = new FormData();
    formData.append("file", new Blob([fileData]), fileName);
    formData.append("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) return null;
    const result = (await response.json()) as { text?: string };
    return result.text || null;
  } catch {
    return null;
  }
}

// --- Processing functions ---

async function analyzeImage(filePath: string): Promise<string> {
  try {
    const imageData = await readFile(filePath);
    const base64 = imageData.toString("base64");
    const ext = getFileExtension(filePath);
    const mimeMap: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp" };
    const mimeType = mimeMap[ext] || "image/jpeg";

    return await callGeminiWithMedia(
      base64, mimeType,
      "Describe this image concisely. Focus on the key content, text, data, or information shown. If it's a chart or graph, describe the data and trends. If it contains text, transcribe the important parts."
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `(Image analysis failed: ${msg})`;
  }
}

async function transcribeAudio(filePath: string, fileName: string): Promise<string> {
  // Try Gemini first
  try {
    const audioData = await readFile(filePath);
    const base64 = audioData.toString("base64");
    const ext = getFileExtension(fileName);
    const mimeMap: Record<string, string> = { mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac" };
    const mimeType = mimeMap[ext] || "audio/mpeg";

    return await callGeminiWithMedia(base64, mimeType, "Transcribe this audio. Return only the transcription text, nothing else.");
  } catch {
    // Fall back to OpenAI Whisper
    const whisperResult = await transcribeWithWhisper(filePath);
    if (whisperResult) return whisperResult;
    return "(Audio transcription failed with all providers)";
  }
}

async function analyzeVideo(filePath: string): Promise<string> {
  try {
    const videoData = await readFile(filePath);
    const base64 = videoData.toString("base64");
    const ext = getFileExtension(filePath);
    const mimeMap: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
    const mimeType = mimeMap[ext] || "video/mp4";

    return await callGeminiWithMedia(
      base64, mimeType,
      "Describe this video concisely. Focus on the key content, actions, and information shown."
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `(Video analysis failed: ${msg})`;
  }
}

async function extractPdfText(filePath: string): Promise<string> {
  try {
    const pdfData = await readFile(filePath);
    const base64 = pdfData.toString("base64");
    return await callGeminiWithMedia(
      base64, "application/pdf",
      "Extract all text content from this PDF. Return the text preserving structure (headings, lists, tables). Be thorough."
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `(PDF text extraction failed: ${msg})`;
  }
}

// --- Concurrency control ---

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number
): Promise<T[]> {
  const results: T[] = [];
  const running: Promise<void>[] = [];

  for (const task of tasks) {
    const p = task().then((result) => { results.push(result); });
    running.push(p);

    if (running.length >= maxConcurrent) {
      await Promise.race(running);
      // Remove settled promises
      for (let i = running.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          running[i].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) running.splice(i, 1);
      }
    }
  }

  await Promise.all(running);
  return results;
}

// --- Public API ---

export interface ProcessMediaOptions {
  modelSupportsVision?: boolean;
}

export async function processMediaFiles(
  files: DownloadedFile[],
  options: ProcessMediaOptions = {}
): Promise<MediaResult[]> {
  const mediaFiles = files
    .map((file) => ({ file, type: getMediaType(file) }))
    .filter((f) => f.type !== "unknown");

  if (mediaFiles.length === 0) return [];

  const tasks = mediaFiles.map(({ file, type }) => async (): Promise<MediaResult> => {
    const result: MediaResult = { fileName: file.name, type };

    // Vision-skip: if the LLM model supports vision natively, skip image pre-processing
    if (type === "image" && options.modelSupportsVision) {
      result.skipped = true;
      result.description = "(Image attached — model will analyze directly)";
      return result;
    }

    try {
      switch (type) {
        case "image":
          result.description = await analyzeImage(file.localPath);
          break;
        case "audio":
          result.description = await transcribeAudio(file.localPath, file.name);
          break;
        case "video":
          result.description = await analyzeVideo(file.localPath);
          break;
        case "pdf":
          result.description = await extractPdfText(file.localPath);
          break;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  });

  return runWithConcurrency(tasks, MAX_CONCURRENT);
}

export function formatMediaContext(results: MediaResult[]): string | null {
  if (results.length === 0) return null;

  const parts: string[] = [];
  for (const r of results) {
    if (r.skipped) continue;
    if (r.error) {
      parts.push(`[${r.type}: ${r.fileName}]\nError: ${r.error}`);
    } else if (r.description) {
      const labels: Record<string, string> = {
        image: "Image",
        audio: "Audio Transcription",
        video: "Video",
        pdf: "PDF Content",
      };
      parts.push(`[${labels[r.type] || r.type}: ${r.fileName}]\n${r.description}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
