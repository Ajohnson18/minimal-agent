import type { HookInput, HookOutput, HookPhase } from "../core/hook-contracts.js";

export interface RegisteredHook<TPhase extends HookPhase = HookPhase> {
  plugin: string;
  phase: TPhase;
  priority: number;
  run: (
    input: HookInput<TPhase>,
  ) => Promise<HookOutput<TPhase> | void> | HookOutput<TPhase> | void;
}

export interface HookPhaseExecutionResult<TPhase extends HookPhase = HookPhase> {
  output: HookOutput<TPhase>;
  executed: number;
}
