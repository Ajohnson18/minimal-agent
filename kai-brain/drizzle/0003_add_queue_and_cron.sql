-- Queue table for background task processing
CREATE TABLE IF NOT EXISTS ava_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ava_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  
  -- Message content
  message TEXT NOT NULL,
  
  -- Queue management
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, error, cancelled
  priority INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  
  -- Queue mode context
  mode TEXT NOT NULL DEFAULT 'followup', -- steer, followup, collect, interrupt
  batch_id TEXT,
  
  -- Source tracking
  source TEXT NOT NULL DEFAULT 'api',
  source_metadata JSONB,
  
  -- Result
  result TEXT,
  error TEXT,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- Cron jobs table for scheduled tasks
CREATE TABLE IF NOT EXISTS ava_cron_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ava_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  
  -- Job identity
  name TEXT NOT NULL,
  description TEXT,
  
  -- Schedule configuration
  schedule_kind TEXT NOT NULL, -- 'at' | 'every' | 'cron'
  schedule_value TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  
  -- Payload
  payload TEXT NOT NULL,
  
  -- State
  enabled BOOLEAN NOT NULL DEFAULT true,
  delete_after_run BOOLEAN NOT NULL DEFAULT false,
  
  -- Execution tracking
  last_run_at TIMESTAMP,
  last_run_status TEXT,
  last_run_error TEXT,
  next_run_at TIMESTAMP,
  run_count TEXT DEFAULT '0',
  
  -- Source tracking
  source TEXT NOT NULL DEFAULT 'agent',
  source_metadata JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for queue
CREATE INDEX IF NOT EXISTS idx_ava_queue_session_status ON ava_queue(session_id, status);
CREATE INDEX IF NOT EXISTS idx_ava_queue_status_priority ON ava_queue(status, priority DESC, created_at);

-- Indexes for cron
CREATE INDEX IF NOT EXISTS idx_ava_cron_jobs_session ON ava_cron_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_ava_cron_jobs_enabled_next ON ava_cron_jobs(enabled, next_run_at);
