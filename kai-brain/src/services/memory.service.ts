/**
 * Memory Service
 *
 * Provides memory storage and hybrid search (vector + keyword).
 */
import { db } from '../db/client.js';
import { avaMemory } from '../db/schema/index.js';
import { eq, sql, and, ilike, or } from 'drizzle-orm';
import { generateEmbedding } from './embedding.service.js';
import { getConfig } from '../lib/config-loader.js';

export interface RetrievedMemory {
  id: string;
  content: string;
  importance: number;
  score: number; // Combined hybrid score
}

// --- Memory Security ---

/**
 * Patterns that suggest prompt injection in memory content.
 * Memories matching these are flagged and escaped when injected.
 */
const INJECTION_PATTERNS = [
  /you are now/i,
  /ignore (?:all )?(?:previous|prior|above) (?:instructions|prompts)/i,
  /system ?prompt/i,
  /\bact as\b/i,
  /\brole ?play\b/i,
  /new (?:instructions|rules|persona)/i,
  /forget (?:everything|all|your)/i,
  /override (?:your|the|all)/i,
  /\bdo not follow\b/i,
  /pretend (?:you are|to be)/i,
  /from now on/i,
];

/**
 * Check if content looks like a prompt injection attempt.
 */
function looksLikeInjection(content: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Sanitize memory content for safe injection into context.
 * Escapes content boundaries and flags suspicious entries.
 */
function sanitizeMemoryContent(content: string): string {
  // Strip null bytes and control characters (except newline, tab)
  let sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // If it looks like injection, wrap with warning
  if (looksLikeInjection(sanitized)) {
    sanitized = `[UNTRUSTED - possible injection] ${sanitized}`;
  }

  return sanitized;
}

interface VectorResult {
  id: string;
  content: string;
  importance: number;
  distance: number;
}

interface TextResult {
  id: string;
  content: string;
  importance: number;
}

/**
 * Hybrid search: combines vector similarity + keyword matching
 * Combines vector similarity + keyword matching with weighted score merging
 */
export async function searchMemories(
  userId: string,
  query: string,
  limit: number = getConfig().agent.memory.searchLimit,
  vectorWeight = 0.7,
  textWeight = 0.3
): Promise<RetrievedMemory[]> {
  // Early return if no memories exist for user
  const hasMemories = await checkUserHasMemories(userId);
  if (!hasMemories) {
    return [];
  }

  // Run both searches in parallel
  const [vectorResults, textResults] = await Promise.all([
    searchByVector(userId, query, limit * 2),
    searchByKeyword(userId, query, limit * 2),
  ]);

  // Merge and score results
  return mergeHybridResults(vectorResults, textResults, vectorWeight, textWeight, limit);
}

/**
 * Check if user has any memories (fast check)
 */
async function checkUserHasMemories(userId: string): Promise<boolean> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(avaMemory)
    .where(eq(avaMemory.userId, userId))
    .limit(1);

  return (result?.count ?? 0) > 0;
}

/**
 * Vector similarity search using pgvector
 */
async function searchByVector(
  userId: string,
  query: string,
  limit: number
): Promise<VectorResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const results = await db
      .select({
        id: avaMemory.id,
        content: avaMemory.content,
        importance: avaMemory.importance,
        distance: sql<number>`embedding <-> ${vectorStr}::vector`,
      })
      .from(avaMemory)
      .where(eq(avaMemory.userId, userId))
      .orderBy(sql`embedding <-> ${vectorStr}::vector`)
      .limit(limit);

    return results;
  } catch (error) {
    console.error('Vector search failed:', error);
    return [];
  }
}

/**
 * Full-text search using PostgreSQL tsvector/tsquery with ts_rank scoring.
 * Falls back to ILIKE keyword search if FTS returns no results (query expansion).
 */
async function searchByKeyword(
  userId: string,
  query: string,
  limit: number
): Promise<TextResult[]> {
  try {
    // Try FTS first
    const ftsResults = await searchByFTS(userId, query, limit);
    if (ftsResults.length > 0) return ftsResults;

    // FTS returned nothing — fall back to ILIKE for broader matching
    return await searchByILike(userId, query, limit);
  } catch (error) {
    console.error('Keyword search failed:', error);
    return [];
  }
}

async function searchByFTS(
  userId: string,
  query: string,
  limit: number
): Promise<TextResult[]> {
  try {
    const results = await db
      .select({
        id: avaMemory.id,
        content: avaMemory.content,
        importance: avaMemory.importance,
      })
      .from(avaMemory)
      .where(
        and(
          eq(avaMemory.userId, userId),
          sql`to_tsvector('english', ${avaMemory.content}) @@ plainto_tsquery('english', ${query})`,
        ),
      )
      .orderBy(sql`ts_rank(to_tsvector('english', ${avaMemory.content}), plainto_tsquery('english', ${query})) DESC`)
      .limit(limit);

    return results;
  } catch {
    return [];
  }
}

async function searchByILike(
  userId: string,
  query: string,
  limit: number
): Promise<TextResult[]> {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 2);

  if (keywords.length === 0) return [];

  const conditions = keywords.map((k) => ilike(avaMemory.content, `%${k}%`));

  return db
    .select({
      id: avaMemory.id,
      content: avaMemory.content,
      importance: avaMemory.importance,
    })
    .from(avaMemory)
    .where(and(eq(avaMemory.userId, userId), or(...conditions)))
    .limit(limit);
}

/**
 * Merge results with weighted scoring
 *
 * score = (vectorWeight × vectorScore) + (textWeight × textScore)
 */
function mergeHybridResults(
  vectorResults: VectorResult[],
  textResults: TextResult[],
  vectorWeight: number,
  textWeight: number,
  limit: number
): RetrievedMemory[] {
  const merged = new Map<
    string,
    {
      content: string;
      importance: number;
      vectorScore: number;
      textScore: number;
    }
  >();

  // Normalize vector distance to score (0-1, higher is better)
  // Distance 0 = identical, larger distance = less similar
  const maxDistance = Math.max(...vectorResults.map((r) => r.distance), 1);

  for (const r of vectorResults) {
    merged.set(r.id, {
      content: r.content,
      importance: r.importance,
      vectorScore: 1 - r.distance / maxDistance, // Convert distance to similarity
      textScore: 0,
    });
  }

  // Add text results (keyword match = score of 1)
  for (const r of textResults) {
    const existing = merged.get(r.id);
    if (existing) {
      existing.textScore = 1; // Keyword match boosts score
    } else {
      merged.set(r.id, {
        content: r.content,
        importance: r.importance,
        vectorScore: 0,
        textScore: 1,
      });
    }
  }

  // Calculate combined score, sanitize content, and sort
  return Array.from(merged.entries())
    .map(([id, data]) => ({
      id,
      content: sanitizeMemoryContent(data.content),
      importance: data.importance,
      score: vectorWeight * data.vectorScore + textWeight * data.textScore,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Store a new memory with embedding.
 * Auto-extracted memories (source='conversation') are screened for injection.
 */
export async function storeMemory(
  userId: string,
  content: string,
  source: 'conversation' | 'note' | 'fact',
  sourceId?: string,
  importance = 0.5
): Promise<string> {
  // Screen auto-extracted memories for injection attempts
  if (source === 'conversation' && looksLikeInjection(content)) {
    console.warn(`Blocked suspicious auto-extracted memory for user ${userId}: "${content.slice(0, 80)}..."`);
    return ''; // Return empty ID — caller handles gracefully
  }

  // Sanitize stored content (strip control chars)
  const sanitizedContent = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const embedding = await generateEmbedding(sanitizedContent);

  const [memory] = await db
    .insert(avaMemory)
    .values({
      userId,
      content: sanitizedContent,
      embedding,
      source,
      sourceId,
      importance,
    })
    .returning({ id: avaMemory.id });

  console.log(`Stored memory ${memory.id} for user ${userId}`);
  return memory.id;
}

/**
 * Update memory access timestamp (for tracking usage)
 */
export async function updateMemoryAccess(memoryId: string): Promise<void> {
  await db
    .update(avaMemory)
    .set({ accessedAt: new Date() })
    .where(eq(avaMemory.id, memoryId));
}

/**
 * Delete a memory
 */
export async function deleteMemory(memoryId: string): Promise<void> {
  await db.delete(avaMemory).where(eq(avaMemory.id, memoryId));
}

/**
 * Get all memories for a user (for debugging/management)
 */
export async function getUserMemories(
  userId: string,
  limit = 100
): Promise<Array<{ id: string; content: string; importance: number; source: string; createdAt: Date }>> {
  return db
    .select({
      id: avaMemory.id,
      content: avaMemory.content,
      importance: avaMemory.importance,
      source: avaMemory.source,
      createdAt: avaMemory.createdAt,
    })
    .from(avaMemory)
    .where(eq(avaMemory.userId, userId))
    .orderBy(sql`created_at DESC`)
    .limit(limit);
}
