import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { createSlackThreadTsResolver } from "../../../src/slack/monitor/thread-resolution.js";
import type { SlackMessageEvent } from "../../../src/slack/types.js";

function makeMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C1",
    user: "U1",
    text: "hello",
    ts: "1.200",
    ...overrides,
  };
}

function makeClient(historyImpl: (args: unknown) => Promise<unknown>): WebClient {
  return {
    conversations: {
      history: historyImpl,
    },
  } as unknown as WebClient;
}

describe("createSlackThreadTsResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns message unchanged when parent_user_id is absent", async () => {
    const history = vi.fn(async () => ({ messages: [] }));
    const resolver = createSlackThreadTsResolver({
      getClient: () => makeClient(history),
    });

    const message = makeMessage({ parent_user_id: undefined });
    const resolved = await resolver.resolve({ message, source: "message" });

    expect(resolved).toEqual(message);
    expect(history).not.toHaveBeenCalled();
  });

  test("resolves and caches missing thread_ts", async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: "1.200", thread_ts: "1.100" }],
    }));
    const resolver = createSlackThreadTsResolver({
      getClient: () => makeClient(history),
      cacheTtlMs: 60_000,
      maxSize: 500,
    });

    const message = makeMessage({ parent_user_id: "U_PARENT", thread_ts: undefined });
    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("1.100");
    expect(second.thread_ts).toBe("1.100");
    expect(history).toHaveBeenCalledTimes(1);
  });

  test("caches unresolved lookups and retries after TTL", async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: "1.200" }],
    }));
    const resolver = createSlackThreadTsResolver({
      getClient: () => makeClient(history),
      cacheTtlMs: 60_000,
      maxSize: 500,
    });

    const message = makeMessage({ parent_user_id: "U_PARENT", thread_ts: undefined });
    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBeUndefined();
    expect(second.thread_ts).toBeUndefined();
    expect(history).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60_001);
    await resolver.resolve({ message, source: "message" });
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent lookups for same key", async () => {
    let resolveHistory:
      | ((value: { messages: Array<{ ts: string; thread_ts: string }> }) => void)
      | null = null;
    const history = vi.fn(
      () =>
        new Promise<{ messages: Array<{ ts: string; thread_ts: string }> }>((resolve) => {
          resolveHistory = resolve;
        }),
    );

    const resolver = createSlackThreadTsResolver({
      getClient: () => makeClient(history),
      cacheTtlMs: 60_000,
      maxSize: 500,
    });

    const message = makeMessage({ parent_user_id: "U_PARENT", thread_ts: undefined });
    const p1 = resolver.resolve({ message, source: "message" });
    const p2 = resolver.resolve({ message, source: "message" });

    expect(history).toHaveBeenCalledTimes(1);
    resolveHistory?.({ messages: [{ ts: "1.200", thread_ts: "1.100" }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.thread_ts).toBe("1.100");
    expect(r2.thread_ts).toBe("1.100");
  });
});
