/**
 * Slack Actions Tool
 *
 * Slack action parity surface for sending, editing, reading,
 * reactions, pins, and emoji/member lookups.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { getSlackApp } from "../../lib/slack/app.js";
import { parseSlackBlocksInput } from "../../lib/slack/blocks.js";
import { sendSlackMessageWithMedia } from "../../lib/slack/files.js";
import { markdownToSlackMrkdwn } from "../../lib/slack/format.js";
import { parseSlackTarget, normalizeSlackChannelId } from "../../lib/slack/targets.js";
import { withSlackTimestamp } from "../../lib/slack/timestamps.js";

const VALID_ACTIONS = [
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "react",
  "reactions",
  "pinMessage",
  "unpinMessage",
  "listPins",
  "memberInfo",
  "emojiList",
] as const;

const LEGACY_ACTIONS: Record<string, string> = {
  read_messages: "readMessages",
  pin: "pinMessage",
  unpin: "unpinMessage",
  get_member_info: "memberInfo",
  list_emojis: "emojiList",
  remove_own_reactions: 'react (with emoji="" and remove omitted)',
  edit: "editMessage",
  delete: "deleteMessage",
  find_user: "removed (no parity equivalent)",
};

const SlackActionsSchema = Type.Object({
  action: Type.String({
    description:
      'Action: "sendMessage", "editMessage", "deleteMessage", "readMessages", "react", "reactions", "pinMessage", "unpinMessage", "listPins", "memberInfo", "emojiList"',
  }),
  to: Type.Optional(
    Type.String({
      description:
        "Target for sendMessage. Accepts channel:<ID>, user:<ID>, raw C... channel IDs, or raw U... user IDs.",
    }),
  ),
  channelId: Type.Optional(
    Type.String({
      description: "Slack channel ID (or channel:<ID>) for channel-scoped actions.",
    }),
  ),
  messageId: Type.Optional(
    Type.String({
      description: "Slack message timestamp ID (ts).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Message text content (for sendMessage/editMessage).",
    }),
  ),
  mediaUrl: Type.Optional(
    Type.String({
      description: "Media URL for sendMessage upload flow.",
    }),
  ),
  blocks: Type.Optional(
    Type.Any({
      description: "Slack Block Kit blocks as JSON string or array.",
    }),
  ),
  threadTs: Type.Optional(
    Type.String({
      description: "Thread timestamp for sendMessage replies.",
    }),
  ),
  threadId: Type.Optional(
    Type.String({
      description: "Thread timestamp for readMessages thread reads.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: "Read cursor upper bound timestamp.",
    }),
  ),
  after: Type.Optional(
    Type.String({
      description: "Read cursor lower bound timestamp.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of entries to return.",
    }),
  ),
  emoji: Type.Optional(
    Type.String({
      description:
        "Emoji shortcode for react (without colons). Empty emoji removes own reactions when remove is not true.",
    }),
  ),
  remove: Type.Optional(
    Type.Boolean({
      description: "When true, remove the specified emoji reaction.",
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description: "Slack user ID for memberInfo.",
    }),
  ),

  // Legacy params retained only for explicit migration errors.
  messageTs: Type.Optional(
    Type.String({
      description: "DEPRECATED: use messageId.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description: "DEPRECATED: use content.",
    }),
  ),
});

type SlackActionsArgs = Static<typeof SlackActionsSchema>;

type SlackMessageSummary = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  reactions?: Array<{
    name?: string;
    count?: number;
    users?: string[];
  }>;
};

function text(
  message: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function errorResult(action: string, message: string): AgentToolResult<unknown> {
  return text(`Slack action error: ${message}`, {
    ok: false,
    action,
    error: message,
  });
}

function normalizeEmoji(raw: string): string {
  return raw.trim().replace(/^:+|:+$/g, "");
}

function requireValue(value: string | undefined, field: string, action: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required for ${action}.`);
  }
  return trimmed;
}

function getLegacyActionMessage(action: string): string | null {
  const replacement = LEGACY_ACTIONS[action];
  if (!replacement) {
    return null;
  }
  if (replacement === "removed (no parity equivalent)") {
    return `Legacy action "${action}" is no longer supported and has no parity equivalent.`;
  }
  return `Legacy action "${action}" is no longer supported. Use "${replacement}".`;
}

function collectLegacyParamErrors(args: SlackActionsArgs): string[] {
  const errors: string[] = [];
  if (args.messageTs != null) {
    errors.push('Legacy parameter "messageTs" is no longer supported. Use "messageId".');
  }
  if (args.text != null) {
    errors.push('Legacy parameter "text" is no longer supported. Use "content".');
  }
  if (args.action === "readMessages" && args.threadTs != null && args.threadId == null) {
    errors.push(
      'Legacy parameter "threadTs" is no longer supported for readMessages. Use "threadId".',
    );
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

export function createSlackActionsTool(context: {
  userId: string;
  sessionId: string;
}): ToolDefinition {
  return {
    name: "slack_actions",
    label: "Slack Actions",
    description: `Perform Slack actions with parity APIs.
Actions: sendMessage, editMessage, deleteMessage, readMessages, react, reactions, pinMessage, unpinMessage, listPins, memberInfo, emojiList.
This tool only works in Slack conversations.`,
    parameters: SlackActionsSchema,
    execute: async (
      _toolCallId: string,
      args: SlackActionsArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const legacyActionMessage = getLegacyActionMessage(args.action);
      if (legacyActionMessage) {
        return errorResult(args.action, legacyActionMessage);
      }

      const legacyParamErrors = collectLegacyParamErrors(args);
      if (legacyParamErrors.length > 0) {
        return errorResult(args.action, legacyParamErrors.join(" "));
      }

      if (!VALID_ACTIONS.includes(args.action as (typeof VALID_ACTIONS)[number])) {
        return errorResult(
          args.action,
          `Unknown action: ${args.action}. Valid actions: ${VALID_ACTIONS.join(", ")}.`,
        );
      }

      const slackContext = await getSlackContext(context.sessionId);
      if (!slackContext) {
        return errorResult(
          args.action,
          "Not in a Slack conversation. This tool only works in Slack channels.",
        );
      }

      const client = getSlackApp().client;

      try {
        switch (args.action) {
          case "sendMessage": {
            const to = requireValue(args.to, "to", "sendMessage");
            const target = parseSlackTarget(to);
            let channelId = target.id;

            if (target.kind === "user") {
              const dm = await client.conversations.open({ users: target.id });
              channelId = dm.channel?.id ?? "";
              if (!channelId) {
                throw new Error(`Failed to open DM channel for user ${target.id}.`);
              }
            }

            const blocks = parseSlackBlocksInput(args.blocks);
            const content = args.content?.trim() ?? "";

            if (!content && !args.mediaUrl && !blocks) {
              throw new Error("sendMessage requires content, blocks, or mediaUrl.");
            }
            if (args.mediaUrl && blocks) {
              throw new Error("sendMessage does not support blocks with mediaUrl.");
            }

            const threadTs =
              args.threadTs ??
              (target.kind === "channel" && channelId === slackContext.channelId
                ? slackContext.threadTs
                : undefined);

            if (args.mediaUrl) {
              const mediaResult = await sendSlackMessageWithMedia({
                channelId,
                threadTs,
                text: content ? markdownToSlackMrkdwn(content) : undefined,
                mediaUrl: args.mediaUrl,
              });
              if (!mediaResult.ok) {
                throw new Error(mediaResult.error || "Failed to send media.");
              }

              return text(`Sent media message to ${to}.`, {
                ok: true,
                action: "sendMessage",
                to,
                channelId,
                threadTs,
                usedMediaUrl: true,
              });
            }

            const response = await client.chat.postMessage({
              channel: channelId,
              text: content ? markdownToSlackMrkdwn(content) : " ",
              ...(threadTs ? { thread_ts: threadTs } : {}),
              ...(blocks ? { blocks } : {}),
              mrkdwn: true,
            });

            return text(`Sent message to ${to}.`, {
              ok: true,
              action: "sendMessage",
              to,
              channelId,
              threadTs,
              messageId: response.ts,
              usedBlocks: Boolean(blocks),
            });
          }

          case "editMessage": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "editMessage"),
            );
            const messageId = requireValue(args.messageId, "messageId", "editMessage");
            const blocks = parseSlackBlocksInput(args.blocks);
            const content = args.content?.trim() ?? "";

            if (!content && !blocks) {
              throw new Error("editMessage requires content or blocks.");
            }

            await client.chat.update({
              channel: channelId,
              ts: messageId,
              text: content ? markdownToSlackMrkdwn(content) : " ",
              ...(blocks ? { blocks } : {}),
            });

            return text("Message edited.", {
              ok: true,
              action: "editMessage",
              channelId,
              messageId,
              usedBlocks: Boolean(blocks),
            });
          }

          case "deleteMessage": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "deleteMessage"),
            );
            const messageId = requireValue(args.messageId, "messageId", "deleteMessage");

            await client.chat.delete({ channel: channelId, ts: messageId });

            return text("Message deleted.", {
              ok: true,
              action: "deleteMessage",
              channelId,
              messageId,
            });
          }

          case "readMessages": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "readMessages"),
            );

            const limit =
              typeof args.limit === "number" && Number.isFinite(args.limit)
                ? args.limit
                : undefined;

            let messages: SlackMessageSummary[] = [];
            let hasMore = false;

            if (args.threadId) {
              const replies = await client.conversations.replies({
                channel: channelId,
                ts: args.threadId,
                limit,
                latest: args.before,
                oldest: args.after,
              });
              messages = ((replies.messages ?? []) as SlackMessageSummary[]).filter(
                (message) => message.ts !== args.threadId,
              );
              hasMore = Boolean(replies.has_more);
            } else {
              const history = await client.conversations.history({
                channel: channelId,
                limit,
                latest: args.before,
                oldest: args.after,
              });
              messages = (history.messages ?? []) as SlackMessageSummary[];
              hasMore = Boolean(history.has_more);
            }

            const normalizedMessages = messages.map((message) =>
              withSlackTimestamp(
                message as Record<string, unknown>,
                (message as { ts?: unknown }).ts,
              ),
            );

            const formatted =
              normalizedMessages.length === 0
                ? "No messages found."
                : normalizedMessages
                    .map((message) => {
                      const user =
                        typeof message.user === "string"
                          ? message.user
                          : typeof message.bot_id === "string"
                            ? message.bot_id
                            : "unknown";
                      const time =
                        typeof message.timestampUtc === "string"
                          ? message.timestampUtc
                          : typeof message.ts === "string"
                            ? message.ts
                            : "";
                      const body =
                        typeof message.text === "string" && message.text.length > 0
                          ? message.text
                          : "(no text)";
                      return `[${time}] <@${user}>: ${body}`;
                    })
                    .join("\n");

            return text(formatted, {
              ok: true,
              action: "readMessages",
              channelId,
              hasMore,
              messages: normalizedMessages,
            });
          }

          case "react": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "react"),
            );
            const messageId = requireValue(args.messageId, "messageId", "react");
            const emoji = args.emoji == null ? "" : normalizeEmoji(args.emoji);

            if (args.remove === true) {
              if (!emoji) {
                throw new Error("Emoji is required when remove=true.");
              }
              await client.reactions.remove({
                channel: channelId,
                timestamp: messageId,
                name: emoji,
              });
              return text(`Removed :${emoji}: reaction.`, {
                ok: true,
                action: "react",
                channelId,
                messageId,
                removed: emoji,
              });
            }

            if (!emoji) {
              const auth = await client.auth.test();
              const botUserId = auth.user_id;
              if (!botUserId) {
                throw new Error("Could not resolve bot user ID.");
              }

              const reactionsResult = await client.reactions.get({
                channel: channelId,
                timestamp: messageId,
                full: true,
              });

              const reactions =
                (reactionsResult.message as {
                  reactions?: Array<{ name?: string; users?: string[] }>;
                } | null)?.reactions ?? [];

              const ownReactions = reactions
                .filter((reaction) => reaction.users?.includes(botUserId))
                .map((reaction) => reaction.name)
                .filter((name): name is string => Boolean(name));

              if (ownReactions.length === 0) {
                return text("No own reactions to remove.", {
                  ok: true,
                  action: "react",
                  channelId,
                  messageId,
                  removed: [],
                });
              }

              await Promise.all(
                ownReactions.map((name) =>
                  client.reactions.remove({
                    channel: channelId,
                    timestamp: messageId,
                    name,
                  }),
                ),
              );

              return text(`Removed ${ownReactions.length} reaction(s): ${ownReactions.join(", ")}.`, {
                ok: true,
                action: "react",
                channelId,
                messageId,
                removed: ownReactions,
              });
            }

            await client.reactions.add({
              channel: channelId,
              timestamp: messageId,
              name: emoji,
            });

            return text(`Added :${emoji}: reaction.`, {
              ok: true,
              action: "react",
              channelId,
              messageId,
              added: emoji,
            });
          }

          case "reactions": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "reactions"),
            );
            const messageId = requireValue(args.messageId, "messageId", "reactions");
            const reactionsResult = await client.reactions.get({
              channel: channelId,
              timestamp: messageId,
              full: true,
            });

            const reactions =
              (reactionsResult.message as { reactions?: SlackMessageSummary["reactions"] } | null)
                ?.reactions ?? [];

            const normalized =
              typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
                ? reactions.slice(0, args.limit)
                : reactions;

            return text(`Found ${normalized.length} reaction entries.`, {
              ok: true,
              action: "reactions",
              channelId,
              messageId,
              reactions: normalized,
            });
          }

          case "pinMessage": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "pinMessage"),
            );
            const messageId = requireValue(args.messageId, "messageId", "pinMessage");

            await client.pins.add({ channel: channelId, timestamp: messageId });

            return text("Message pinned.", {
              ok: true,
              action: "pinMessage",
              channelId,
              messageId,
            });
          }

          case "unpinMessage": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "unpinMessage"),
            );
            const messageId = requireValue(args.messageId, "messageId", "unpinMessage");

            await client.pins.remove({ channel: channelId, timestamp: messageId });

            return text("Message unpinned.", {
              ok: true,
              action: "unpinMessage",
              channelId,
              messageId,
            });
          }

          case "listPins": {
            const channelId = normalizeSlackChannelId(
              requireValue(args.channelId, "channelId", "listPins"),
            );
            const result = await client.pins.list({ channel: channelId });

            const pins = (result.items ?? []).map((pin) => {
              const record = pin as Record<string, unknown>;
              const message =
                record.message && typeof record.message === "object"
                  ? withSlackTimestamp(
                      record.message as Record<string, unknown>,
                      (record.message as { ts?: unknown }).ts,
                    )
                  : record.message;
              return message ? { ...record, message } : record;
            });

            return text(`Found ${pins.length} pinned items.`, {
              ok: true,
              action: "listPins",
              channelId,
              pins,
            });
          }

          case "memberInfo": {
            const userId = requireValue(args.userId, "userId", "memberInfo");
            const result = await client.users.info({ user: userId });
            const user = result.user;

            if (!user) {
              return text(`User ${userId} not found.`, {
                ok: true,
                action: "memberInfo",
                userId,
                info: null,
              });
            }

            const summary = [
              `Name: ${user.real_name || user.name}`,
              `Display Name: ${user.profile?.display_name || "N/A"}`,
              `Email: ${user.profile?.email || "N/A"}`,
              `Title: ${user.profile?.title || "N/A"}`,
              `Status: ${user.profile?.status_text || "N/A"}`,
              `Timezone: ${user.tz || "N/A"}`,
              `Is Admin: ${user.is_admin || false}`,
              `Is Bot: ${user.is_bot || false}`,
            ].join("\n");

            return text(summary, {
              ok: true,
              action: "memberInfo",
              userId,
              info: user,
            });
          }

          case "emojiList": {
            const result = await client.emoji.list();
            const emojiMap = result.emoji ?? {};
            const entries = Object.entries(emojiMap).sort(([a], [b]) =>
              a.localeCompare(b),
            );

            const limitedEntries =
              typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
                ? entries.slice(0, args.limit)
                : entries;

            const limitedEmojiMap = Object.fromEntries(limitedEntries);
            const names = Object.keys(limitedEmojiMap);

            const message =
              names.length === 0
                ? "No custom emojis found."
                : `Custom emojis (${names.length}): ${names.join(", ")}`;

            return text(message, {
              ok: true,
              action: "emojiList",
              emojis: {
                ...result,
                emoji: limitedEmojiMap,
              },
            });
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(args.action, msg);
      }

      return errorResult(
        args.action,
        `Unknown action: ${args.action}. Valid actions: ${VALID_ACTIONS.join(", ")}.`,
      );
    },
  };
}
