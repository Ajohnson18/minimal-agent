-- Heartbeat/subagent parity: event claiming + outbound idempotency

ALTER TABLE ava_system_events
  ADD COLUMN IF NOT EXISTS claim_token varchar(255),
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_system_events_claim_token ON ava_system_events(claim_token);
CREATE INDEX IF NOT EXISTS idx_system_events_claim_expires_at ON ava_system_events(claim_expires_at);

CREATE TABLE IF NOT EXISTS ava_outbound_idempotency (
  idempotency_key varchar(255) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ava_outbound_idempotency_expires_at
  ON ava_outbound_idempotency(expires_at);
