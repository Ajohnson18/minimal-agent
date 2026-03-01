import type { HookInput, HookOutput, HookPhase } from "../core/hook-contracts.js";

export interface HookPluginRegistration<TPhase extends HookPhase = HookPhase> {
  plugin: string;
  phase: TPhase;
  priority?: number;
  run: (
    input: HookInput<TPhase>,
  ) => Promise<HookOutput<TPhase> | void> | HookOutput<TPhase> | void;
}

export interface HookPluginModule {
  name: string;
  hooks: HookPluginRegistration[];
}
