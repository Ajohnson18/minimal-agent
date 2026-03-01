import { readFileSync } from "node:fs";
import { getConfig } from "../../lib/config-loader.js";
import { DedupeCache } from "../../lib/dedupe-cache.js";
import { getSlackApp } from "../../lib/slack/app.js";
import {
  buildMentionRegexes,
  type MentionConfig,
} from "../../lib/slack/mentions.js";
import {
  createSlackThreadTsResolver,
  type SlackThreadTsResolver,
} from "./thread-resolution.js";
import type { SlackChannelType } from "../types.js";

export interface ChannelConfig {
  enabled?: boolean;
  requireMention?: boolean;
  systemPrompt?: string;
  allowBots?: boolean;
}

export type MentionGatingMode =
  | "default"
  | "any"
  | "explicit-only"
  | "explicit-or-implicit";

export interface SlackMonitorContext {
  accountId: string;
  mentionPatterns: RegExp[];
  mentionGatingMode: MentionGatingMode;
  reactionMode: string;
  inboundDebounceMs: number;
  defaultRequireMention: boolean;
  threadHistoryScope: "thread" | "channel";
  getMentionConfig: (botUserId?: string) => MentionConfig;
  getChannelConfig: (channelId: string) => ChannelConfig | undefined;
  markEventSeen: (key: string) => boolean;
  markInteractionSeen: (key: string) => boolean;
  threadTsResolver: SlackThreadTsResolver;
  setBotUserId: (botUserId?: string) => void;
  getBotUserId: () => string | undefined;
}

function normalizeMentionGatingMode(value: string | undefined): MentionGatingMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "default" ||
    normalized === "any" ||
    normalized === "explicit-only" ||
    normalized === "explicit-or-implicit"
  ) {
    return normalized;
  }
  return "default";
}

export function inferSlackChannelType(
  channelId?: string | null,
): SlackChannelType | undefined {
  const trimmed = channelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("D")) {
    return "im";
  }
  if (trimmed.startsWith("G")) {
    return "group";
  }
  if (trimmed.startsWith("C")) {
    return "channel";
  }
  return undefined;
}

export function normalizeSlackChannelType(
  channelType?: string | null,
  channelId?: string | null,
): SlackChannelType {
  const normalized = channelType?.trim().toLowerCase();
  if (
    normalized === "im" ||
    normalized === "mpim" ||
    normalized === "channel" ||
    normalized === "group"
  ) {
    return normalized;
  }
  return inferSlackChannelType(channelId) ?? "channel";
}

function loadChannelConfig(): Record<string, ChannelConfig> {
  const configPath = process.env.SLACK_CHANNEL_CONFIG?.trim();
  if (!configPath) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, ChannelConfig>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function getSlackClientOrNull() {
  try {
    return getSlackApp().client;
  } catch {
    return null;
  }
}

export function createSlackMonitorContext(params?: {
  accountId?: string;
}): SlackMonitorContext {
  const config = getConfig();
  const mentionPatterns = buildMentionRegexes();
  const channelConfigs = loadChannelConfig();

  const eventDedup = new DedupeCache(
    config.slack.inboundDedupeTtlMs,
    config.slack.inboundDedupeMaxSize,
  );
  const interactionDedup = new DedupeCache(
    config.slack.interactionDedupeTtlMs,
    config.slack.interactionDedupeMaxSize,
  );

  let botUserId: string | undefined;

  const threadTsResolver = createSlackThreadTsResolver({
    getClient: getSlackClientOrNull,
    cacheTtlMs: config.slack.missingThreadCacheTtlMs,
    maxSize: config.slack.missingThreadCacheMaxSize,
  });

  return {
    accountId: params?.accountId?.trim() || "default",
    mentionPatterns,
    mentionGatingMode: normalizeMentionGatingMode(config.slack.mentionGatingMode),
    reactionMode: config.slack.reactionNotifications,
    inboundDebounceMs: config.slack.inboundDebounceMs,
    defaultRequireMention: config.slack.defaultRequireMention,
    threadHistoryScope: config.slack.threadHistoryScope,
    getMentionConfig: (nextBotUserId?: string) => ({
      botUserId: nextBotUserId ?? botUserId,
      patterns: mentionPatterns,
    }),
    getChannelConfig: (channelId) => channelConfigs[channelId],
    markEventSeen: (key) => eventDedup.check(key),
    markInteractionSeen: (key) => interactionDedup.check(key),
    threadTsResolver,
    setBotUserId: (nextBotUserId) => {
      const trimmed = nextBotUserId?.trim();
      if (trimmed) {
        botUserId = trimmed;
      }
    },
    getBotUserId: () => botUserId,
  };
}
