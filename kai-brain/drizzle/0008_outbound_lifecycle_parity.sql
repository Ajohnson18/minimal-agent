-- Phase 2 parity: durable outbound delivery, lifecycle state, binding, and event expiry

ALTER TABLE ava_sessions
  ADD COLUMN IF NOT EXISTS lifecycle_state varchar(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_reason text;

CREATE INDEX IF NOT EXISTS idx_ava_sessions_lifecycle_state
  ON ava_sessions(lifecycle_state);

ALTER TABLE ava_system_events
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_system_events_expires_at
  ON ava_system_events(expires_at);

ALTER TABLE ava_outbound_idempotency
  ADD COLUMN IF NOT EXISTS state varchar(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivery_job_id varchar(255),
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS idx_ava_outbound_idempotency_state
  ON ava_outbound_idempotency(state);
CREATE INDEX IF NOT EXISTS idx_ava_outbound_idempotency_delivery_job_id
  ON ava_outbound_idempotency(delivery_job_id);

CREATE TABLE IF NOT EXISTS ava_outbound_delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(32) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  session_id varchar(255),
  route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  idempotency_key varchar(255),
  reason varchar(120),
  last_error text,
  provider_meta jsonb DEFAULT '{}'::jsonb,
  claimed_by varchar(255),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_jobs_status_next_attempt
  ON ava_outbound_delivery_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_session_id
  ON ava_outbound_delivery_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_idempotency_key
  ON ava_outbound_delivery_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_claim_expires_at
  ON ava_outbound_delivery_jobs(claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_expires_at
  ON ava_outbound_delivery_jobs(expires_at);

CREATE TABLE IF NOT EXISTS ava_session_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(255) NOT NULL,
  channel varchar(50) NOT NULL,
  external_id varchar(255) NOT NULL,
  route jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(32) NOT NULL DEFAULT 'active',
  bound_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_bindings_session_external
  ON ava_session_bindings(session_id, external_id);
CREATE INDEX IF NOT EXISTS idx_session_bindings_session_status
  ON ava_session_bindings(session_id, status);
CREATE INDEX IF NOT EXISTS idx_session_bindings_channel_external
  ON ava_session_bindings(channel, external_id);
