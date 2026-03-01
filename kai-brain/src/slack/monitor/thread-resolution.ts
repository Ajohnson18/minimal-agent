import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../types.js";

export type SlackThreadTsResolver = {
  resolve: (params: {
    message: SlackMessageEvent;
    source: "message" | "app_mention";
  }) => Promise<SlackMessageEvent>;
};

type ThreadTsCacheEntry = {
  threadTs: string | null;
  updatedAt: number;
};

const DEFAULT_THREAD_TS_CACHE_TTL_MS = 60_000;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;

function normalizeThreadTs(threadTs?: string | null): string | undefined {
  const trimmed = threadTs?.trim();
  return trimmed ? trimmed : undefined;
}

function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  if (maxSize <= 0) {
    map.clear();
    return;
  }
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

async function resolveThreadTsFromHistory(params: {
  client: SlackWebClient;
  channelId: string;
  messageTs: string;
}): Promise<string | undefined> {
  try {
    const response = (await params.client.conversations.history({
      channel: params.channelId,
      latest: params.messageTs,
      oldest: params.messageTs,
      inclusive: true,
      limit: 1,
    })) as { messages?: Array<{ ts?: string; thread_ts?: string }> };
    const message =
      response.messages?.find((entry) => entry.ts === params.messageTs) ??
      response.messages?.[0];
    return normalizeThreadTs(message?.thread_ts);
  } catch {
    return undefined;
  }
}

export function createSlackThreadTsResolver(params: {
  getClient: () => SlackWebClient | null;
  cacheTtlMs?: number;
  maxSize?: number;
}): SlackThreadTsResolver {
  const ttlMs = Math.max(0, params.cacheTtlMs ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
  const maxSize = Math.max(0, params.maxSize ?? DEFAULT_THREAD_TS_CACHE_MAX);
  const cache = new Map<string, ThreadTsCacheEntry>();
  const inflight = new Map<string, Promise<string | undefined>>();

  const getCached = (key: string, now: number): string | null | undefined => {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (ttlMs > 0 && now - entry.updatedAt > ttlMs) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, { ...entry, updatedAt: now });
    return entry.threadTs;
  };

  const setCached = (key: string, threadTs: string | null, now: number): void => {
    cache.delete(key);
    cache.set(key, { threadTs, updatedAt: now });
    pruneMapToMaxSize(cache, maxSize);
  };

  return {
    resolve: async (request) => {
      const { message } = request;
      if (!message.parent_user_id || message.thread_ts || !message.ts) {
        return message;
      }

      const client = params.getClient();
      if (!client) {
        return message;
      }

      const cacheKey = `${message.channel}:${message.ts}`;
      const now = Date.now();
      const cached = getCached(cacheKey, now);
      if (cached !== undefined) {
        return cached ? { ...message, thread_ts: cached } : message;
      }

      let pending = inflight.get(cacheKey);
      if (!pending) {
        pending = resolveThreadTsFromHistory({
          client,
          channelId: message.channel,
          messageTs: message.ts,
        });
        inflight.set(cacheKey, pending);
      }

      let resolved: string | undefined;
      try {
        resolved = await pending;
      } finally {
        inflight.delete(cacheKey);
      }

      setCached(cacheKey, resolved ?? null, Date.now());
      return resolved ? { ...message, thread_ts: resolved } : message;
    },
  };
}
