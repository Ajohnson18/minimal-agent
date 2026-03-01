import { afterEach, describe, expect, test, vi } from "vitest";

import {
  collectWithinWindow,
  debouncePerKey,
  dedupeByKey,
  dropOldestWhenFull,
} from "../../../../src/lib/queue/queue-helpers.js";

describe("queue helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("dedupeByKey keeps the latest value for each key", () => {
    const input = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "a", value: 3 },
    ];

    const deduped = dedupeByKey(input, (item) => item.id);

    expect(deduped).toEqual([
      { id: "a", value: 3 },
      { id: "b", value: 2 },
    ]);
  });

  test("dropOldestWhenFull removes overflow from the front", () => {
    const queue = ["m1", "m2", "m3", "m4"];

    const dropped = dropOldestWhenFull(queue, 3, 1);

    expect(dropped).toEqual(["m1", "m2"]);
    expect(queue).toEqual(["m3", "m4"]);
  });

  test("debouncePerKey flushes only the latest value", async () => {
    vi.useFakeTimers();
    const store = new Map<
      string,
      { value: number; timer: NodeJS.Timeout; queuedAt: number }
    >();
    const flushed: number[] = [];

    debouncePerKey(store, "k", 1, 50, async (value) => {
      flushed.push(value);
    });
    debouncePerKey(store, "k", 2, 50, async (value) => {
      flushed.push(value);
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(flushed).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toEqual([2]);
    expect(store.size).toBe(0);
  });

  test("collectWithinWindow keeps only recent entries", () => {
    const now = 10_000;
    const items = [
      { ts: now - 10_000, id: "old" },
      { ts: now - 900, id: "recent-a" },
      { ts: now - 100, id: "recent-b" },
    ];

    const collected = collectWithinWindow(items, 1_000, (item) => item.ts, now);

    expect(collected).toEqual([
      { ts: now - 900, id: "recent-a" },
      { ts: now - 100, id: "recent-b" },
    ]);
  });
});
