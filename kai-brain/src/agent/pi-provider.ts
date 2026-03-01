/**
 * Pi-AI Provider Setup
 *
 * This module provides the interface to pi-ai models.
 * Uses getModel() from @mariozechner/pi-ai for model retrieval.
 * Claude models on Vertex AI are routed through @isaacraja/pi-vertex-claude.
 */
import {
  getModel,
  getProviders,
  getModels,
  registerApiProvider,
  type Model,
  type Api,
} from "@mariozechner/pi-ai";
import {
  streamGoogleVertex,
  streamSimpleGoogleVertex,
} from "@mariozechner/pi-ai/dist/providers/google-vertex.js";
import { streamVertexClaude } from "@isaacraja/pi-vertex-claude";
import { env } from "../config/env.js";
import { getConfig } from "../lib/config-loader.js";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Register the Vertex Claude API provider (once at import time)
registerApiProvider({
  api: "vertex-claude-api" as Api,
  stream: streamVertexClaude as any,
  streamSimple: streamVertexClaude as any,
});

// Register custom Vertex Gemini 3.x API provider with global location
registerApiProvider({
  api: "vertex-gemini3-api" as Api,
  stream: (model: any, context: any, options?: any) =>
    streamGoogleVertex(model, context, { ...options, location: "global" }) as any,
  streamSimple: (model: any, context: any, options?: any) =>
    streamSimpleGoogleVertex(model, context, { ...options, location: "global" }) as any,
});

export type Provider =
  | "vertex"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter";

// Default models per provider
const DEFAULT_MODELS: Record<Provider, string> = {
  vertex: "claude-sonnet-4-5@20250929",
  google: "gemini-2.5-pro",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  openrouter: "openrouter/auto",
};

// Per-model configuration: context window + default thinking level
interface ModelConfig {
  contextWindow: number;
  thinkingDefault?: string;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // Gemini 3.x models (global endpoint only)
  "gemini-3-flash-preview": { contextWindow: 1_048_576, thinkingDefault: "low" },
  "gemini-3-pro-preview": { contextWindow: 1_048_576, thinkingDefault: "medium" },
  "gemini-3.1-pro-preview": { contextWindow: 1_048_576, thinkingDefault: "medium" },
  // Gemini 2.x models
  "gemini-2.5-pro": { contextWindow: 1_000_000, thinkingDefault: "medium" },
  "gemini-2.5-flash": { contextWindow: 1_000_000, thinkingDefault: "low" },
  "gemini-2.0-flash": { contextWindow: 1_000_000 },
  "gemini-2.0-flash-thinking": { contextWindow: 1_000_000, thinkingDefault: "medium" },
  "gemini-1.5-pro": { contextWindow: 2_000_000 },
  "gemini-1.5-flash": { contextWindow: 1_000_000 },
  // OpenAI models
  "gpt-4o": { contextWindow: 128_000 },
  "gpt-4o-mini": { contextWindow: 128_000 },
  "gpt-4-turbo": { contextWindow: 128_000 },
  o1: { contextWindow: 200_000, thinkingDefault: "medium" },
  "o1-mini": { contextWindow: 128_000, thinkingDefault: "low" },
  // Anthropic models (Vertex + direct)
  "claude-sonnet-4-6": { contextWindow: 1_000_000, thinkingDefault: "low" },
  "claude-opus-4-6": { contextWindow: 200_000, thinkingDefault: "medium" },
  "claude-sonnet-4-5@20250929": { contextWindow: 200_000, thinkingDefault: "low" },
  "claude-haiku-4-5@20251001": { contextWindow: 200_000 },
  "claude-sonnet-4-20250514": { contextWindow: 200_000, thinkingDefault: "low" },
  "claude-3-5-sonnet-20241022": { contextWindow: 200_000 },
  "claude-3-opus-20240229": { contextWindow: 200_000 },
  "claude-3-5-haiku-20241022": { contextWindow: 200_000 },
};

// Flag to track if credentials have been initialized
let credentialsInitialized = false;

/**
 * Initialize Vertex AI credentials from environment.
 * Writes service account JSON to a temp file and sets required env vars.
 */
function initializeVertexCredentials(): void {
  if (credentialsInitialized) return;

  // Check if we have inline service account key
  if (env.VERTEX_AI_SERVICE_ACCOUNT_KEY) {
    try {
      // Create credentials directory
      const credDir = join(tmpdir(), "ava-agent-creds");
      if (!existsSync(credDir)) {
        mkdirSync(credDir, { recursive: true, mode: 0o700 });
      }

      // Write credentials to file
      const credPath = join(credDir, "vertex-sa.json");
      writeFileSync(credPath, env.VERTEX_AI_SERVICE_ACCOUNT_KEY, {
        mode: 0o600,
      });

      // Set environment variables for pi-ai
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
      console.log(`Vertex AI credentials written to ${credPath}`);
    } catch (error) {
      console.error("Failed to write Vertex AI credentials:", error);
    }
  }

  // Set project and location if available
  if (env.VERTEX_AI_PROJECT_ID) {
    process.env.GOOGLE_CLOUD_PROJECT = env.VERTEX_AI_PROJECT_ID;
    process.env.GCLOUD_PROJECT = env.VERTEX_AI_PROJECT_ID;
  }

  // Set location to regional by default for Gemini 2.x models
  // Gemini 3.x models override this by building a custom Model object with global baseUrl
  const vertexLocation = getConfig().vertex.location;
  if (vertexLocation) {
    process.env.GOOGLE_CLOUD_LOCATION = vertexLocation;
  }

  credentialsInitialized = true;
}

/**
 * Check if a model ID is an Anthropic/Claude model.
 */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("claude-");
}

/**
 * Check if a model requires the global endpoint (Gemini 3.x models).
 */
export function isGlobalOnlyModel(modelId: string): boolean {
  return modelId.startsWith("gemini-3");
}

/**
 * Build Vertex AI URL for a model, using global endpoint for Gemini 3.x models.
 */
export function buildVertexUrl(
  projectId: string,
  location: string,
  model: string,
  method: string,
): string {
  if (isGlobalOnlyModel(model)) {
    return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:${method}`;
  }
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}`;
}

/**
 * Build a Model object for Claude on Vertex AI.
 * Uses the vertex-claude-api provider registered above.
 */
function getClaudeCost(modelId: string): Model<Api>["cost"] {
  if (modelId.includes("haiku")) {
    return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  }
  if (modelId.includes("sonnet")) {
    return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  }
  // Opus
  return { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
}

function buildVertexClaudeModel(modelId: string): Model<Api> {
  const region = getConfig().vertex.anthropicLocation;
  return {
    id: modelId,
    name: `Claude (Vertex ${region})`,
    api: "vertex-claude-api" as Api,
    provider: "google-vertex-claude",
    baseUrl: `https://${region}-aiplatform.googleapis.com`,
    reasoning: true,
    input: ["text", "image"],
    cost: getClaudeCost(modelId),
    contextWindow: MODEL_CONFIGS[modelId]?.contextWindow || 200_000,
    maxTokens: modelId.includes("3-5-sonnet") || modelId.includes("3-5-haiku") ? 8_192 : 64_000,
  };
}

/**
 * Build a Model object for Gemini 3.x on Vertex AI (global endpoint only).
 * These models require the global endpoint and can't use regional endpoints.
 * 
 * Uses the custom vertex-gemini3-api provider which injects location: "global"
 * into stream options. Thread-safe - no env var mutation.
 */
function buildVertexGemini3Model(modelId: string): Model<Api> {
  const config = MODEL_CONFIGS[modelId];
  return {
    id: modelId,
    name: modelId,
    api: "vertex-gemini3-api" as Api,
    provider: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: true,
    input: ["text", "image", "audio", "video", "pdf"] as any,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config?.contextWindow ?? 1_048_576,
    maxTokens: 65_536,
  };
}

/**
 * Get a model from pi-ai by provider and model ID.
 * Throws if the model is not found.
 *
 * For Vertex AI, Anthropic models are routed through the vertex-claude-api provider.
 * Gemini models use the standard google-vertex provider.
 */
export function getPiModel(provider: Provider, modelId?: string): Model<any> {
  const effectiveModelId = modelId || DEFAULT_MODELS[provider];

  if (provider === "vertex") {
    initializeVertexCredentials();

    if (isAnthropicModel(effectiveModelId)) {
      // Route Claude models through the Vertex Claude provider
      const region = getConfig().vertex.anthropicLocation;
      console.log(`[MODEL] Routing ${effectiveModelId} → ${region} (Vertex Claude)`);
      return buildVertexClaudeModel(effectiveModelId);
    }

    // Gemini 3.x models require global endpoint
    if (isGlobalOnlyModel(effectiveModelId)) {
      console.log(`[MODEL] Routing ${effectiveModelId} → global (Gemini 3.x)`);
      return buildVertexGemini3Model(effectiveModelId);
    }

    const region = getConfig().vertex.location;
    console.log(`[MODEL] Routing ${effectiveModelId} → ${region} (Gemini)`);
    try {
      return getModel("google-vertex" as any, effectiveModelId as any);
    } catch (error) {
      throw new Error(`Model not found: google-vertex/${effectiveModelId}. Error: ${error}`);
    }
  }

  // Non-vertex providers
  const effectiveProvider = provider === "google" ? "google" : provider;
  try {
    return getModel(effectiveProvider as any, effectiveModelId as any);
  } catch (error) {
    throw new Error(`Model not found: ${effectiveProvider}/${effectiveModelId}. Error: ${error}`);
  }
}

/**
 * Get the context window size for a model.
 * Returns a conservative default if the model is not in our known list.
 */
export function getModelContextWindow(
  provider: Provider,
  modelId?: string,
): number {
  const effectiveModelId = modelId || DEFAULT_MODELS[provider];

  if (MODEL_CONFIGS[effectiveModelId]) {
    return MODEL_CONFIGS[effectiveModelId].contextWindow;
  }

  // Default based on provider
  switch (provider) {
    case "vertex":
    case "google":
      return 1_000_000; // Gemini default
    case "anthropic":
      return 200_000; // Claude default
    case "openai":
      return 128_000; // GPT-4 default
    default:
      return 100_000; // Conservative default
  }
}

/**
 * Get the default thinking level for a model.
 * Returns undefined if no default is configured (meaning "off").
 */
export function getModelThinkingDefault(
  provider: Provider,
  modelId?: string,
): string | undefined {
  const effectiveModelId = modelId || DEFAULT_MODELS[provider];
  return MODEL_CONFIGS[effectiveModelId]?.thinkingDefault;
}

/**
 * Get the default provider from environment.
 */
export function getDefaultProvider(): Provider {
  return (getConfig().agent.model.provider || "vertex") as Provider;
}

export function getDefaultModelId(): string {
  const cfg = getConfig();
  return cfg.agent.model.primary || DEFAULT_MODELS[getDefaultProvider()];
}

/**
 * List available providers.
 */
export function listProviders(): string[] {
  return getProviders();
}

/**
 * List available models for a provider.
 */
export function listModels(provider: Provider): Model<any>[] {
  let effectiveProvider: string;
  if (provider === "vertex") {
    effectiveProvider = "google-vertex";
  } else {
    effectiveProvider = provider;
  }
  return getModels(effectiveProvider as any);
}

// Re-export streaming functions from pi-ai
export {
  streamSimple,
  completeSimple,
  stream,
  complete,
} from "@mariozechner/pi-ai";
