-- Strengthen typed system event claim/dedupe indexes (additive)

UPDATE ava_system_events e
SET session_key = s.session_key
FROM ava_sessions s
WHERE e.session_id = s.id::text
  AND (e.session_key IS NULL OR btrim(e.session_key) = '');

UPDATE ava_system_events
SET event_key = context_key
WHERE (event_key IS NULL OR btrim(event_key) = '')
  AND context_key IS NOT NULL
  AND btrim(context_key) <> '';

CREATE INDEX IF NOT EXISTS idx_system_events_session_key_event_key
  ON ava_system_events(session_key, event_key);

CREATE INDEX IF NOT EXISTS idx_system_events_claim_pending
  ON ava_system_events(session_id, lifecycle_state, claim_expires_at, created_at DESC);
