import { db } from "../db/client.js";
import { avaHookExecutions } from "../db/schema/hook-executions.js";
import { createLogger } from "../lib/logger.js";
import {
  HOOK_FAILURE_POLICY,
  mergeHookOutputs,
  type HookInput,
  type HookOutput,
  type HookPhase,
} from "../core/hook-contracts.js";
import { getHookPlugins } from "../plugins/hooks.js";
import type { HookPluginRegistration } from "../plugins/types.js";
import type { HookPhaseExecutionResult, RegisteredHook } from "./types.js";

const log = createLogger("hooks");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value as number);
}

function inferSessionId(input: Record<string, unknown>): string | undefined {
  const candidates = [
    input["sessionId"],
    input["parentSessionId"],
    input["childSessionId"],
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function inferSessionKey(input: Record<string, unknown>): string | undefined {
  const candidates = [
    input["sessionKey"],
    input["parentSessionKey"],
    input["childSessionKey"],
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function inferRunId(input: Record<string, unknown>): string | undefined {
  const raw = input["runId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

class HookRegistry {
  private hooksByPhase = new Map<HookPhase, RegisteredHook[]>();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const discovered = getHookPlugins();
    for (const plugin of discovered) {
      this.register(plugin);
    }

    this.initialized = true;
    const count = Array.from(this.hooksByPhase.values()).reduce(
      (sum, hooks) => sum + hooks.length,
      0,
    );
    log.info({ count }, "Typed hook registry initialized");
  }

  register<TPhase extends HookPhase>(
    registration: HookPluginRegistration<TPhase>,
  ): void {
    const phaseHooks = this.hooksByPhase.get(registration.phase) ?? [];
    phaseHooks.push({
      plugin: registration.plugin,
      phase: registration.phase,
      priority: normalizePriority(registration.priority),
      run: registration.run,
    });
    phaseHooks.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.plugin.localeCompare(b.plugin);
    });
    this.hooksByPhase.set(registration.phase, phaseHooks);
  }

  async runPhase<TPhase extends HookPhase>(
    phase: TPhase,
    input: HookInput<TPhase>,
  ): Promise<HookPhaseExecutionResult<TPhase>> {
    await this.initialize();

    const hooks = this.hooksByPhase.get(phase) ?? [];
    if (hooks.length === 0) {
      return {
        output: {} as HookOutput<TPhase>,
        executed: 0,
      };
    }

    let merged: HookOutput<TPhase> | undefined;
    let executed = 0;

    for (const registeredHook of hooks) {
      const hook = registeredHook as unknown as RegisteredHook<TPhase>;
      const startedAt = Date.now();
      try {
        const output = await hook.run(input);
        executed += 1;

        if (output && isObject(output)) {
          merged = mergeHookOutputs(
            (merged as Record<string, unknown> | undefined) ?? undefined,
            output as unknown as Record<string, unknown>,
          ) as HookOutput<TPhase>;
        }

        await this.recordExecution({
          phase,
          hook: registeredHook,
          input,
          latencyMs: Date.now() - startedAt,
          outcome: "ok",
          metadata: {
            hasOutput: Boolean(output && isObject(output)),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordExecution({
          phase,
          hook: registeredHook,
          input,
          latencyMs: Date.now() - startedAt,
          outcome: "error",
          error: message,
        });

        const failurePolicy = HOOK_FAILURE_POLICY[phase];
        if (failurePolicy === "fail-closed") {
          throw error instanceof Error ? error : new Error(message);
        }

        log.warn(
          {
            phase,
            plugin: registeredHook.plugin,
            error: message,
          },
          "Hook failed in fail-open phase",
        );
      }
    }

    return {
      output: (merged ?? ({} as HookOutput<TPhase>)) as HookOutput<TPhase>,
      executed,
    };
  }

  getHooksForPhase(phase: HookPhase): RegisteredHook[] {
    return [...(this.hooksByPhase.get(phase) ?? [])];
  }

  resetForTests(): void {
    this.hooksByPhase.clear();
    this.initialized = false;
  }

  private async recordExecution(params: {
    phase: HookPhase;
    hook: RegisteredHook;
    input: unknown;
    latencyMs: number;
    outcome: "ok" | "error";
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const normalizedInput = isObject(params.input) ? params.input : {};
    const sessionId = inferSessionId(normalizedInput);
    const sessionKey = inferSessionKey(normalizedInput);
    const runId = inferRunId(normalizedInput);

    try {
      await db.insert(avaHookExecutions).values({
        phase: params.phase,
        plugin: params.hook.plugin,
        priority: params.hook.priority,
        outcome: params.outcome,
        latencyMs: Math.max(0, Math.floor(params.latencyMs)),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(params.error ? { error: params.error } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
    } catch (error) {
      log.warn(
        {
          err: error,
          phase: params.phase,
          plugin: params.hook.plugin,
        },
        "Failed to persist hook execution audit row",
      );
    }
  }
}

export const hookRegistry = new HookRegistry();
