/**
 * Global registry for active reply dispatchers.
 * Used for lifecycle-aware idle tracking.
 */

type TrackedDispatcher = {
  readonly id: string;
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
};

const activeDispatchers = new Set<TrackedDispatcher>();
let nextId = 0;

export function registerDispatcher(dispatcher: {
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
}): { id: string; unregister: () => void } {
  const id = `dispatcher-${++nextId}`;
  const tracked: TrackedDispatcher = {
    id,
    pending: dispatcher.pending,
    waitForIdle: dispatcher.waitForIdle,
  };

  activeDispatchers.add(tracked);

  const unregister = () => {
    activeDispatchers.delete(tracked);
  };

  return { id, unregister };
}

export function getTotalPendingReplies(): number {
  let total = 0;
  for (const dispatcher of activeDispatchers) {
    total += dispatcher.pending();
  }
  return total;
}

export async function waitForDispatchersIdle(opts?: {
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const pollMs = opts?.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = [...activeDispatchers];
    if (snapshot.length === 0 || snapshot.every((d) => d.pending() === 0)) {
      await Promise.allSettled(snapshot.map((d) => d.waitForIdle()));
      if (getTotalPendingReplies() === 0) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return false;
}

export function clearAllDispatchersForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("clearAllDispatchersForTests() is only available in test environments");
  }
  activeDispatchers.clear();
}
