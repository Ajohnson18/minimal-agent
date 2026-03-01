-- GIN index for PostgreSQL full-text search on memory content
CREATE INDEX IF NOT EXISTS idx_ava_memory_content_fts
  ON ava_memory
  USING GIN (to_tsvector('english', content));
