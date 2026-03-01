import { afterEach, describe, expect, test, vi } from "vitest";

import {
  hasPendingHeartbeatWake,
  requestHeartbeatNow,
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler,
  setStopSessionHeartbeatCallback,
} from "../../../src/gateway/services/heartbeat-wake.js";

describe("heartbeat wake coordinator", () => {
  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
  });

  test("coalesces repeated wakes for the same session", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-1",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 50,
    });
    requestHeartbeatNow({
      sessionId: "s-1",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 50,
    });
    requestHeartbeatNow({
      sessionId: "s-1",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 50,
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-1",
        reason: expect.objectContaining({
          kind: "interval",
          key: "interval",
          priority: 1,
          source: "system",
        }),
      }),
    );
  });

  test("does not run heartbeat handler concurrently", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;

    const handler = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
      return { status: "ran", durationMs: 1 } as const;
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-a",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    requestHeartbeatNow({
      sessionId: "s-b",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    requestHeartbeatNow({
      sessionId: "s-c",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  test("retries after queue-busy skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "queue-busy" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 5 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-retry",
      reason: {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("retries transient heartbeat failures with backoff", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "delivery-failed" })
      .mockResolvedValueOnce({ status: "skipped", reason: "heartbeat-error" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 5 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-transient",
      reason: {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  test("honors higher-priority wake reason within coalescing window", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-priority",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 75,
    });
    requestHeartbeatNow({
      sessionId: "s-priority",
      reason: {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
      coalesceMs: 75,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-priority",
        reason: expect.objectContaining({
          kind: "event",
          eventKind: "subagent.completion",
          source: "subagent",
          key: "event:subagent.completion",
          priority: 3,
        }),
      }),
    );
  });

  test("stale disposer does not clear a newer handler", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const disposeA = setHeartbeatWakeHandler(handlerA);
    const disposeB = setHeartbeatWakeHandler(handlerB);

    disposeA();

    requestHeartbeatNow({
      sessionId: "s-new",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);

    disposeB();
    requestHeartbeatNow({
      sessionId: "s-new",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  test("drains pending wake once a handler is registered", async () => {
    vi.useFakeTimers();

    requestHeartbeatNow({
      sessionId: "s-pending",
      reason: { kind: "manual", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(hasPendingHeartbeatWake()).toBe(true);

    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s-pending",
        reason: expect.objectContaining({
          kind: "manual",
          key: "manual",
          priority: 2,
          source: "system",
        }),
      }),
    );
    expect(hasPendingHeartbeatWake()).toBe(false);
  });

  test("keeps retry cooldown when a new wake arrives sooner", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "queue-busy" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-retry-cooldown",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    requestHeartbeatNow({
      sessionId: "s-retry-cooldown",
      reason: {
        kind: "event",
        eventKind: "subagent.completion",
        source: "subagent",
      },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "s-retry-cooldown",
        reason: expect.objectContaining({
          kind: "event",
          eventKind: "subagent.completion",
          source: "subagent",
          key: "event:subagent.completion",
          priority: 3,
        }),
      }),
    );
  });

  test("new handler registration clears stale running state", async () => {
    vi.useFakeTimers();

    let resolveHang: (() => void) | undefined;
    const hangingPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });

    const handlerA = vi.fn().mockImplementation(
      () => hangingPromise.then(() => ({ status: "ran" as const, durationMs: 1 })),
    );
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeatNow({
      sessionId: "s-hang",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    requestHeartbeatNow({
      sessionId: "s-hang",
      reason: { kind: "manual", source: "system" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    resolveHang?.();
    await Promise.resolve();
  });

  test("terminates heartbeat after consecutive no-delivery-target failures", async () => {
    vi.useFakeTimers();
    const stopHeartbeatMock = vi.fn();
    setStopSessionHeartbeatCallback(stopHeartbeatMock);

    const handler = vi.fn().mockResolvedValue({ 
      status: "skipped", 
      reason: "no-delivery-target" 
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      sessionId: "s-no-target",
      reason: { kind: "interval", source: "system" },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stopHeartbeatMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(stopHeartbeatMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(stopHeartbeatMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(stopHeartbeatMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8_000);
    expect(handler).toHaveBeenCalledTimes(5);
    expect(stopHeartbeatMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16_000);
    expect(handler).toHaveBeenCalledTimes(6);
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(stopHeartbeatMock).toHaveBeenCalledWith("s-no-target");
  });
});
