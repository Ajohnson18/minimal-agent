import type { HeartbeatWakeReasonKind } from './heartbeat-reason.js';
import type { DeliveryTarget } from '../agent/delivery.js';

export type HookPhase =
  | 'before_model_resolve'
  | 'subagent_spawning'
  | 'subagent_delivery_target'
  | 'subagent_spawned'
  | 'subagent_ended'
  | 'before_delivery'
  | 'heartbeat_reason_classify';

export type HookFailurePolicy = 'fail-open' | 'fail-closed';

export const HOOK_FAILURE_POLICY: Record<HookPhase, HookFailurePolicy> = {
  before_model_resolve: 'fail-open',
  subagent_spawning: 'fail-open',
  subagent_delivery_target: 'fail-closed',
  subagent_spawned: 'fail-open',
  subagent_ended: 'fail-open',
  before_delivery: 'fail-closed',
  heartbeat_reason_classify: 'fail-open',
};

export interface HookBeforeModelResolveInput {
  provider: string;
  modelId: string;
  prompt: string;
}

export interface HookBeforeModelResolveOutput {
  provider?: string;
  modelId?: string;
}

export interface HookSubagentSpawningInput {
  parentSessionId: string;
  parentSessionKey?: string;
  childSessionId: string;
  childSessionKey?: string;
  mode: 'run' | 'session';
}

export interface HookSubagentSpawningOutput {
  deliverySessionKey?: string;
  suppressCompletion?: boolean;
}

export interface HookSubagentDeliveryTargetInput {
  parentSessionId: string;
  parentSessionKey?: string;
  childSessionId: string;
  childSessionKey?: string;
  preferredTarget?: DeliveryTarget | null;
}

export interface HookSubagentDeliveryTargetOutput {
  target?: DeliveryTarget | null;
}

export interface HookBeforeDeliveryInput {
  sessionId: string;
  sessionKey?: string;
  content: string;
  target: DeliveryTarget;
}

export interface HookBeforeDeliveryOutput {
  target?: DeliveryTarget;
  content?: string;
  suppress?: boolean;
  reason?: string;
}

export interface HookHeartbeatReasonClassifyInput {
  rawReason: string;
  defaultKind: HeartbeatWakeReasonKind;
}

export interface HookHeartbeatReasonClassifyOutput {
  kind?: HeartbeatWakeReasonKind;
}

export interface HookContractMap {
  before_model_resolve: {
    input: HookBeforeModelResolveInput;
    output: HookBeforeModelResolveOutput;
  };
  subagent_spawning: {
    input: HookSubagentSpawningInput;
    output: HookSubagentSpawningOutput;
  };
  subagent_delivery_target: {
    input: HookSubagentDeliveryTargetInput;
    output: HookSubagentDeliveryTargetOutput;
  };
  subagent_spawned: {
    input: HookSubagentSpawningInput;
    output: Record<string, never>;
  };
  subagent_ended: {
    input: HookSubagentSpawningInput & { outcome: string };
    output: Record<string, never>;
  };
  before_delivery: {
    input: HookBeforeDeliveryInput;
    output: HookBeforeDeliveryOutput;
  };
  heartbeat_reason_classify: {
    input: HookHeartbeatReasonClassifyInput;
    output: HookHeartbeatReasonClassifyOutput;
  };
}

export type HookInput<TPhase extends HookPhase> = HookContractMap[TPhase]['input'];
export type HookOutput<TPhase extends HookPhase> = HookContractMap[TPhase]['output'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mergeLists(left: unknown, right: unknown): unknown {
  if (!Array.isArray(left) && !Array.isArray(right)) return undefined;
  const out: unknown[] = [];
  const seen = new Set<string>();

  const push = (entry: unknown) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  if (Array.isArray(left)) {
    for (const entry of left) push(entry);
  }
  if (Array.isArray(right)) {
    for (const entry of right) push(entry);
  }

  return out;
}

/**
 * Deterministic merge: first non-undefined scalar wins (higher-priority result first),
 * arrays are merged as deterministic set unions.
 */
export function mergeHookOutputs<T extends Record<string, unknown>>(
  current: T | undefined,
  next: T,
): T {
  if (!current) return { ...next };

  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;

    const existing = merged[key];
    const mergedList = mergeLists(existing, value);
    if (mergedList !== undefined) {
      merged[key] = mergedList;
      continue;
    }

    if (existing === undefined) {
      merged[key] = value;
      continue;
    }

    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeHookOutputs(existing, value);
    }
  }

  return merged as T;
}
