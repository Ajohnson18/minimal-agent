import {
  checkMention,
  type MentionCheckResult,
} from "../../../lib/slack/mentions.js";
import { createLogger } from "../../../lib/logger.js";
import type {
  SlackAttachment,
  SlackFile,
  SlackMessageEvent,
} from "../../types.js";
import {
  normalizeSlackChannelType,
  type SlackMonitorContext,
} from "../context.js";
import { resolveThreadDispatchState } from "../runtime.js";

const log = createLogger("slack", { component: "monitor-prepare" });

export type PreparedSlackMessage =
  | {
      kind: "dispatch";
      channelId: string;
      sessionKey: string;
      userId: string;
      text: string;
      messageTs: string;
      botUserId?: string;
      files?: SlackFile[];
      attachments?: SlackAttachment[];
    }
  | {
      kind: "pending-history";
      channelId: string;
      userId: string;
      text: string;
      messageTs: string;
    };

function isControlMentionAccepted(params: {
  result: MentionCheckResult;
  mode: SlackMonitorContext["mentionGatingMode"];
  wasMentioned?: boolean;
}): boolean {
  if (params.wasMentioned) {
    return true;
  }
  switch (params.mode) {
    case "explicit-only":
      return params.result.isExplicit;
    case "explicit-or-implicit":
      return params.result.isExplicit || params.result.isImplicit;
    case "any":
    case "default":
    default:
      return params.result.wasMentioned;
  }
}

function normalizeText(text: string | undefined): string {
  return typeof text === "string" ? text : "";
}

function resolveMessageTs(message: SlackMessageEvent): string {
  return message.ts ?? message.event_ts ?? String(Date.now());
}

function hasControlCommand(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("/") || normalized.startsWith("!");
}

function hasForeignUserMention(text: string, botUserId?: string): boolean {
  const userMentions = text.match(/<@[A-Z0-9]+>/g) || [];
  if (userMentions.length === 0) {
    return false;
  }
  return userMentions.some((mention) => mention !== `<@${botUserId}>`);
}

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    botUserId?: string;
  };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, message, opts } = params;
  const channelId = message.channel;
  const channelType = normalizeSlackChannelType(message.channel_type, channelId);
  const isDm = channelType === "im";
  const isGroupDm = channelType === "mpim";
  const isRoom = channelType === "channel" || channelType === "group";
  const botUserId = opts.botUserId ?? ctx.getBotUserId();

  const messageTs = resolveMessageTs(message);
  const text = normalizeText(message.text);

  const eventUserId = message.user?.trim();
  const isBotMessage = Boolean(message.bot_id || (eventUserId && eventUserId === botUserId));
  if (!eventUserId) {
    return null;
  }

  if (eventUserId === botUserId) {
    return null;
  }

  if (isBotMessage) {
    const channelConfig = ctx.getChannelConfig(channelId);
    if (!channelConfig?.allowBots) {
      return null;
    }
  }

  if (opts.source === "app_mention") {
    return {
      kind: "dispatch",
      channelId,
      sessionKey: message.thread_ts || messageTs,
      userId: eventUserId,
      text,
      messageTs,
      botUserId,
      files: message.files,
      attachments: message.attachments,
    };
  }

  const threadTs = message.thread_ts;
  const isThreadReply = Boolean(
    threadTs && (threadTs !== messageTs || message.parent_user_id),
  );

  if (isDm) {
    return {
      kind: "dispatch",
      channelId,
      sessionKey: threadTs || `dm:${eventUserId}`,
      userId: eventUserId,
      text,
      messageTs,
      botUserId,
      files: message.files,
      attachments: message.attachments,
    };
  }

  if (isGroupDm) {
    const hasMention = Boolean(botUserId && text.includes(`<@${botUserId}>`));
    if (hasMention || !text.includes("<@")) {
      return {
        kind: "dispatch",
        channelId,
        sessionKey: threadTs || messageTs,
        userId: eventUserId,
        text,
        messageTs,
        botUserId,
        files: message.files,
        attachments: message.attachments,
      };
    }
    return null;
  }

  if (!isRoom) {
    return null;
  }

  if (isThreadReply && threadTs) {
    const channelConfig = ctx.getChannelConfig(channelId);
    if (channelConfig?.enabled === false) {
      log.debug(
        { channelId, threadTs, messageTs, reason: "channel-disabled" },
        "Skipping Slack thread message",
      );
      return null;
    }

    const mentionResult = checkMention({
      text,
      config: ctx.getMentionConfig(botUserId),
      threadParentUserId: message.parent_user_id,
      isInThread: true,
    });
    const mentionAccepted = isControlMentionAccepted({
      result: mentionResult,
      mode: ctx.mentionGatingMode,
      wasMentioned: opts.wasMentioned,
    });
    const requireMention = channelConfig?.requireMention ?? ctx.defaultRequireMention;
    const directedToAva =
      mentionResult.isExplicit ||
      mentionResult.isPattern ||
      Boolean(opts.wasMentioned) ||
      hasControlCommand(text);
    const foreignUserMention = hasForeignUserMention(text, botUserId);

    if (directedToAva) {
      return {
        kind: "dispatch",
        channelId,
        sessionKey: threadTs,
        userId: eventUserId,
        text,
        messageTs,
        botUserId,
        files: message.files,
        attachments: message.attachments,
      };
    }

    if (foreignUserMention) {
      log.debug(
        { channelId, threadTs, messageTs, reason: "foreign-user-mention-without-ava" },
        "Skipping Slack thread message",
      );
      return null;
    }

    if (requireMention) {
      const threadState = await resolveThreadDispatchState(channelId, threadTs);
      if (!threadState) {
        log.debug(
          { channelId, threadTs, messageTs, reason: "inactive-thread-no-mention" },
          "Skipping Slack thread message",
        );
        return null;
      }
      log.debug(
        { channelId, threadTs, messageTs, reason: "active-thread-no-mention" },
        "Accepting Slack thread message without mention",
      );
    } else if (!mentionAccepted) {
      log.debug(
        { channelId, threadTs, messageTs, reason: "require-mention-disabled" },
        "Accepting Slack thread message without mention",
      );
    }

    return {
      kind: "dispatch",
      channelId,
      sessionKey: threadTs,
      userId: eventUserId,
      text,
      messageTs,
      botUserId,
      files: message.files,
      attachments: message.attachments,
    };
  }

  // Top-level room messages dispatch only when the bot is explicitly/implicitly mentioned.
  const mentionResult = checkMention({
    text,
    config: ctx.getMentionConfig(botUserId),
    threadParentUserId: message.parent_user_id,
    isInThread: false,
  });
  const mentionAccepted = isControlMentionAccepted({
    result: mentionResult,
    mode: ctx.mentionGatingMode,
    wasMentioned: opts.wasMentioned,
  });
  if (mentionAccepted) {
    return {
      kind: "dispatch",
      channelId,
      sessionKey: messageTs,
      userId: eventUserId,
      text,
      messageTs,
      botUserId,
      files: message.files,
      attachments: message.attachments,
    };
  }

  return {
    kind: "pending-history",
    channelId,
    userId: eventUserId,
    text,
    messageTs,
  };
}
