import type {
  HookInput,
  HookOutput,
  HookPhase,
} from "../core/hook-contracts.js";
import type { HookPhaseExecutionResult } from "./types.js";
import { hookRegistry } from "./registry.js";

export async function runHookPhase<TPhase extends HookPhase>(
  phase: TPhase,
  input: HookInput<TPhase>,
): Promise<HookPhaseExecutionResult<TPhase>> {
  return hookRegistry.runPhase(phase, input);
}

export async function runHookPhaseOutput<TPhase extends HookPhase>(
  phase: TPhase,
  input: HookInput<TPhase>,
): Promise<HookOutput<TPhase>> {
  const result = await runHookPhase(phase, input);
  return result.output;
}
