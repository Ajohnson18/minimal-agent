/**
 * Deduplication Cache
 *
 * TTL + LRU eviction cache for event deduplication.
 * No timers — pruning happens lazily on check() calls.
 */
export class DedupeCache {
  private entries = new Map<string, number>();

  constructor(
    private ttlMs: number,
    private maxSize: number
  ) {}

  /**
   * Check if a key was seen recently.
   * Returns true if duplicate (already seen within TTL), false if first time.
   */
  check(key: string): boolean {
    const now = Date.now();
    this.prune(now);

    const existing = this.entries.get(key);
    if (existing !== undefined && (this.ttlMs <= 0 || now - existing < this.ttlMs)) {
      // Touch on duplicate to keep hot keys fresh (LRU-like behavior).
      this.entries.delete(key);
      this.entries.set(key, now);
      return true;
    }

    this.entries.delete(key);
    this.entries.set(key, now);
    this.prune(now);
    return false;
  }

  private prune(now: number) {
    for (const [key, ts] of this.entries) {
      if (this.ttlMs > 0 && now - ts > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxSize) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
      else break;
    }
  }
}
