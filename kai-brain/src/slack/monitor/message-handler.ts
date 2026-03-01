import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import { createSlackMessageDispatch } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";

type SlackMessageSource = "message" | "app_mention";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: SlackMessageSource; wasMentioned?: boolean; botUserId?: string },
) => Promise<void>;

type DebouncedEntry = {
  message: SlackMessageEvent;
  opts: { source: SlackMessageSource; wasMentioned?: boolean; botUserId?: string };
  texts: string[];
  timer: NodeJS.Timeout;
};

function stripSlackMentionsForCommandDetection(text: string): string {
  return text
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasControlCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}

export function buildSlackDebounceKey(params: {
  accountId: string;
  message: SlackMessageEvent;
}): string | null {
  const senderId = params.message.user ?? params.message.bot_id;
  if (!senderId) {
    return null;
  }
  const messageTs = params.message.ts ?? params.message.event_ts;
  const threadKey = params.message.thread_ts
    ? `${params.message.channel}:${params.message.thread_ts}`
    : params.message.parent_user_id && messageTs
      ? `${params.message.channel}:maybe-thread:${messageTs}`
      : params.message.channel;
  return `slack:${params.accountId}:${threadKey}:${senderId}`;
}

function shouldDebounceMessage(message: SlackMessageEvent): boolean {
  const text = message.text ?? "";
  if (!text.trim()) {
    return false;
  }
  if (message.files && message.files.length > 0) {
    return false;
  }
  const normalized = stripSlackMentionsForCommandDetection(text);
  return !hasControlCommand(normalized);
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
}): SlackMessageHandler {
  const { ctx } = params;
  const dispatch = createSlackMessageDispatch();
  const debounceMs = Math.max(0, ctx.inboundDebounceMs);
  const debounceMap = new Map<string, DebouncedEntry>();

  const flushEntry = async (key: string): Promise<void> => {
    const entry = debounceMap.get(key);
    if (!entry) {
      return;
    }
    debounceMap.delete(key);

    const combinedText =
      entry.texts.length <= 1
        ? (entry.message.text ?? "")
        : entry.texts.filter(Boolean).join("\n");
    const synthetic: SlackMessageEvent = {
      ...entry.message,
      text: combinedText,
    };

    const prepared = await prepareSlackMessage({
      ctx,
      message: synthetic,
      opts: {
        ...entry.opts,
        wasMentioned: Boolean(entry.opts.wasMentioned),
      },
    });

    if (!prepared) {
      return;
    }

    await dispatch.dispatchPrepared(prepared);
  };

  return async (message, opts) => {
    if (opts.source === "message" && message.type !== "message") {
      return;
    }

    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      return;
    }

    const resolvedMessage = await ctx.threadTsResolver.resolve({
      message,
      source: opts.source,
    });

    if (debounceMs <= 0 || !shouldDebounceMessage(resolvedMessage)) {
      const prepared = await prepareSlackMessage({
        ctx,
        message: resolvedMessage,
        opts,
      });
      if (!prepared) {
        return;
      }
      await dispatch.dispatchPrepared(prepared);
      return;
    }

    const key = buildSlackDebounceKey({
      accountId: ctx.accountId,
      message: resolvedMessage,
    });
    if (!key) {
      const prepared = await prepareSlackMessage({
        ctx,
        message: resolvedMessage,
        opts,
      });
      if (!prepared) {
        return;
      }
      await dispatch.dispatchPrepared(prepared);
      return;
    }

    const existing = debounceMap.get(key);
    if (existing) {
      existing.texts.push(resolvedMessage.text ?? "");
      existing.message = {
        ...resolvedMessage,
        files: existing.message.files,
        attachments: [
          ...(existing.message.attachments ?? []),
          ...(resolvedMessage.attachments ?? []),
        ],
      };
      existing.opts = {
        ...existing.opts,
        wasMentioned: Boolean(existing.opts.wasMentioned || opts.wasMentioned),
      };
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void flushEntry(key);
      }, debounceMs);
      existing.timer.unref();
      return;
    }

    const timer = setTimeout(() => {
      void flushEntry(key);
    }, debounceMs);
    timer.unref();
    debounceMap.set(key, {
      message: resolvedMessage,
      opts,
      texts: [resolvedMessage.text ?? ""],
      timer,
    });
  };
}
