/**
 * Slack Threading Utilities
 *
 * Configurable reply-to threading mode.
 * Controls whether replies go to threads, main channel, or a mix.
 * Supports per-chat-type overrides.
 */

export type ReplyToMode = "off" | "first" | "all";

export function resolveReplyToMode(raw?: string): ReplyToMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "off" || normalized === "first" || normalized === "all") {
    return normalized;
  }
  return "all"; // Default: always thread (current AVA behavior)
}

import { getConfig } from '../config-loader.js';
const GLOBAL_MODE = resolveReplyToMode(getConfig().slack.replyToMode);

export function resolveReplyToModeForChatType(
  chatType: "direct" | "group" | "channel",
): ReplyToMode {
  const envKey = `SLACK_REPLY_TO_MODE_${chatType.toUpperCase()}`;
  const override = process.env[envKey];
  if (override) return resolveReplyToMode(override);
  return GLOBAL_MODE;
}

export interface ReplyDeliveryPlan {
  nextThreadTs(): string | undefined;
  markSent(): void;
}

/**
 * Create a delivery plan that decides thread_ts for each reply.
 *
 * - "off": no thread_ts unless already inside a thread
 * - "first": first reply threads, subsequent replies go to channel
 * - "all": all replies thread (original AVA behavior)
 */
export function createReplyDeliveryPlan(params: {
  replyToMode: ReplyToMode;
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
}): ReplyDeliveryPlan {
  const { replyToMode, incomingThreadTs, messageTs } = params;

  // If already inside a thread, always stay in it regardless of mode
  const effectiveMode = incomingThreadTs ? "all" : replyToMode;
  const threadTs = incomingThreadTs ?? messageTs;
  let hasSent = false;

  return {
    nextThreadTs() {
      switch (effectiveMode) {
        case "off":
          return undefined;
        case "first":
          return hasSent ? undefined : threadTs;
        case "all":
          return threadTs;
      }
    },
    markSent() {
      hasSent = true;
    },
  };
}
