-- Hard-cut session key constraints and lookup indexes (additive)

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

UPDATE ava_session_bindings b
SET session_key = s.session_key
FROM ava_sessions s
WHERE b.session_id = s.id::text
  AND (b.session_key IS NULL OR btrim(b.session_key) = '');

CREATE INDEX IF NOT EXISTS idx_session_bindings_session_key_updated
  ON ava_session_bindings(session_key, updated_at DESC);
