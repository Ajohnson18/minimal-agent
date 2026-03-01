-- Add embedding cache table for caching embeddings by content hash
-- This reduces redundant API calls and speeds up memory operations

CREATE TABLE IF NOT EXISTS "ava_embedding_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "provider" varchar(50) NOT NULL,
  "model" varchar(100) NOT NULL,
  "embedding" vector(768) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Composite index for fast cache lookups
CREATE INDEX IF NOT EXISTS "idx_embedding_cache_lookup"
  ON "ava_embedding_cache" ("content_hash", "provider", "model");
