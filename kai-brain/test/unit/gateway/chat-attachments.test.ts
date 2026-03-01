import { describe, expect, test } from "vitest";
import { normalizeRpcAttachmentsToChatAttachments } from "../../../src/gateway/attachment-normalize.js";
import { parseChatAttachments } from "../../../src/gateway/chat-attachments.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

describe("gateway chat attachments", () => {
  test("normalizes rpc attachments and drops malformed entries", () => {
    const normalized = normalizeRpcAttachmentsToChatAttachments([
      null,
      { type: "image", mimeType: "image/png", fileName: "a.png", content: PNG_1X1_BASE64 },
      { mimeType: "image/png", fileName: "missing-content.png" },
      { content: 1234 },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.fileName).toBe("a.png");
    expect(normalized[0]?.content).toBe(PNG_1X1_BASE64);
  });

  test("parses image attachments into model images and redacted history blocks", async () => {
    const parsed = await parseChatAttachments([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: `data:image/png;base64,${PNG_1X1_BASE64}`,
      },
    ]);

    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.type).toBe("image");
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.historyBlocks).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        omitted: true,
      }),
    ]);
  });

  test("parses supported text documents and emits document context", async () => {
    const parsed = await parseChatAttachments([
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "notes.txt",
        content: Buffer.from("hello from attachment", "utf8").toString("base64"),
      },
    ]);

    expect(parsed.images).toHaveLength(0);
    expect(parsed.docContext).toContain("hello from attachment");
    expect(parsed.historyBlocks[0]).toEqual(
      expect.objectContaining({
        type: "file",
        mimeType: "text/plain",
        fileName: "notes.txt",
        omitted: true,
      }),
    );
  });

  test("rejects unsupported document mime types", async () => {
    await expect(
      parseChatAttachments([
        {
          type: "file",
          mimeType: "application/zip",
          fileName: "archive.zip",
          content: Buffer.from("zip-bytes", "utf8").toString("base64"),
        },
      ]),
    ).rejects.toThrow(/unsupported attachment type/i);
  });

  test("rejects invalid base64 content", async () => {
    await expect(
      parseChatAttachments([
        {
          type: "image",
          mimeType: "image/png",
          fileName: "bad.png",
          content: "%not-base64%",
        },
      ]),
    ).rejects.toThrow(/invalid base64/i);
  });
});
