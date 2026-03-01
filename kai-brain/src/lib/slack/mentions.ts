/**
 * Slack Mention Gating
 *
 * Mention detection:
 * - Explicit bot mention (<@BOT_ID>)
 * - Implicit mention (reply in thread where bot is parent)
 * - Regex pattern matching (configurable)
 * - Bypass for control commands from authorized users
 */
import { getConfig } from '../config-loader.js';

export interface MentionConfig {
  botUserId?: string;
  patterns?: RegExp[];
}

export interface MentionCheckResult {
  wasMentioned: boolean;
  isExplicit: boolean;
  isImplicit: boolean;
  isPattern: boolean;
}

/**
 * Build mention regex patterns from environment config.
 * SLACK_MENTION_PATTERNS is a JSON array of regex strings.
 */
export function buildMentionRegexes(): RegExp[] {
  const patterns = getConfig().slack.mentionPatterns;
  const raw = patterns.length > 0 ? JSON.stringify(patterns) : undefined;
  if (!raw) return [];

  try {
    const patterns = JSON.parse(raw);
    if (!Array.isArray(patterns)) return [];
    return patterns
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => new RegExp(p, "i"));
  } catch {
    console.error("[MENTIONS] Failed to parse SLACK_MENTION_PATTERNS:", raw);
    return [];
  }
}

/**
 * Check if a message mentions the bot through any detection method.
 */
export function checkMention(params: {
  text: string;
  config: MentionConfig;
  threadParentUserId?: string;
  isInThread: boolean;
}): MentionCheckResult {
  const { text, config, threadParentUserId, isInThread } = params;

  // Explicit mention: <@BOT_ID>
  const isExplicit = Boolean(
    config.botUserId && text.includes(`<@${config.botUserId}>`)
  );

  // Implicit mention: reply in thread where bot is the parent message author
  const isImplicit = Boolean(
    isInThread && config.botUserId && threadParentUserId === config.botUserId
  );

  // Pattern match: custom regex patterns
  const isPattern = (config.patterns ?? []).some((re) => re.test(text));

  return {
    wasMentioned: isExplicit || isImplicit || isPattern,
    isExplicit,
    isImplicit,
    isPattern,
  };
}

/**
 * Determine if a channel message should be processed based on mention gating.
 * Returns true if the message should be processed.
 */
export function shouldProcessChannelMessage(params: {
  requireMention: boolean;
  mentionResult: MentionCheckResult;
  isControlCommand: boolean;
  isAuthorizedSender: boolean;
}): boolean {
  const { requireMention, mentionResult, isControlCommand, isAuthorizedSender } = params;

  // If mention not required, always process
  if (!requireMention) return true;

  // If mentioned through any method, process
  if (mentionResult.wasMentioned) return true;

  // Control commands from authorized senders bypass mention gating
  if (isControlCommand && isAuthorizedSender) return true;

  return false;
}

/**
 * Strip bot mention from message text for cleaner processing.
 */
export function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
}
