ALTER TABLE ava_sessions
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS agent_id varchar(100) NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS scope varchar(64) NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_ava_sessions_session_key
  ON ava_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_ava_sessions_agent_scope
  ON ava_sessions(agent_id, scope);

-- Deterministic session_key backfill for historical sessions
UPDATE ava_sessions
SET session_key = lower(
  concat_ws(':',
    'agent',
    coalesce(nullif(agent_id, ''), 'main'),
    coalesce(nullif(scope, ''), 'main'),
    substr(id::text, 1, 12)
  )
)
WHERE session_key IS NULL OR btrim(session_key) = '';

ALTER TABLE ava_session_bindings
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS account_id varchar(255),
  ADD COLUMN IF NOT EXISTS conversation_id varchar(255),
  ADD COLUMN IF NOT EXISTS thread_id varchar(255),
  ADD COLUMN IF NOT EXISTS binding_kind varchar(64) NOT NULL DEFAULT 'channel',
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_session_bindings_session_key_status
  ON ava_session_bindings(session_key, status, is_primary, priority);
CREATE INDEX IF NOT EXISTS idx_session_bindings_resolution
  ON ava_session_bindings(session_key, channel, account_id, conversation_id, thread_id);

UPDATE ava_session_bindings b
SET session_key = s.session_key
FROM ava_sessions s
WHERE b.session_id = s.id::text
  AND (b.session_key IS NULL OR btrim(b.session_key) = '');

ALTER TABLE ava_system_events
  ADD COLUMN IF NOT EXISTS session_key varchar(255),
  ADD COLUMN IF NOT EXISTS kind varchar(120),
  ADD COLUMN IF NOT EXISTS event_key varchar(500),
  ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_state varchar(32) NOT NULL DEFAULT 'pending';

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
