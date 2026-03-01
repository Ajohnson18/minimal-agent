import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { avaSessions } from '../db/schema/index.js';
import { getConfig, type Config } from '../lib/config-loader.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('subagent');

export type SubagentFlowMode = 'async' | 'supervisor';

const SESSION_FLOW_MODE_KEY = 'subagentFlowMode';
const SUBAGENT_FLOW_MODE_SET = new Set<SubagentFlowMode>([
  'async',
  'supervisor',
]);

export function isSubagentFlowMode(value: string): value is SubagentFlowMode {
  return SUBAGENT_FLOW_MODE_SET.has(value as SubagentFlowMode);
}

export function normalizeSubagentFlowMode(
  value: string | null | undefined,
  fallback: SubagentFlowMode = 'async',
): SubagentFlowMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized && isSubagentFlowMode(normalized)) {
    return normalized;
  }
  return fallback;
}

function resolveConfiguredFlowMode(config: Config): SubagentFlowMode {
  const configured = config.subagents?.orchestration?.mode;
  return normalizeSubagentFlowMode(configured, 'async');
}

function isSessionOverrideAllowed(config: Config): boolean {
  return config.subagents?.orchestration?.allowSessionOverride !== false;
}

function readSessionFlowOverride(
  metadata: Record<string, unknown> | null | undefined,
): SubagentFlowMode | null {
  if (!metadata) {
    return null;
  }
  const candidate = metadata[SESSION_FLOW_MODE_KEY];
  if (typeof candidate !== 'string') {
    return null;
  }
  return normalizeSubagentFlowMode(candidate, 'async');
}

export function resolveSubagentFlowModeFromMetadata(params: {
  metadata?: Record<string, unknown> | null;
  config?: Config;
}): SubagentFlowMode {
  const config = params.config ?? getConfig();
  const globalMode = resolveConfiguredFlowMode(config);
  if (!isSessionOverrideAllowed(config)) {
    return globalMode;
  }
  return readSessionFlowOverride(params.metadata) ?? globalMode;
}

export async function resolveSessionSubagentFlowMode(
  sessionId: string,
): Promise<SubagentFlowMode> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return resolveSubagentFlowModeFromMetadata({});
  }

  const [session] = await db
    .select({ metadata: avaSessions.metadata })
    .from(avaSessions)
    .where(eq(avaSessions.id, normalizedSessionId))
    .limit(1);

  const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
  return resolveSubagentFlowModeFromMetadata({ metadata });
}

export async function setSessionSubagentFlowMode(
  sessionId: string,
  mode: SubagentFlowMode | 'default',
): Promise<SubagentFlowMode> {
  const normalizedSessionId = sessionId.trim();
  const config = getConfig();
  const globalMode = resolveConfiguredFlowMode(config);

  if (!normalizedSessionId) {
    return globalMode;
  }

  const [session] = await db
    .select({ metadata: avaSessions.metadata })
    .from(avaSessions)
    .where(eq(avaSessions.id, normalizedSessionId))
    .limit(1);

  if (!session) {
    log.warn({ sessionId: normalizedSessionId }, 'Cannot set flow mode for missing session');
    return globalMode;
  }

  const metadata = { ...((session.metadata ?? {}) as Record<string, unknown>) };
  if (mode === 'default') {
    delete metadata[SESSION_FLOW_MODE_KEY];
  } else {
    metadata[SESSION_FLOW_MODE_KEY] = mode;
  }

  await db
    .update(avaSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(eq(avaSessions.id, normalizedSessionId));

  return resolveSubagentFlowModeFromMetadata({ metadata, config });
}

export function getSubagentFlowModeMetadataKey(): string {
  return SESSION_FLOW_MODE_KEY;
}

