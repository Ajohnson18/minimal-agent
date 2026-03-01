import type { Provider } from "./pi-provider.js";
import type { ModelReference } from "./model-selection.js";

const PROVIDER_DEFAULT_MODELS: Record<Provider, string> = {
  vertex: "claude-sonnet-4-5@20250929",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-pro",
  openrouter: "openrouter/auto",
};

function keyOf(reference: ModelReference): string {
  return `${reference.provider}:${reference.modelId}`;
}

function dedupeReferences(references: ModelReference[]): ModelReference[] {
  const seen = new Set<string>();
  const result: ModelReference[] = [];

  for (const reference of references) {
    const key = keyOf(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }

  return result;
}

export function buildAggressiveFailoverCandidates(params: {
  primary: ModelReference;
  configuredFallback?: ModelReference;
  attempted?: string[];
}): ModelReference[] {
  const attempted = new Set(
    (params.attempted ?? []).map((value) => value.trim()).filter(Boolean),
  );
  attempted.add(keyOf(params.primary));

  const candidates: ModelReference[] = [];
  if (params.configuredFallback) {
    candidates.push({
      ...params.configuredFallback,
      source: params.configuredFallback.source ?? "config-fallback",
    });
  }

  // Same-provider default before cross-provider fanout.
  const providerDefault = PROVIDER_DEFAULT_MODELS[params.primary.provider];
  if (providerDefault) {
    candidates.push({
      provider: params.primary.provider,
      modelId: providerDefault,
      source: "same-provider-default",
    });
  }

  for (const [provider, modelId] of Object.entries(PROVIDER_DEFAULT_MODELS) as Array<
    [Provider, string]
  >) {
    candidates.push({
      provider,
      modelId,
      source: "cross-provider-default",
    });
  }

  return dedupeReferences(candidates).filter((candidate) => {
    return !attempted.has(keyOf(candidate));
  });
}

export function modelReferenceKey(reference: ModelReference): string {
  return keyOf(reference);
}
