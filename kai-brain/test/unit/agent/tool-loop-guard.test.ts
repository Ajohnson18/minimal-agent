import { describe, expect, test } from "vitest";

import { ToolLoopGuard } from "../../../src/agent/tool-loop-guard.js";

describe("tool-loop-guard", () => {
  test("warns and blocks on identical repeated calls", () => {
    const guard = new ToolLoopGuard({
      identicalWarnThreshold: 2,
      identicalBlockThreshold: 3,
      globalCircuitBreaker: 99,
    });

    expect(guard.check("exec", { command: "ls" }).action).toBe("allow");
    expect(guard.check("exec", { command: "ls" }).action).toBe("warn");

    const blocked = guard.check("exec", { command: "ls" });
    expect(blocked.action).toBe("block");
    expect(blocked.reason).toContain("called identically");
  });

  test("blocks known no-progress patterns quickly", () => {
    const guard = new ToolLoopGuard({
      knownNoProgressPatterns: ["process:poll"],
      globalCircuitBreaker: 99,
      identicalWarnThreshold: 99,
      identicalBlockThreshold: 99,
    });

    guard.check("process", { action: "poll" });
    guard.check("process", { action: "poll" });
    const result = guard.check("process", { action: "poll" });

    expect(result.action).toBe("block");
    expect(result.reason).toContain("no progress");
  });

  test("warns on ping-pong patterns", () => {
    const guard = new ToolLoopGuard({
      pingPongWarnThreshold: 2,
      globalCircuitBreaker: 99,
      identicalWarnThreshold: 99,
      identicalBlockThreshold: 99,
    });

    guard.check("toolA", { x: 1 });
    guard.check("toolB", { y: 1 });
    guard.check("toolA", { x: 1 });
    const result = guard.check("toolB", { y: 1 });

    expect(result.action).toBe("warn");
    expect(result.reason).toContain("alternating");
  });

  test("reset clears guard state", () => {
    const guard = new ToolLoopGuard({
      identicalWarnThreshold: 2,
      identicalBlockThreshold: 3,
      globalCircuitBreaker: 99,
    });

    guard.check("exec", { command: "pwd" });
    guard.check("exec", { command: "pwd" });
    guard.reset();

    expect(guard.check("exec", { command: "pwd" }).action).toBe("allow");
  });
});
