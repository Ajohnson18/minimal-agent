/**
 * Slack File Utilities
 *
 * Download and upload files from/to Slack.
 */
import { getSlackClient } from "./app.js";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

export interface DownloadedFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  localPath: string;
  content?: string;
  error?: string;
}

const SUPPORTED_TEXT_TYPES = new Set([
  "text",
  "javascript",
  "typescript",
  "python",
  "java",
  "c",
  "cpp",
  "go",
  "rust",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "shell",
  "bash",
  "zsh",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "xml",
  "yaml",
  "yml",
  "json",
  "markdown",
  "md",
  "txt",
  "csv",
  "tsv",
  "log",
  "ini",
  "toml",
  "dockerfile",
  "makefile",
  "gitignore",
  "env",
  "conf",
  "cfg",
]);

const MAX_TEXT_SIZE = 100 * 1024; // 100KB max for inline text
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max download

/**
 * Determine if file type supports text extraction
 */
export function isTextFile(filetype: string, mimetype: string): boolean {
  const ft = filetype.toLowerCase();
  if (SUPPORTED_TEXT_TYPES.has(ft)) return true;
  if (mimetype.startsWith("text/")) return true;
  if (mimetype === "application/json") return true;
  if (mimetype === "application/xml") return true;
  return false;
}

/**
 * Determine if file is a PDF
 */
export function isPdfFile(filetype: string, mimetype: string): boolean {
  return filetype === "pdf" || mimetype === "application/pdf";
}

/**
 * Determine if file is an image
 */
export function isImageFile(filetype: string, mimetype: string): boolean {
  const imageTypes = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  return (
    imageTypes.has(filetype.toLowerCase()) || mimetype.startsWith("image/")
  );
}

/**
 * Get temp directory for file downloads
 */
async function getTempDir(): Promise<string> {
  const dir = join(tmpdir(), "ava-slack-files");
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Download a file from Slack
 */
export async function downloadSlackFile(
  file: SlackFile
): Promise<DownloadedFile> {
  const downloadUrl = file.url_private_download || file.url_private;

  if (!downloadUrl) {
    return {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      localPath: "",
      error: "No download URL available",
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      localPath: "",
      error: `File too large (${Math.round(
        file.size / 1024 / 1024
      )}MB). Max: 10MB`,
    };
  }

  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN not set");
    }

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const tempDir = await getTempDir();
    const localPath = join(tempDir, `${randomUUID()}-${file.name}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const fileHandle = createWriteStream(localPath);

    await new Promise<void>((resolve, reject) => {
      fileHandle.write(buffer, (err) => {
        if (err) reject(err);
        else {
          fileHandle.end();
          resolve();
        }
      });
    });

    const result: DownloadedFile = {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      localPath,
    };

    // Extract text content for supported types
    if (
      isTextFile(file.filetype, file.mimetype) &&
      file.size <= MAX_TEXT_SIZE
    ) {
      result.content = buffer.toString("utf-8");
    }

    return result;
  } catch (error) {
    return {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      localPath: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Extract text from a PDF file
 */
export async function extractPdfText(localPath: string): Promise<string> {
  try {
    // Dynamic import to avoid issues if pdf-parse not installed
    const pdfParseModule = (await import("pdf-parse")) as any;
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const buffer = await readFile(localPath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error("Failed to extract PDF text:", error);
    return `[Could not extract PDF text: ${
      error instanceof Error ? error.message : String(error)
    }]`;
  }
}

/**
 * Process downloaded files and prepare context for agent
 */
export async function processFilesForAgent(
  files: DownloadedFile[]
): Promise<string> {
  const parts: string[] = [];

  for (const file of files) {
    if (file.error) {
      parts.push(`\n### File: ${file.name}\n[Error: ${file.error}]`);
      continue;
    }

    parts.push(
      `\n### File: ${file.name} (${file.filetype}, ${formatSize(file.size)})`
    );

    if (file.content) {
      // Text content already extracted
      parts.push("```" + getLanguage(file.filetype));
      parts.push(file.content);
      parts.push("```");
    } else if (isPdfFile(file.filetype, file.mimetype)) {
      // Extract PDF text
      const text = await extractPdfText(file.localPath);
      if (text.length > MAX_TEXT_SIZE) {
        parts.push(
          `[PDF content truncated to first ${MAX_TEXT_SIZE} characters]`
        );
        parts.push(text.slice(0, MAX_TEXT_SIZE));
      } else {
        parts.push(text);
      }
    } else if (isImageFile(file.filetype, file.mimetype)) {
      parts.push(`[Image file - path: ${file.localPath}]`);
    } else {
      parts.push(`[Binary file - type: ${file.mimetype}]`);
    }
  }

  return parts.join("\n");
}

/**
 * Upload a file to Slack
 */
export async function uploadFileToSlack(options: {
  channelId: string;
  threadTs?: string;
  filePath?: string;
  content?: string;
  filename: string;
  title?: string;
  initialComment?: string;
}): Promise<{ ok: boolean; fileId?: string; error?: string }> {
  try {
    const client = getSlackClient();

    let fileContent: Buffer;
    if (options.filePath) {
      fileContent = await readFile(options.filePath);
    } else if (options.content) {
      fileContent = Buffer.from(options.content, "utf-8");
    } else {
      throw new Error("Either filePath or content must be provided");
    }

    // Build upload args - thread_ts is optional
    const uploadArgs: any = {
      channel_id: options.channelId,
      file: fileContent,
      filename: options.filename,
      title: options.title || options.filename,
      initial_comment: options.initialComment,
    };

    // Only include thread_ts if provided
    if (options.threadTs) {
      uploadArgs.thread_ts = options.threadTs;
    }

    const result = await client.filesUploadV2(uploadArgs);

    // filesUploadV2 returns files array
    const files = result.files as unknown as Array<{ id?: string }> | undefined;
    const fileId = files?.[0]?.id;

    return { ok: true, fileId };
  } catch (error) {
    console.error("Failed to upload file to Slack:", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a Slack message with a media URL (downloads and uploads as file).
 */
export async function sendSlackMessageWithMedia(options: {
  channelId: string;
  threadTs?: string;
  text?: string;
  mediaUrl: string;
  maxBytes?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getSlackClient();
    const response = await fetch(options.mediaUrl);
    if (!response.ok) {
      throw new Error(`Failed to download media: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (options.maxBytes && buffer.length > options.maxBytes) {
      throw new Error(`Media too large: ${Math.round(buffer.length / 1024 / 1024)}MB`);
    }

    // Infer filename from URL
    const urlPath = new URL(options.mediaUrl).pathname;
    const filename = urlPath.split("/").pop() || "media";

    const uploadArgs: any = {
      channel_id: options.channelId,
      file: buffer,
      filename,
      initial_comment: options.text,
    };
    if (options.threadTs) {
      uploadArgs.thread_ts = options.threadTs;
    }

    await client.filesUploadV2(uploadArgs);
    return { ok: true };
  } catch (error) {
    console.error("Failed to send media to Slack:", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clean up temporary file
 */
export async function cleanupTempFile(localPath: string): Promise<void> {
  try {
    await unlink(localPath);
  } catch {
    // Ignore cleanup errors
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function getLanguage(filetype: string): string {
  const mapping: Record<string, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    java: "java",
    go: "go",
    rust: "rust",
    ruby: "ruby",
    php: "php",
    swift: "swift",
    kotlin: "kotlin",
    scala: "scala",
    shell: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    markdown: "markdown",
    md: "markdown",
  };
  return mapping[filetype.toLowerCase()] || "";
}
