import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { resolveThreadTs } from "../../../src/lib/slack/context.js";

function makeClient(historyImpl: (args: unknown) => Promise<unknown>): WebClient {
  return {
    conversations: {
      history: historyImpl,
    },
  } as unknown as WebClient;
}

describe("resolveThreadTs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns undefined without parent_user_id", async () => {
    const history = vi.fn(async () => ({ messages: [] }));
    const client = makeClient(history);

    const result = await resolveThreadTs(client, "C1", "1.200");

    expect(result).toBeUndefined();
    expect(history).not.toHaveBeenCalled();
  });

  test("resolves missing thread_ts and reuses cache", async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: "1.200", thread_ts: "1.100" }],
    }));
    const client = makeClient(history);

    const first = await resolveThreadTs(client, "C2", "1.200", "U2");
    const second = await resolveThreadTs(client, "C2", "1.200", "U2");

    expect(first).toBe("1.100");
    expect(second).toBe("1.100");
    expect(history).toHaveBeenCalledTimes(1);
  });

  test("caches unresolved lookups briefly and retries after TTL", async () => {
    const history = vi.fn(async () => ({
      messages: [{ ts: "2.200" }],
    }));
    const client = makeClient(history);

    const first = await resolveThreadTs(client, "C3", "2.200", "U3");
    const second = await resolveThreadTs(client, "C3", "2.200", "U3");

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(history).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60_001);
    const third = await resolveThreadTs(client, "C3", "2.200", "U3");
    expect(third).toBeUndefined();
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("deduplicates concurrent history lookups for same message", async () => {
    let resolver: ((value: { messages: Array<{ ts: string; thread_ts: string }> }) => void) | null =
      null;
    const history = vi.fn(
      () =>
        new Promise<{ messages: Array<{ ts: string; thread_ts: string }> }>((resolve) => {
          resolver = resolve;
        }),
    );
    const client = makeClient(history);

    const p1 = resolveThreadTs(client, "C4", "4.200", "U4");
    const p2 = resolveThreadTs(client, "C4", "4.200", "U4");

    expect(history).toHaveBeenCalledTimes(1);
    resolver?.({ messages: [{ ts: "4.200", thread_ts: "4.100" }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("4.100");
    expect(r2).toBe("4.100");
  });
});
