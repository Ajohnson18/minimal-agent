/**
 * Heartbeat Lifecycle Manager
 *
 * Channel-agnostic heartbeat startup/shutdown.
 * Ensures one heartbeat per active session.
 */
import { startHeartbeat, stopHeartbeat, getHeartbeatStats } from './heartbeat.service.js';
import { createLogger } from '../../lib/logger.js';
import { getConfig } from '../../lib/config-loader.js';
import { setStopSessionHeartbeatCallback } from './heartbeat-wake.js';

const log = createLogger('agent');

const runningHeartbeats = new Set<string>();

setStopSessionHeartbeatCallback(stopSessionHeartbeat);

export interface EnsureHeartbeatOptions {
  sessionId: string;
  userId: string;
  externalId?: string;
  workspaceDir?: string;
  intervalMs?: number;
  target?: string;
  to?: string;
  accountId?: string;
}

/**
 * Ensure heartbeat is running for a session.
 * Idempotent - safe to call multiple times.
 */
export function ensureHeartbeatRunning(options: EnsureHeartbeatOptions): void {
  const { sessionId, userId, externalId, workspaceDir, intervalMs, target, to, accountId } = options;

  // Check if already running
  if (runningHeartbeats.has(sessionId)) {
    return;
  }

  // Check if heartbeat is enabled globally
  const enabled = getConfig().heartbeat.enabled;
  if (!enabled) {
    return;
  }

  const interval = intervalMs ?? 
    getConfig().heartbeat.intervalMs;

  log.info({ sessionId, intervalMs: interval }, 'Starting session heartbeat');

  startHeartbeat({
    enabled: true,
    intervalMs: interval,
    workspaceDir: workspaceDir || process.cwd(),
    userId,
    sessionId,
    externalId,
    target: target ?? getConfig().heartbeat.target,
    to: to ?? getConfig().heartbeat.to,
    accountId: accountId ?? getConfig().heartbeat.accountId,
  });

  runningHeartbeats.add(sessionId);
}

/**
 * Stop heartbeat for a session (cleanup).
 */
export function stopSessionHeartbeat(sessionId: string): void {
  if (!runningHeartbeats.has(sessionId)) {
    return;
  }

  log.info({ sessionId }, 'Stopping session heartbeat');
  stopHeartbeat(sessionId);
  runningHeartbeats.delete(sessionId);
}

/**
 * Get stats for monitoring.
 */
export function getHeartbeatLifecycleStats() {
  const stats = getHeartbeatStats();
  return {
    ...stats,
    trackedSessions: runningHeartbeats.size,
  };
}
