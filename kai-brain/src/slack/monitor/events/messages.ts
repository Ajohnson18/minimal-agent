import { injectSystemEvent } from "../runtime.js";
import type {
  SlackAppMentionEvent,
  SlackEventCallbackEnvelope,
  SlackMessageEvent,
  SlackReactionEvent,
} from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";

export async function handleSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  body: SlackEventCallbackEnvelope;
  handleSlackMessage: SlackMessageHandler;
}): Promise<void> {
  const { ctx, body, handleSlackMessage } = params;
  const event = body.event as
    | SlackMessageEvent
    | SlackAppMentionEvent
    | SlackReactionEvent
    | Record<string, unknown>;

  const botUserId = body.authorizations?.[0]?.user_id;
  ctx.setBotUserId(botUserId);
  const effectiveBotUserId = botUserId ?? ctx.getBotUserId();

  const eventType = typeof event.type === "string" ? event.type : "";

  if (eventType === "app_mention") {
    const mention = event as SlackAppMentionEvent;
    const ts = mention.ts ?? mention.event_ts;
    if (mention.channel && ts) {
      const messageKey = `${mention.channel}:${ts}`;
      const mentionKey = `mention:${messageKey}`;
      if (ctx.markEventSeen(mentionKey)) {
        return;
      }
      ctx.markEventSeen(messageKey);
    }

    await handleSlackMessage(mention as unknown as SlackMessageEvent, {
      source: "app_mention",
      wasMentioned: true,
      botUserId,
    });
    return;
  }

  if (eventType === "message") {
    const message = event as SlackMessageEvent;
    const ts = message.ts ?? message.event_ts;
    let treatAsMention = false;
    if (message.channel && ts) {
      const baseKey = `${message.channel}:${ts}`;
      const hasExplicitMention = Boolean(
        effectiveBotUserId &&
          typeof message.text === "string" &&
          message.text.includes(`<@${effectiveBotUserId}>`),
      );
      if (hasExplicitMention) {
        // Handle the case where Slack sends only a message event for mentions.
        // Use the same mention key as app_mention so whichever event arrives first wins.
        const mentionKey = `mention:${baseKey}`;
        if (ctx.markEventSeen(mentionKey)) {
          return;
        }
        ctx.markEventSeen(baseKey);
        treatAsMention = true;
      } else if (ctx.markEventSeen(baseKey)) {
        return;
      }
    }

    if (message.subtype === "message_changed") {
      injectSystemEvent(message.channel, message.message?.thread_ts || message.message?.ts, {
        type: "message_edited",
        original: message.previous_message?.text?.slice(0, 200),
        updated: message.message?.text?.slice(0, 200),
        userId: message.message?.user,
      });
      return;
    }

    if (message.subtype === "message_deleted") {
      injectSystemEvent(
        message.channel,
        message.previous_message?.thread_ts || message.previous_message?.ts,
        {
          type: "message_deleted",
          text: message.previous_message?.text?.slice(0, 200),
          userId: message.previous_message?.user,
        },
      );
      return;
    }

    if (message.subtype && message.subtype !== "file_share") {
      return;
    }

    await handleSlackMessage(message, {
      source: treatAsMention ? "app_mention" : "message",
      wasMentioned: treatAsMention || undefined,
      botUserId: effectiveBotUserId,
    });
    return;
  }

  if (eventType === "reaction_added" || eventType === "reaction_removed") {
    if (ctx.reactionMode === "off") {
      return;
    }
    const reaction = event as SlackReactionEvent;
    if (ctx.reactionMode === "own" && reaction.item_user !== effectiveBotUserId) {
      return;
    }

    const itemChannel = reaction.item?.channel;
    if (!itemChannel) {
      return;
    }

    injectSystemEvent(itemChannel, reaction.item?.ts, {
      type: eventType,
      reaction: reaction.reaction,
      userId: reaction.user,
    });
  }
}
