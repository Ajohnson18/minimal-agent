import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// Custom type for pgvector (same as memory.ts)
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value.replace(/^\[/, '[').replace(/\]$/, ']'));
  },
});

/**
 * Embedding Cache Table
 *
 * Caches embeddings by content hash to avoid redundant API calls.
 */
export const avaEmbeddingCache = pgTable(
  'ava_embedding_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // SHA-256 hash of the content
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    // Provider used: 'vertex', 'openai', 'gemini'
    provider: varchar('provider', { length: 50 }).notNull(),
    // Model used for embedding
    model: varchar('model', { length: 100 }).notNull(),
    // The embedding vector
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Composite index for fast cache lookups
    index('idx_embedding_cache_lookup').on(table.contentHash, table.provider, table.model),
  ]
);

export type AvaEmbeddingCache = typeof avaEmbeddingCache.$inferSelect;
export type NewAvaEmbeddingCache = typeof avaEmbeddingCache.$inferInsert;
