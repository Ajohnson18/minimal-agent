export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
};

function encodeBinaryToBase64(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("base64");
  }
  return undefined;
}

export function normalizeRpcAttachmentsToChatAttachments(
  attachments: unknown[] | undefined,
): ChatAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ChatAttachment[] = [];
  for (const entry of attachments) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const content = encodeBinaryToBase64(record.content)?.trim();
    if (!content) {
      continue;
    }
    normalized.push({
      type: typeof record.type === "string" ? record.type : undefined,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      fileName: typeof record.fileName === "string" ? record.fileName : undefined,
      content,
    });
  }
  return normalized;
}
