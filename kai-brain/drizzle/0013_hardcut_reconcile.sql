-- Reconcile hard-cut additive schema for environments where migration history
-- was baselined without applying 0009-0012 SQL.

ALTER TABLE ava_sessions
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS agent_id varchar(100) NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS scope varchar(64) NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_ava_sessions_session_key
  ON ava_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_ava_sessions_agent_scope
  ON ava_sessions(agent_id, scope);

UPDATE ava_sessions
SET session_key = lower(
  concat_ws(
    ':',
    'agent',
    coalesce(nullif(agent_id, ''), 'main'),
    coalesce(nullif(scope, ''), 'main'),
    substr(id::text, 1, 12)
  )
)
WHERE session_key IS NULL OR btrim(session_key) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ava_sessions_session_key_unique
  ON ava_sessions(session_key)
  WHERE session_key IS NOT NULL AND btrim(session_key) <> '';

ALTER TABLE ava_session_bindings
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS account_id varchar(255),
  ADD COLUMN IF NOT EXISTS conversation_id varchar(255),
  ADD COLUMN IF NOT EXISTS thread_id varchar(255),
  ADD COLUMN IF NOT EXISTS binding_kind varchar(64) NOT NULL DEFAULT 'channel',
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true;

UPDATE ava_session_bindings b
SET session_key = s.session_key
FROM ava_sessions s
WHERE b.session_id = s.id::text
  AND (b.session_key IS NULL OR btrim(b.session_key) = '');

CREATE INDEX IF NOT EXISTS idx_session_bindings_session_key_status
  ON ava_session_bindings(session_key, status, is_primary, priority);
CREATE INDEX IF NOT EXISTS idx_session_bindings_resolution
  ON ava_session_bindings(session_key, channel, account_id, conversation_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_session_bindings_session_key_updated
  ON ava_session_bindings(session_key, updated_at DESC);

ALTER TABLE ava_system_events
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS kind varchar(120),
  ADD COLUMN IF NOT EXISTS event_key varchar(500),
  ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_state varchar(32) NOT NULL DEFAULT 'pending';

UPDATE ava_system_events
SET kind = CASE
  WHEN type = 'exec-completion' THEN 'exec.completion'
  WHEN type = 'subagent-completion' THEN 'subagent.completion'
  WHEN type = 'cursor-completion' THEN 'cursor.completion'
  WHEN type = 'cron-fired' THEN 'cron.fired'
  ELSE kind
END
WHERE kind IS NULL;

UPDATE ava_system_events
SET event_key = context_key
WHERE (event_key IS NULL OR btrim(event_key) = '')
  AND context_key IS NOT NULL
  AND btrim(context_key) <> '';

UPDATE ava_system_events
SET payload = jsonb_build_object(
  'text', text,
  'legacyType', type
)
WHERE payload IS NULL OR payload = '{}'::jsonb;

UPDATE ava_system_events
SET lifecycle_state = CASE
  WHEN processed THEN 'processed'
  WHEN claim_token IS NOT NULL THEN 'claimed'
  ELSE 'pending'
END
WHERE lifecycle_state IS NULL OR btrim(lifecycle_state) = '';

UPDATE ava_system_events e
SET session_key = s.session_key
FROM ava_sessions s
WHERE e.session_id = s.id::text
  AND (e.session_key IS NULL OR btrim(e.session_key) = '');

CREATE INDEX IF NOT EXISTS idx_system_events_session_key
  ON ava_system_events(session_key);
CREATE INDEX IF NOT EXISTS idx_system_events_kind
  ON ava_system_events(kind);
CREATE INDEX IF NOT EXISTS idx_system_events_lifecycle
  ON ava_system_events(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_system_events_event_key
  ON ava_system_events(event_key);
CREATE INDEX IF NOT EXISTS idx_system_events_session_event_key
  ON ava_system_events(session_id, event_key);
CREATE INDEX IF NOT EXISTS idx_system_events_session_key_event_key
  ON ava_system_events(session_key, event_key);
CREATE INDEX IF NOT EXISTS idx_system_events_claim_pending
  ON ava_system_events(session_id, lifecycle_state, claim_expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS ava_hook_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase varchar(120) NOT NULL,
  plugin varchar(255) NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  outcome varchar(32) NOT NULL,
  latency_ms integer NOT NULL DEFAULT 0,
  session_id varchar(255),
  session_key varchar(255),
  run_id varchar(255),
  error text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hook_exec_phase_created
  ON ava_hook_executions(phase, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_exec_session
  ON ava_hook_executions(session_id, session_key);
CREATE INDEX IF NOT EXISTS idx_hook_exec_plugin
  ON ava_hook_executions(plugin, created_at);

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
