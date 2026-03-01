-- Add context_summary column for compacted message summaries
ALTER TABLE "ava_sessions" ADD COLUMN IF NOT EXISTS "context_summary" text;

-- Add unique constraint on external_id for ava_sessions
-- This prevents duplicate sessions for the same Slack thread or other external source
-- Note: NULL values are allowed (multiple rows can have NULL external_id)
ALTER TABLE "ava_sessions" ADD CONSTRAINT "ava_sessions_external_id_unique" UNIQUE ("external_id");
