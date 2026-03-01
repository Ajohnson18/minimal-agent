/**
 * Slack Context Utilities
 *
 * Sender name resolution, channel metadata, thread_ts resolution.
 * Uses LRU caching.
 */
import type { WebClient } from "@slack/web-api";

// --- Caches ---
const userNameCache = new Map<string, { name: string; expiresAt: number }>();
const channelInfoCache = new Map<string, { name: string; topic: string; purpose: string; expiresAt: number }>();
const threadTsCache = new Map<string, { threadTs: string | null; expiresAt: number }>();
const threadTsInflight = new Map<string, Promise<string | undefined>>();

const CACHE_TTL = 5 * 60 * 1000; // 5 min
const THREAD_TS_CACHE_TTL_MS = 60_000;
const THREAD_TS_CACHE_MAX = 500;

// --- Sender Name Resolution ---

export async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  try {
    const result = await client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.profile?.display_name || result.user?.name || userId;
    userNameCache.set(userId, { name, expiresAt: Date.now() + CACHE_TTL });
    // LRU eviction
    if (userNameCache.size > 500) {
      const oldest = userNameCache.keys().next().value;
      if (oldest) userNameCache.delete(oldest);
    }
    return name;
  } catch {
    return userId;
  }
}

// --- Channel Metadata ---

export async function resolveChannelInfo(
  client: WebClient,
  channelId: string
): Promise<{ name: string; topic: string; purpose: string }> {
  const cached = channelInfoCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const info = {
      name: result.channel?.name || channelId,
      topic: result.channel?.topic?.value || "",
      purpose: result.channel?.purpose?.value || "",
      expiresAt: Date.now() + CACHE_TTL,
    };
    channelInfoCache.set(channelId, info);
    return info;
  } catch {
    return { name: channelId, topic: "", purpose: "" };
  }
}

// --- Thread ts Resolution (fix Slack's missing thread_ts bug) ---

export async function resolveThreadTs(
  client: WebClient,
  channelId: string,
  messageTs: string,
  parentUserId?: string
): Promise<string | undefined> {
  // If no parent_user_id, this isn't a thread reply with missing thread_ts
  if (!parentUserId) return undefined;

  const cacheKey = `${channelId}:${messageTs}`;
  const cached = threadTsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    threadTsCache.delete(cacheKey);
    threadTsCache.set(cacheKey, cached);
    return cached.threadTs ?? undefined;
  }
  if (cached) {
    threadTsCache.delete(cacheKey);
  }

  const existing = threadTsInflight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = (async (): Promise<string | undefined> => {
    let resolvedThreadTs: string | undefined;
    try {
      // Look up message metadata to recover missing thread_ts for true thread replies.
      const result = await client.conversations.history({
        channel: channelId,
        latest: messageTs,
        oldest: messageTs,
        limit: 1,
        inclusive: true,
      });
      const message = result.messages?.find((entry) => entry.ts === messageTs) ?? result.messages?.[0];
      const candidate = message?.thread_ts?.trim();
      if (candidate) {
        resolvedThreadTs = candidate;
      }
    } catch {
      // ignore
    } finally {
      threadTsInflight.delete(cacheKey);
    }

    threadTsCache.set(cacheKey, {
      threadTs: resolvedThreadTs ?? null,
      expiresAt: Date.now() + THREAD_TS_CACHE_TTL_MS,
    });
    while (threadTsCache.size > THREAD_TS_CACHE_MAX) {
      const oldest = threadTsCache.keys().next().value;
      if (!oldest) break;
      threadTsCache.delete(oldest);
    }
    return resolvedThreadTs;
  })();

  threadTsInflight.set(cacheKey, pending);
  return pending;
}

// --- Inbound Message Sanitization ---

/**
 * Sanitize inbound user message text.
 * - Rejects null bytes
 * - Strips unsafe control characters (keep newline, tab, carriage return)
 * - Normalizes Unicode to NFC (prevents homoglyph/invisible-char attacks)
 */
export function sanitizeInboundMessage(text: string): string {
  if (!text) return text;

  // Strip null bytes
  let sanitized = text.replace(/\0/g, '');

  // Strip unsafe control characters (keep \n \r \t)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode to NFC
  sanitized = sanitized.normalize('NFC');

  return sanitized;
}

// --- Inbound Envelope Formatting ---

export function formatInboundEnvelope(params: {
  senderName: string;
  channelName?: string;
  channelType: string; // "direct", "group", "channel"
  timestamp: string;
  text: string;
  threadContext?: string;
}): string {
  const parts: string[] = [];

  // Header with sender info
  const location = params.channelType === "direct"
    ? "DM"
    : params.channelName
      ? `#${params.channelName}`
      : params.channelType;

  parts.push(`[${location} | ${params.senderName} | ${new Date(parseFloat(params.timestamp) * 1000).toISOString()}]`);

  // Thread context
  if (params.threadContext) {
    parts.push(`[Thread context: "${params.threadContext}"]`);
  }

  // Message
  parts.push(params.text);

  return parts.join("\n");
}
