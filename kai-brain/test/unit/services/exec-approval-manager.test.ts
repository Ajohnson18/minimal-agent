import { afterEach, describe, expect, test, vi } from "vitest";

import { ExecApprovalManager } from "../../../src/services/exec-approval-manager.js";

function buildRequest() {
  return {
    sessionId: "session-1",
    userId: "user-1",
    agentId: "main",
    command: "echo hello",
    cwd: "/tmp",
    host: "gateway" as const,
    security: "allowlist" as const,
    ask: "always" as const,
  };
}

describe("exec approval manager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("create/register/resolve lifecycle", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(buildRequest(), 2_000, "approval-1");
    const outcomePromise = manager.register(record, 2_000);

    const resolved = manager.resolve("approval-1", "allow-once", "resolver-1");
    expect(resolved).toBe(true);

    await expect(outcomePromise).resolves.toMatchObject({
      decision: "allow-once",
      resolvedBy: "resolver-1",
    });
    expect(manager.getSnapshot("approval-1")?.decision).toBe("allow-once");
    manager.reset();
  });

  test("timeout returns null decision", async () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    const record = manager.create(buildRequest(), 100, "approval-timeout");
    const outcomePromise = manager.register(record, 100);

    await vi.advanceTimersByTimeAsync(150);

    await expect(outcomePromise).resolves.toMatchObject({
      decision: null,
      timedOut: true,
    });
    manager.reset();
  });

  test("rejects duplicate approval ids", () => {
    const manager = new ExecApprovalManager();
    const first = manager.create(buildRequest(), 2_000, "dup-approval");
    manager.register(first, 2_000);

    const second = manager.create(buildRequest(), 2_000, "dup-approval");
    expect(() => manager.register(second, 2_000)).toThrow(/already exists/);
    manager.reset();
  });

  test("late waiter can read resolved outcome during grace window", async () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    const record = manager.create(buildRequest(), 2_000, "approval-grace");
    const outcomePromise = manager.register(record, 2_000);

    manager.resolve("approval-grace", "deny", "resolver-2", "no");
    await expect(outcomePromise).resolves.toMatchObject({ decision: "deny" });

    const lateWait = manager.awaitOutcome("approval-grace");
    expect(lateWait).not.toBeNull();
    await expect(lateWait!).resolves.toMatchObject({ decision: "deny" });

    await vi.advanceTimersByTimeAsync(16_000);
    expect(manager.awaitOutcome("approval-grace")).toBeNull();
    manager.reset();
  });
});
