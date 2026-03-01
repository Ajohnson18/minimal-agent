import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import { extractPdfText } from "../lib/slack/files.js";
import type { ChatAttachment } from "./attachment-normalize.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const DEFAULT_MAX_ATTACHMENTS = 8;
const DEFAULT_MAX_BYTES_PER_ATTACHMENT = 5_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 15_000_000;
const DEFAULT_MAX_DOCUMENT_CHARS = 12_000;

const SUPPORTED_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

export type AttachmentHistoryBlock = {
  type: string;
  mimeType?: string;
  fileName?: string;
  omitted: true;
  bytes: number;
};

export type ParsedChatAttachments = {
  images: ImageContent[];
  historyBlocks: AttachmentHistoryBlock[];
  docContext?: string;
};

type ParseChatAttachmentsOptions = {
  maxAttachments?: number;
  maxBytesPerAttachment?: number;
  maxTotalBytes?: number;
  maxDocumentChars?: number;
};

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeBase64Content(input: string): { base64: string; mimeTypeFromDataUrl?: string } {
  const trimmed = input.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
  if (!dataUrlMatch) {
    return {
      base64: trimmed.replace(/\s+/g, ""),
    };
  }
  return {
    mimeTypeFromDataUrl: normalizeMimeType(dataUrlMatch[1]),
    base64: dataUrlMatch[2].trim().replace(/\s+/g, ""),
  };
}

function decodeBase64(label: string, base64: string): Buffer {
  if (!base64 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
    throw new Error(`attachment ${label}: invalid base64 content`);
  }
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length === 0) {
    throw new Error(`attachment ${label}: invalid base64 content`);
  }
  return decoded;
}

function sniffImageMimeType(data: Buffer): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  return undefined;
}

function inferMimeTypeFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const extension = fileName.split(".").pop()?.trim().toLowerCase();
  if (!extension) {
    return undefined;
  }
  return DOCUMENT_MIME_BY_EXTENSION[extension];
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function isSupportedDocumentMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType && SUPPORTED_DOCUMENT_MIMES.has(mimeType));
}

function clampDocumentText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(No extractable text)";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n...(truncated)...`;
}

async function extractDocumentText(label: string, mimeType: string, data: Buffer): Promise<string> {
  if (mimeType === "application/pdf") {
    const tempPath = join(tmpdir(), `ava-gateway-attachment-${randomUUID()}.pdf`);
    try {
      await writeFile(tempPath, data);
      return await extractPdfText(tempPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`attachment ${label}: failed to read PDF content (${message})`);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  try {
    return data.toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`attachment ${label}: failed to decode document content (${message})`);
  }
}

export async function parseChatAttachments(
  attachments: ChatAttachment[],
  options: ParseChatAttachmentsOptions = {},
): Promise<ParsedChatAttachments> {
  if (!attachments || attachments.length === 0) {
    return {
      images: [],
      historyBlocks: [],
    };
  }

  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const maxBytesPerAttachment = options.maxBytesPerAttachment ?? DEFAULT_MAX_BYTES_PER_ATTACHMENT;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxDocumentChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;

  if (attachments.length > maxAttachments) {
    throw new Error(`too many attachments (${attachments.length} > ${maxAttachments})`);
  }

  const images: ImageContent[] = [];
  const historyBlocks: AttachmentHistoryBlock[] = [];
  const docSections: string[] = [];
  let totalBytes = 0;

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const label = attachment.fileName || attachment.type || `attachment-${index + 1}`;
    const type = (attachment.type ?? "").trim() || "file";
    const normalizedMime = normalizeMimeType(attachment.mimeType);
    const normalizedContent = normalizeBase64Content(attachment.content ?? "");
    const effectiveMime = normalizedMime ?? normalizedContent.mimeTypeFromDataUrl;
    const decoded = decodeBase64(label, normalizedContent.base64);
    const bytes = decoded.byteLength;

    if (bytes > maxBytesPerAttachment) {
      throw new Error(`attachment ${label}: exceeds size limit (${bytes} > ${maxBytesPerAttachment} bytes)`);
    }

    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`attachments exceed total size limit (${totalBytes} > ${maxTotalBytes} bytes)`);
    }

    const sniffedImageMime = sniffImageMimeType(decoded);
    const resolvedImageMime = sniffedImageMime ?? (isImageMimeType(effectiveMime) ? effectiveMime : undefined);
    if (resolvedImageMime) {
      images.push({
        type: "image",
        data: normalizedContent.base64,
        mimeType: resolvedImageMime,
      });
      historyBlocks.push({
        type: type || "image",
        mimeType: resolvedImageMime,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        omitted: true,
        bytes,
      });
      continue;
    }

    const resolvedDocumentMime = normalizeMimeType(effectiveMime) ?? inferMimeTypeFromFileName(attachment.fileName);
    if (!isSupportedDocumentMimeType(resolvedDocumentMime)) {
      const mimeLabel = resolvedDocumentMime ?? effectiveMime ?? "unknown";
      throw new Error(
        `attachment ${label}: unsupported attachment type (${mimeLabel}); supported types: image/*, application/pdf, text/plain, text/markdown, text/csv, application/json`,
      );
    }
    const documentMime = resolvedDocumentMime as string;

    const documentText = await extractDocumentText(label, documentMime, decoded);
    const section = clampDocumentText(documentText, maxDocumentChars);
    docSections.push(
      `[Document: ${attachment.fileName || label} (${documentMime})]\n${section}`,
    );

    historyBlocks.push({
      type,
      mimeType: documentMime,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      omitted: true,
      bytes,
    });
  }

  return {
    images,
    historyBlocks,
    ...(docSections.length > 0
      ? {
          docContext: docSections.join("\n\n"),
        }
      : {}),
  };
}
