/**
 * Slack Message Tool
 *
 * Upload-first Slack messaging tool for text, URL media, local files,
 * base64 buffers, and inline file content.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { eq } from "drizzle-orm";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { basename, resolve, normalize, join } from "node:path";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { getSlackApp } from "../../lib/slack/app.js";
import { markdownToSlackMrkdwn } from "../../lib/slack/format.js";
import { uploadFileToSlack, sendSlackMessageWithMedia } from "../../lib/slack/files.js";
import { parseSlackTarget } from "../../lib/slack/targets.js";

const SlackMessageSchema = Type.Object({
  target: Type.Optional(
    Type.String({
      description:
        "Slack target. Accepts channel:<ID>, user:<ID>, raw C... channel IDs, or raw U... user IDs. Omit to send in current conversation.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Message text to send.",
    }),
  ),
  media: Type.Optional(
    Type.String({
      description: "URL of an image/file to download and upload.",
    }),
  ),
  filePath: Type.Optional(
    Type.String({
      description: "Local file path to upload.",
    }),
  ),
  buffer: Type.Optional(
    Type.String({
      description: "Base64-encoded binary content to upload (data: URLs supported).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Text content to upload as a file.",
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Filename for uploaded file payloads.",
    }),
  ),
  caption: Type.Optional(
    Type.String({
      description: "Caption/comment for file uploads.",
    }),
  ),
  threadId: Type.Optional(
    Type.String({
      description: "Thread timestamp to send reply in a thread.",
    }),
  ),

  // Legacy params retained only for explicit migration errors.
  text: Type.Optional(
    Type.String({
      description: "DEPRECATED: use message.",
    }),
  ),
  media_url: Type.Optional(
    Type.String({
      description: "DEPRECATED: use media.",
    }),
  ),
  file_path: Type.Optional(
    Type.String({
      description: "DEPRECATED: use filePath.",
    }),
  ),
  thread_ts: Type.Optional(
    Type.String({
      description: "DEPRECATED: use threadId.",
    }),
  ),
});

type SlackMessageArgs = Static<typeof SlackMessageSchema>;

const LEGACY_PARAM_MAP: Record<string, string> = {
  text: "message",
  media_url: "media",
  file_path: "filePath",
  thread_ts: "threadId",
};

const ALLOWED_PATH_PREFIXES = [process.cwd(), "/tmp", "/private/tmp"];
const BLOCKED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
]);

function text(
  message: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function errorResult(message: string): AgentToolResult<unknown> {
  return text(`Slack message error: ${message}`, {
    ok: false,
    error: message,
  });
}

function validateFilePath(filePath: string): string | null {
  const resolved = resolve(filePath);
  const normalized = normalize(resolved);
  if (normalized.includes("..")) {
    return "Path traversal (..) is not allowed";
  }
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "File path must be within the project directory or /tmp";
  }
  if (BLOCKED_FILENAMES.has(basename(normalized).toLowerCase())) {
    return `Cannot upload sensitive file: ${basename(normalized)}`;
  }
  if (normalized.includes("node_modules")) {
    return "Cannot upload files from node_modules";
  }
  return null;
}

function normalizeBase64(input: string): { data: Buffer; mimeType?: string } {
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { data: Buffer.from(match[2], "base64"), mimeType: match[1] };
  }
  return { data: Buffer.from(input, "base64") };
}

function inferFilename(mimeType?: string): string {
  const map: Record<string, string> = {
    "image/png": "file.png",
    "image/jpeg": "file.jpg",
    "image/gif": "file.gif",
    "image/webp": "file.webp",
    "application/pdf": "file.pdf",
    "text/csv": "file.csv",
    "application/json": "file.json",
  };
  return map[mimeType || ""] || "file.bin";
}

function collectLegacyParamErrors(args: SlackMessageArgs): string[] {
  const errors: string[] = [];
  for (const [legacy, replacement] of Object.entries(LEGACY_PARAM_MAP)) {
    if (legacy in args && args[legacy as keyof SlackMessageArgs] != null) {
      errors.push(`Legacy parameter "${legacy}" is no longer supported. Use "${replacement}".`);
    }
  }
  return errors;
}

async function getSlackContext(
  sessionId: string,
): Promise<{ channelId: string; threadTs: string } | null> {
  try {
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);
    if (!session || session.source !== "slack" || !session.externalId) {
      return null;
    }
    const parts = session.externalId.split(":");
    if (parts.length < 3 || parts[0] !== "slack") {
      return null;
    }
    return { channelId: parts[1], threadTs: parts[2] };
  } catch {
    return null;
  }
}

async function getSessionSource(sessionId: string): Promise<string | null> {
  try {
    const [session] = await db
      .select({ source: avaSessions.source })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);
    return typeof session?.source === "string" ? session.source : null;
  } catch {
    return null;
  }
}

export function createSlackMessageTool(context: {
  userId: string;
  sessionId: string;
}): ToolDefinition {
  return {
    name: "slack_message",
    label: "Slack Message",
    description: `Send messages and files to Slack.

Payload options:
- message: text message
- media: URL to upload as a file
- filePath: local file path upload
- buffer: base64 upload payload
- content: inline text content upload`,
    parameters: SlackMessageSchema,
    execute: async (
      _toolCallId: string,
      args: SlackMessageArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (_signal?.aborted) {
        return text("Slack message aborted", {
          ok: false,
          aborted: true,
        });
      }

      const legacyErrors = collectLegacyParamErrors(args);
      if (legacyErrors.length > 0) {
        return errorResult(legacyErrors.join(" "));
      }

      try {
        const hasFilePayload = Boolean(args.media || args.filePath || args.buffer || args.content);
        const message = args.message;
        if (!message && !hasFilePayload) {
          return errorResult(
            "Provide at least one of: message, media, filePath, buffer, or content.",
          );
        }

        const client = getSlackApp().client;
        let channelId: string;
        let threadTs: string | undefined = args.threadId;
        const sessionSource = await getSessionSource(context.sessionId);

        if (!args.target && sessionSource === "subagent") {
          return errorResult(
            "Subagent sessions must provide an explicit Slack target (channel:<ID> or user:<ID>).",
          );
        }

        if (args.target) {
          const target = parseSlackTarget(args.target);
          if (target.kind === "user") {
            const dm = await client.conversations.open({ users: target.id });
            channelId = dm.channel?.id || target.id;
          } else {
            channelId = target.id;
          }
        } else {
          const slackCtx = await getSlackContext(context.sessionId);
          if (!slackCtx) {
            return errorResult(
              "Not in a Slack conversation. Provide target when sending outside Slack session context.",
            );
          }
          channelId = slackCtx.channelId;
          threadTs = threadTs || slackCtx.threadTs;
        }

        if (args.media) {
          const comment = message || args.caption;
          const result = await sendSlackMessageWithMedia({
            channelId,
            threadTs,
            text: comment ? markdownToSlackMrkdwn(comment) : undefined,
            mediaUrl: args.media,
          });
          if (!result.ok) {
            return errorResult(`Failed to send media: ${result.error}`);
          }
          return text(`Sent media to ${args.target || "current conversation"}.`, {
            ok: true,
            operation: "sendMedia",
            channelId,
            threadTs,
            target: args.target || null,
            mediaUrl: args.media,
          });
        }

        if (args.filePath) {
          const validationError = validateFilePath(args.filePath);
          if (validationError) {
            return errorResult(validationError);
          }

          try {
            await stat(args.filePath);
          } catch (err) {
            return errorResult(
              `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          const fileName = args.filename || basename(args.filePath);
          const result = await uploadFileToSlack({
            channelId,
            threadTs,
            filePath: resolve(args.filePath),
            filename: fileName,
            title: fileName,
            initialComment:
              message || args.caption
                ? markdownToSlackMrkdwn(message || args.caption || "")
                : undefined,
          });
          if (!result.ok) {
            return errorResult(`Failed to upload file: ${result.error}`);
          }

          return text(`Uploaded "${fileName}" to ${args.target || "current conversation"}.`, {
            ok: true,
            operation: "uploadFilePath",
            channelId,
            threadTs,
            target: args.target || null,
            filename: fileName,
            fileId: result.fileId,
          });
        }

        if (args.buffer) {
          const { data, mimeType } = normalizeBase64(args.buffer);
          const fileName = args.filename || inferFilename(mimeType);

          const uploadsDir = join(process.cwd(), ".sandbox", "uploads");
          await mkdir(uploadsDir, { recursive: true });
          const tempPath = join(uploadsDir, `${Date.now()}-${fileName}`);
          await writeFile(tempPath, data);

          const result = await uploadFileToSlack({
            channelId,
            threadTs,
            filePath: tempPath,
            filename: fileName,
            title: fileName,
            initialComment:
              message || args.caption
                ? markdownToSlackMrkdwn(message || args.caption || "")
                : undefined,
          });
          if (!result.ok) {
            return errorResult(`Failed to upload buffer: ${result.error}`);
          }

          return text(
            `Uploaded "${fileName}" (${(data.length / 1024).toFixed(1)} KB) to ${
              args.target || "current conversation"
            }.`,
            {
              ok: true,
              operation: "uploadBuffer",
              channelId,
              threadTs,
              target: args.target || null,
              filename: fileName,
              sizeBytes: data.length,
              fileId: result.fileId,
            },
          );
        }

        if (args.content) {
          const fileName = args.filename || "file.txt";
          const result = await uploadFileToSlack({
            channelId,
            threadTs,
            content: args.content,
            filename: fileName,
            title: fileName,
            initialComment:
              message || args.caption
                ? markdownToSlackMrkdwn(message || args.caption || "")
                : undefined,
          });
          if (!result.ok) {
            return errorResult(`Failed to upload content: ${result.error}`);
          }

          return text(`Uploaded "${fileName}" to ${args.target || "current conversation"}.`, {
            ok: true,
            operation: "uploadContent",
            channelId,
            threadTs,
            target: args.target || null,
            filename: fileName,
            fileId: result.fileId,
          });
        }

        const post = await client.chat.postMessage({
          channel: channelId,
          text: markdownToSlackMrkdwn(message!),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          mrkdwn: true,
        });

        return text(`Sent message to ${args.target || "current conversation"}.`, {
          ok: true,
          operation: "sendMessage",
          channelId,
          threadTs,
          target: args.target || null,
          messageId: post.ts,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(msg);
      }
    },
  };
}
