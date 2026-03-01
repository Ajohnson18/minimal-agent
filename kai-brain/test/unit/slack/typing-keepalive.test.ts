import { afterEach, describe, expect, test, vi } from "vitest";

import { createTypingKeepaliveController } from "../../../src/slack/monitor/typing-keepalive.js";

describe("typing keepalive controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts, refreshes, updates, and clears typing state", async () => {
    vi.useFakeTimers();
    const setStatus = vi.fn(async () => {});
    const typing = createTypingKeepaliveController({
      keepaliveMs: 1_000,
      maxDurationMs: 10_000,
      setStatus,
    });

    await typing.start("is thinking...");
    expect(setStatus).toHaveBeenCalledWith("is thinking...");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setStatus).toHaveBeenLastCalledWith("is thinking...");

    await typing.updateStatus("Running command...");
    expect(setStatus).toHaveBeenLastCalledWith("Running command...");

    await typing.clear();
    expect(setStatus).toHaveBeenLastCalledWith("");
    expect(typing.isCleared()).toBe(true);

    const callCount = setStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setStatus.mock.calls.length).toBe(callCount);
  });

  test("auto-clears after max duration", async () => {
    vi.useFakeTimers();
    const setStatus = vi.fn(async () => {});
    const typing = createTypingKeepaliveController({
      keepaliveMs: 1_000,
      maxDurationMs: 2_200,
      setStatus,
    });

    await typing.start("is thinking...");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(typing.isCleared()).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("");
  });
});
