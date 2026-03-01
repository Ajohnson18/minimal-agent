import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DedupeCache } from "../../../src/lib/dedupe-cache.js";

describe("DedupeCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("touches duplicate keys and expires based on latest sighting", () => {
    const cache = new DedupeCache(1_000, 10);

    expect(cache.check("k1")).toBe(false);

    vi.setSystemTime(500);
    expect(cache.check("k1")).toBe(true);

    // Still within TTL from the duplicate touch at t=500.
    vi.setSystemTime(1_200);
    expect(cache.check("k1")).toBe(true);

    // Expired relative to last touch at t=1_200.
    vi.setSystemTime(2_201);
    expect(cache.check("k1")).toBe(false);
  });

  test("evicts oldest non-touched keys when max size is exceeded", () => {
    const cache = new DedupeCache(60_000, 2);

    expect(cache.check("a")).toBe(false);
    vi.setSystemTime(1);
    expect(cache.check("b")).toBe(false);

    // Touch "a" so "b" becomes the oldest entry.
    vi.setSystemTime(2);
    expect(cache.check("a")).toBe(true);

    vi.setSystemTime(3);
    expect(cache.check("c")).toBe(false);

    // "b" should have been evicted by max-size pruning.
    vi.setSystemTime(4);
    expect(cache.check("b")).toBe(false);
  });
});
