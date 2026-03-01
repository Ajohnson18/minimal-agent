CREATE TABLE IF NOT EXISTS ava_exec_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255),
  agent_id VARCHAR(100) NOT NULL DEFAULT 'main',
  command TEXT NOT NULL,
  cwd TEXT,
  host VARCHAR(32) NOT NULL,
  security VARCHAR(32) NOT NULL,
  ask VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  decision VARCHAR(32),
  reason TEXT,
  resolved_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  resolved_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_exec_approvals_status
  ON ava_exec_approvals(status);
CREATE INDEX IF NOT EXISTS idx_exec_approvals_session_id
  ON ava_exec_approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_exec_approvals_expires_at
  ON ava_exec_approvals(expires_at);
CREATE INDEX IF NOT EXISTS idx_exec_approvals_user_agent
  ON ava_exec_approvals(user_id, agent_id);

CREATE TABLE IF NOT EXISTS ava_exec_allowlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(100) NOT NULL DEFAULT 'main',
  pattern TEXT NOT NULL,
  created_by_approval_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  last_used_command TEXT,
  last_resolved_path TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_allowlist_unique
  ON ava_exec_allowlist_entries(user_id, agent_id, pattern);
CREATE INDEX IF NOT EXISTS idx_exec_allowlist_user_agent
  ON ava_exec_allowlist_entries(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_exec_allowlist_created_by
  ON ava_exec_allowlist_entries(created_by_approval_id);
