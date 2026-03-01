-- Durable DB-first subagent lifecycle state

CREATE TABLE IF NOT EXISTS ava_subagent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id varchar(128) NOT NULL,
  parent_session_id varchar(255) NOT NULL,
  parent_session_key varchar(255),
  child_session_id varchar(255),
  child_session_key varchar(255),
  user_id varchar(255) NOT NULL,
  mode varchar(32) NOT NULL DEFAULT 'run',
  task text NOT NULL,
  type varchar(64) NOT NULL DEFAULT 'general',
  depth integer NOT NULL DEFAULT 0,
  status varchar(32) NOT NULL,
  announce_mode varchar(16) DEFAULT 'full',
  announce_summary text,
  result text,
  error text,
  tools_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_context jsonb DEFAULT '{}'::jsonb,
  requester_is_subagent boolean NOT NULL DEFAULT false,
  announce_triggered boolean NOT NULL DEFAULT false,
  cleanup_handled boolean NOT NULL DEFAULT false,
  cleanup_completed_at timestamptz,
  announce_retry_count integer NOT NULL DEFAULT 0,
  last_announce_retry_at timestamptz,
  ended_reason varchar(128),
  suppress_announce_reason varchar(128),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_runs_run_id
  ON ava_subagent_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_status
  ON ava_subagent_runs(parent_session_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_child
  ON ava_subagent_runs(child_session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_updated
  ON ava_subagent_runs(updated_at);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_key
  ON ava_subagent_runs(parent_session_key);
