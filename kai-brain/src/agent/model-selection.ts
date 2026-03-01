import { getConfig } from "../lib/config-loader.js";
import { runHookPhaseOutput } from "../hooks/index.js";
import {
  getDefaultModelId,
  getDefaultProvider,
  type Provider,
} from "./pi-provider.js";

export interface ModelReference {
  provider: Provider;
  modelId: string;
  source?: string;
}

export interface ResolveModelSelectionInput {
  prompt: string;
  provider?: Provider;
  modelId?: string;
}

export interface ResolvedModelSelection {
  primary: ModelReference;
  configuredFallback?: ModelReference;
}

const VALID_PROVIDERS: Provider[] = [
  "vertex",
  "openai",
  "anthropic",
  "google",
  "openrouter",
];

function normalizeProvider(value: string | undefined): Provider {
  if (!value) return getDefaultProvider();
  const normalized = value.trim().toLowerCase();
  if (VALID_PROVIDERS.includes(normalized as Provider)) {
    return normalized as Provider;
  }
  return getDefaultProvider();
}

function normalizeModelId(value: string | undefined, provider: Provider): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed) return trimmed;
  if (provider === getDefaultProvider()) {
    return getDefaultModelId();
  }

  const config = getConfig();
  const configuredPrimary = config.agent.model.primary?.trim();
  if (configuredPrimary) return configuredPrimary;
  return getDefaultModelId();
}

function parseModelReference(
  raw: string | undefined,
  defaultProvider: Provider,
  source: string,
): ModelReference | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(":");
  if (parts.length >= 2 && VALID_PROVIDERS.includes(parts[0] as Provider)) {
    const provider = normalizeProvider(parts[0]);
    const modelId = parts.slice(1).join(":").trim();
    if (!modelId) return undefined;
    return { provider, modelId, source };
  }

  return {
    provider: defaultProvider,
    modelId: trimmed,
    source,
  };
}

function parseAllowlist(): Set<string> {
  const raw = process.env.AVA_MODEL_ALLOWLIST;
  if (!raw) return new Set<string>();
  const set = new Set<string>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed) set.add(trimmed);
  }
  return set;
}

function isAllowed(reference: ModelReference, allowlist: Set<string>): boolean {
  if (allowlist.size === 0) return true;
  return (
    allowlist.has(reference.modelId) ||
    allowlist.has(`${reference.provider}:${reference.modelId}`)
  );
}

export async function resolveModelSelection(
  input: ResolveModelSelectionInput,
): Promise<ResolvedModelSelection> {
  let provider = normalizeProvider(input.provider);
  let modelId = normalizeModelId(input.modelId, provider);

  const hookOutput = await runHookPhaseOutput("before_model_resolve", {
    provider,
    modelId,
    prompt: input.prompt,
  });
  if (hookOutput.provider) {
    provider = normalizeProvider(hookOutput.provider);
  }
  if (hookOutput.modelId) {
    modelId = hookOutput.modelId.trim() || modelId;
  }

  const allowlist = parseAllowlist();
  let primary: ModelReference = { provider, modelId, source: "primary" };

  if (!isAllowed(primary, allowlist)) {
    const firstAllowed = Array.from(allowlist)[0];
    const fallback =
      parseModelReference(firstAllowed, getDefaultProvider(), "allowlist") ??
      parseModelReference(getConfig().agent.model.fallback, provider, "config-fallback");
    if (fallback) {
      primary = fallback;
    }
  }

  const configuredFallback = parseModelReference(
    getConfig().agent.model.fallback,
    primary.provider,
    "config-fallback",
  );

  return {
    primary,
    ...(configuredFallback ? { configuredFallback } : {}),
  };
}
