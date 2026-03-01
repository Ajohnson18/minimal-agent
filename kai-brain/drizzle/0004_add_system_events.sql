-- System events table for deduplicating notifications
CREATE TABLE IF NOT EXISTS ava_system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL,
  type VARCHAR(100) NOT NULL,
  text TEXT NOT NULL,
  context_key VARCHAR(500),
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_system_events_session_id ON ava_system_events(session_id);
CREATE INDEX IF NOT EXISTS idx_system_events_context_key ON ava_system_events(context_key);
CREATE INDEX IF NOT EXISTS idx_system_events_processed ON ava_system_events(processed);
CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON ava_system_events(created_at);
CREATE INDEX IF NOT EXISTS idx_system_events_type ON ava_system_events(type);
