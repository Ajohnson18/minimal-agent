import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createReplyDispatcher } from "../../../src/lib/slack/reply-dispatcher.js";
import {
  clearAllDispatchersForTests,
  getTotalPendingReplies,
} from "../../../src/lib/slack/dispatcher-registry.js";

describe("reply dispatcher parity", () => {
  beforeEach(() => {
    clearAllDispatchersForTests();
  });

  afterEach(() => {
    clearAllDispatchersForTests();
  });

  test("does not text-dedupe identical replies", async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text);
      },
    });

    dispatcher.sendFinalReply("same reply");
    dispatcher.sendFinalReply("same reply");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["same reply", "same reply"]);
  });

  test("preserves strict tool/block/final send order", async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text);
      },
      humanDelay: () => 0,
    });

    dispatcher.sendToolResult("tool");
    dispatcher.sendBlockReply("one");
    dispatcher.sendBlockReply("two");
    dispatcher.sendFinalReply("three");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["tool", "one", "two", "three"]);
    expect(dispatcher.getQueuedCounts()).toEqual({
      tool: 1,
      block: 2,
      final: 1,
    });
  });

  test("tracks pending dispatchers globally and unregisters on idle", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {},
    });

    // Reservation is pending until markComplete.
    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.sendFinalReply("done");
    expect(getTotalPendingReplies()).toBeGreaterThanOrEqual(2);

    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await Promise.resolve();

    expect(getTotalPendingReplies()).toBe(0);
  });

  test("treats legacy heartbeat token as normal text", async () => {
    const delivered: string[] = [];
    const onSkip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text);
      },
      onSkip,
    });

    const enqueued = dispatcher.sendFinalReply("HEARTBEAT_OK");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(enqueued).toBe(true);
    expect(delivered).toEqual(["HEARTBEAT_OK"]);
    expect(onSkip).not.toHaveBeenCalled();
  });

  test("applies responsePrefix during normalization", async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      responsePrefix: "[BOT] ",
      deliver: async (payload) => {
        delivered.push(payload.text);
      },
    });

    dispatcher.sendFinalReply("hello");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["[BOT] hello"]);
  });

  test("delivery errors still drain pending and emit onError", async () => {
    const onError = vi.fn();
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("boom");
      },
      onError,
      onIdle,
    });

    dispatcher.sendFinalReply("will fail");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(getTotalPendingReplies()).toBe(0);
  });

  test("markComplete without enqueued replies releases reservation once", async () => {
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {},
      onIdle,
    });

    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await Promise.resolve();

    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(getTotalPendingReplies()).toBe(0);

    dispatcher.markComplete();
    await Promise.resolve();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(getTotalPendingReplies()).toBe(0);
  });

  test("onIdle fires once after mixed skipped and delivered payloads", async () => {
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {},
      onIdle,
    });

    dispatcher.sendFinalReply("");
    dispatcher.sendFinalReply("actual delivery");
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await Promise.resolve();

    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(getTotalPendingReplies()).toBe(0);
  });
});
