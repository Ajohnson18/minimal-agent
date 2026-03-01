import { registerDispatcher } from "./dispatcher-registry.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export interface ReplyPayload {
  text: string;
}

export type ReplyInput = string | ReplyPayload;

export type NormalizeReplySkipReason = "empty";

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

type ReplyDispatchErrorHandler = (
  err: unknown,
  info: { kind: ReplyDispatchKind },
) => void;

type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind; reason: NormalizeReplySkipReason },
) => void;

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  onError?: ReplyDispatchErrorHandler;
  onIdle?: () => void;
  onSkip?: ReplyDispatchSkipHandler;
  responsePrefix?: string;
  humanDelay?: () => number;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  onCleanup?: () => void;
};

export interface TypingController {
  markDispatchIdle: () => void;
}

export type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: {
    onReplyStart?: () => Promise<void> | void;
    onTypingController: (typing: TypingController) => void;
    onTypingCleanup?: () => void;
  };
  markDispatchIdle: () => void;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyInput) => boolean;
  sendBlockReply: (payload: ReplyInput) => boolean;
  sendFinalReply: (payload: ReplyInput) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  didDeliver: () => boolean;
  markComplete: () => void;
};

function toReplyPayload(input: ReplyInput): ReplyPayload {
  if (typeof input === "string") {
    return { text: input };
  }
  return { text: typeof input.text === "string" ? input.text : "" };
}

function normalizeReplyPayload(
  payload: ReplyPayload,
  options: Pick<ReplyDispatcherOptions, "responsePrefix">,
): ReplyPayload | null {
  let text = payload.text ?? "";
  if (typeof text !== "string") {
    text = "";
  }

  const prefix = options.responsePrefix;
  if (prefix && prefix.trim().length > 0) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(prefix)) {
      text = `${prefix}${text}`;
    }
  }

  if (!text.trim()) {
    return null;
  }

  return { text };
}

export function createReplyDispatcher(
  options: ReplyDispatcherOptions,
): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  // pending starts at 1 as a "reservation" to prevent premature idle.
  // Decremented when markComplete() signals no more replies will come.
  let pending = 1;
  let completeCalled = false;
  let sentFirstBlock = false;
  let delivered = false;
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  let registryClosed = false;

  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  const checkIdle = () => {
    if (pending !== 0) return;
    if (!registryClosed) {
      registryClosed = true;
      unregister();
    }
    options.onIdle?.();
  };

  const enqueue = (kind: ReplyDispatchKind, input: ReplyInput): boolean => {
    const payload = toReplyPayload(input);
    const normalized = normalizeReplyPayload(payload, {
      responsePrefix: options.responsePrefix,
    });
    if (!normalized) {
      options.onSkip?.(payload, {
        kind,
        reason: "empty",
      });
      return false;
    }

    queuedCounts[kind] += 1;
    pending += 1;

    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

    sendChain = sendChain
      .then(async () => {
        if (shouldDelay) {
          const delayMs = options.humanDelay?.() ?? 0;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        await options.deliver(normalized, { kind });
        delivered = true;
      })
      .catch((err) => {
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 1 && completeCalled) {
          pending -= 1;
        }
        checkIdle();
      });

    return true;
  };

  const markComplete = () => {
    if (completeCalled) return;
    completeCalled = true;
    // If no replies were enqueued, clear the reservation on next microtask.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        pending -= 1;
        checkIdle();
      }
    });
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    didDeliver: () => delivered,
    markComplete,
  };
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
  let typingController: TypingController | undefined;

  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart,
      onTypingController: (typing) => {
        typingController = typing;
      },
      onTypingCleanup: onCleanup,
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
  };
}
