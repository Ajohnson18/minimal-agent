export function dedupeByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    byKey.set(keyOf(item), item);
  }
  return [...byKey.values()];
}

export function dropOldestWhenFull<T>(
  queue: T[],
  cap: number,
  incomingCount = 1,
): T[] {
  const safeCap = Math.max(1, Math.floor(cap));
  const safeIncoming = Math.max(0, Math.floor(incomingCount));
  const overflow = queue.length + safeIncoming - safeCap;
  if (overflow <= 0) {
    return [];
  }
  return queue.splice(0, overflow);
}

type DebounceEntry<T> = {
  value: T;
  timer: NodeJS.Timeout;
  queuedAt: number;
};

export function debouncePerKey<K, T>(
  store: Map<K, DebounceEntry<T>>,
  key: K,
  value: T,
  delayMs: number,
  onFlush: (value: T) => void | Promise<void>,
): void {
  const existing = store.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    const latest = store.get(key);
    if (!latest) return;
    store.delete(key);
    void onFlush(latest.value);
  }, Math.max(0, delayMs));
  timer.unref?.();

  store.set(key, {
    value,
    timer,
    queuedAt: Date.now(),
  });
}

export function collectWithinWindow<T>(
  items: T[],
  windowMs: number,
  getTimestamp: (item: T) => number,
  now = Date.now(),
): T[] {
  const cutoff = now - Math.max(0, windowMs);
  return items.filter((item) => getTimestamp(item) >= cutoff);
}
