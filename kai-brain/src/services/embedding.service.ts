/**
 * Embedding Service
 *
 * Generates embeddings with caching support.
 */
import { db } from '../db/client.js';
import { avaEmbeddingCache } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'crypto';
import { env } from '../config/env.js';
import { getConfig } from '../lib/config-loader.js';
import { buildVertexUrl } from '../agent/pi-provider.js';

export type EmbeddingProvider = 'vertex' | 'openai' | 'gemini';

/**
 * Hash content for cache lookup using SHA-256
 */
function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Check cache for existing embedding
 */
async function getCachedEmbedding(
  hash: string,
  provider: EmbeddingProvider,
  model: string
): Promise<number[] | null> {
  try {
    const [cached] = await db
      .select({ embedding: avaEmbeddingCache.embedding })
      .from(avaEmbeddingCache)
      .where(
        and(
          eq(avaEmbeddingCache.contentHash, hash),
          eq(avaEmbeddingCache.provider, provider),
          eq(avaEmbeddingCache.model, model)
        )
      )
      .limit(1);

    return cached?.embedding ?? null;
  } catch (error) {
    console.error('Failed to check embedding cache:', error);
    return null;
  }
}

/**
 * Cache embedding after generation
 */
async function cacheEmbedding(
  hash: string,
  provider: EmbeddingProvider,
  model: string,
  embedding: number[]
): Promise<void> {
  try {
    await db
      .insert(avaEmbeddingCache)
      .values({
        contentHash: hash,
        provider,
        model,
        embedding,
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error('Failed to cache embedding:', error);
    // Non-fatal - continue without caching
  }
}

/**
 * Generate embedding for text with caching
 */
export async function generateEmbedding(
  text: string,
  provider: EmbeddingProvider = 'vertex'
): Promise<number[]> {
  const model = getConfig().agent.model.embedding;
  const hash = hashContent(text);

  // Check cache first
  const cached = await getCachedEmbedding(hash, provider, model);
  if (cached) {
    console.log(`Embedding cache hit for hash ${hash.slice(0, 8)}...`);
    return cached;
  }

  // Generate new embedding
  console.log(`Generating embedding for hash ${hash.slice(0, 8)}... (provider: ${provider})`);
  const embedding = await generateEmbeddingFromProvider(text, provider, model);

  // Cache it
  await cacheEmbedding(hash, provider, model, embedding);

  return embedding;
}

/**
 * Generate embedding from the specified provider
 */
async function generateEmbeddingFromProvider(
  text: string,
  provider: EmbeddingProvider,
  model: string
): Promise<number[]> {
  switch (provider) {
    case 'vertex':
      return generateVertexEmbedding(text, model);
    case 'openai':
      return generateOpenAIEmbedding(text);
    case 'gemini':
      return generateGeminiEmbedding(text, model);
    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
}

/**
 * Generate embedding using Vertex AI
 * Uses the REST API directly to avoid additional dependencies
 */
async function generateVertexEmbedding(text: string, model: string): Promise<number[]> {
  const projectId = env.VERTEX_AI_PROJECT_ID;
  if (!projectId) {
    throw new Error("VERTEX_AI_PROJECT_ID is required for Vertex embeddings");
  }
  const location = getConfig().vertex.location;

  // Get access token from Google Auth
  const accessToken = await getGoogleAccessToken();

  const url = buildVertexUrl(projectId, location, model, "predict");

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ content: text }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI embedding failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };
  const embedding = data.predictions?.[0]?.embeddings?.values;

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Invalid embedding response from Vertex AI');
  }

  return embedding;
}

/**
 * Get Google Cloud access token
 * Uses Application Default Credentials
 */
async function getGoogleAccessToken(): Promise<string> {
  // Try to get token from metadata service (GCP) or local credentials
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();

  if (!tokenResponse.token) {
    throw new Error('Failed to get Google access token');
  }

  return tokenResponse.token;
}

/**
 * Generate embedding using OpenAI
 * Placeholder for future implementation
 */
async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = data.data?.[0]?.embedding;

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Invalid embedding response from OpenAI');
  }

  return embedding;
}

/**
 * Generate embedding using Gemini
 * Placeholder for future implementation
 */
async function generateGeminiEmbedding(text: string, model: string): Promise<number[]> {
  // Use Vertex AI with Gemini embedding model
  return generateVertexEmbedding(text, model);
}

/**
 * Batch generate embeddings (with caching)
 */
export async function generateEmbeddings(
  texts: string[],
  provider: EmbeddingProvider = 'vertex'
): Promise<number[][]> {
  // Process in parallel, cache will prevent redundant API calls
  return Promise.all(texts.map((text) => generateEmbedding(text, provider)));
}
