/**
 * Tool Loop Guard
 *
 * Detects when the agent is stuck in repetitive tool call patterns
 * (identical calls, ping-pong alternation) and injects warnings or
 * blocks to prevent infinite token waste.
 */
import { createHash } from "node:crypto";

export interface LoopGuardConfig {
  /** Warn after this many identical consecutive calls */
  identicalWarnThreshold: number;
  /** Hard-block after this many identical consecutive calls */
  identicalBlockThreshold: number;
  /** Warn on ping-pong alternation after this many rounds */
  pingPongWarnThreshold: number;
  /** Global circuit breaker: block after this many total no-progress repeats */
  globalCircuitBreaker: number;
  /** Tool+action patterns that are known no-progress when repeated */
  knownNoProgressPatterns: string[];
}

export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
  identicalWarnThreshold: 5,
  identicalBlockThreshold: 10,
  pingPongWarnThreshold: 10,
  globalCircuitBreaker: 30,
  knownNoProgressPatterns: [
    "process:poll",
    "process:log",
  ],
};

export type LoopAction = "allow" | "warn" | "block";

export interface LoopCheckResult {
  action: LoopAction;
  reason?: string;
}

function hashCall(name: string, args: unknown): string {
  const data = JSON.stringify({ name, args });
  return createHash("md5").update(data).digest("hex").slice(0, 12);
}

export class ToolLoopGuard {
  private history: string[] = [];
  private noProgressCount = 0;
  private config: LoopGuardConfig;

  constructor(config: Partial<LoopGuardConfig> = {}) {
    this.config = { ...DEFAULT_LOOP_GUARD_CONFIG, ...config };
  }

  check(toolName: string, args: unknown): LoopCheckResult {
    const hash = hashCall(toolName, args);
    this.history.push(hash);

    // Extract action for known no-progress pattern matching
    const argsObj = args as Record<string, unknown> | undefined;
    const actionKey = argsObj?.action
      ? `${toolName}:${argsObj.action}`
      : toolName;

    // Known no-progress patterns: block immediately on repeat
    if (this.config.knownNoProgressPatterns.includes(actionKey)) {
      const consecutive = this.countConsecutiveTail(hash);
      if (consecutive >= 3) {
        this.noProgressCount += consecutive;
        return {
          action: "block",
          reason: `Blocked: ${actionKey} repeated ${consecutive} times with no progress. Try a different approach.`,
        };
      }
    }

    // Identical consecutive calls
    const identicalRun = this.countConsecutiveTail(hash);
    if (identicalRun >= this.config.identicalBlockThreshold) {
      this.noProgressCount += identicalRun;
      return {
        action: "block",
        reason: `Blocked: ${toolName} called identically ${identicalRun} times. You appear stuck in a loop.`,
      };
    }
    if (identicalRun >= this.config.identicalWarnThreshold) {
      this.noProgressCount++;
      return {
        action: "warn",
        reason: `Warning: ${toolName} called identically ${identicalRun} times. Consider a different approach.`,
      };
    }

    // Ping-pong detection (A-B-A-B pattern)
    if (this.history.length >= 4) {
      const pingPongLen = this.detectPingPong();
      if (pingPongLen >= this.config.pingPongWarnThreshold) {
        this.noProgressCount += 2;
        return {
          action: "warn",
          reason: `Warning: Detected alternating tool call pattern (${pingPongLen} rounds). Break the cycle.`,
        };
      }
    }

    // Global circuit breaker
    if (this.noProgressCount >= this.config.globalCircuitBreaker) {
      return {
        action: "block",
        reason: `Circuit breaker: ${this.noProgressCount} no-progress tool calls detected. Stopping to prevent further waste.`,
      };
    }

    return { action: "allow" };
  }

  private countConsecutiveTail(hash: string): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] === hash) count++;
      else break;
    }
    return count;
  }

  private detectPingPong(): number {
    const h = this.history;
    if (h.length < 4) return 0;
    const a = h[h.length - 2];
    const b = h[h.length - 1];
    if (a === b) return 0;

    let rounds = 0;
    for (let i = h.length - 1; i >= 1; i -= 2) {
      if (h[i] === b && h[i - 1] === a) rounds++;
      else break;
    }
    return rounds;
  }

  reset(): void {
    this.history = [];
    this.noProgressCount = 0;
  }
}
