export interface TypingKeepaliveController {
  start: (status: string) => Promise<void>;
  updateStatus: (status: string) => Promise<void>;
  clear: () => Promise<void>;
  dispose: () => void;
  isCleared: () => boolean;
}

interface CreateTypingKeepaliveControllerOptions {
  keepaliveMs: number;
  maxDurationMs: number;
  setStatus: (status: string) => Promise<void>;
}

function clampMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function createTypingKeepaliveController(
  options: CreateTypingKeepaliveControllerOptions,
): TypingKeepaliveController {
  const keepaliveMs = clampMs(options.keepaliveMs, 8000);
  const maxDurationMs = clampMs(options.maxDurationMs, 600000);

  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentStatus = "";
  let cleared = false;
  let sendChain: Promise<void> = Promise.resolve();

  const enqueueSetStatus = (status: string): Promise<void> => {
    sendChain = sendChain
      .then(async () => {
        await options.setStatus(status);
      })
      .catch(() => {
        // Ignore transient typing update failures.
      });
    return sendChain;
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const refresh = async () => {
    if (cleared) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxDurationMs) {
      await enqueueSetStatus("");
      cleared = true;
      stopTimer();
      return;
    }
    if (!currentStatus) return;
    await enqueueSetStatus(currentStatus);
  };

  return {
    start: async (status: string) => {
      startedAt = Date.now();
      currentStatus = status.trim();
      cleared = false;
      stopTimer();
      timer = setInterval(() => {
        void refresh();
      }, keepaliveMs);
      timer.unref?.();
      if (currentStatus) {
        await enqueueSetStatus(currentStatus);
      }
    },
    updateStatus: async (status: string) => {
      if (cleared) return;
      currentStatus = status.trim();
      if (!currentStatus) return;
      await enqueueSetStatus(currentStatus);
    },
    clear: async () => {
      if (cleared) return;
      cleared = true;
      currentStatus = "";
      stopTimer();
      await enqueueSetStatus("");
    },
    dispose: () => {
      stopTimer();
    },
    isCleared: () => cleared,
  };
}
