/**
 * Queue Methods
 *
 * RPC handlers for queue management.
 */
import { queueService, type QueueMode } from '../services/queue.js';
import { createError, ErrorCodes, type RpcError } from '../protocol/types.js';
import { createLogger } from '../../lib/logger.js';
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from '../services/session-identity.js';

const log = createLogger('gateway', { method: 'queue' });

export interface QueueEnqueueParams {
  sessionKey: string;
  /**
   * @deprecated Ignored when gateway auth context is present.
   */
  userId?: string;
  message: string;
  mode?: QueueMode;
  priority?: number;
  source?: string;
  sourceMetadata?: Record<string, unknown>;
}

export interface QueueEnqueueResult {
  id: string;
  status: string;
  queuedAt: number;
}

export interface QueueStatsParams {
  sessionKey?: string;
}

export interface QueueStatsResult {
  pending: number;
  processing: number;
  completed: number;
  error: number;
}

export interface QueuePendingParams {
  sessionKey: string;
}

export interface QueuePendingResult {
  items: Array<{
    id: string;
    message: string;
    priority: number;
    mode: string;
    createdAt: number;
  }>;
}

export interface QueueCancelParams {
  sessionKey: string;
}

export interface QueueCancelResult {
  cancelled: number;
}

async function resolveQueueSessionId(params: {
  sessionKey?: string;
  authUserId?: string;
}): Promise<{ sessionId: string } | RpcError> {
  const rawSessionKey = params.sessionKey?.trim();

  if (!rawSessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, 'sessionKey is required');
  }

  if (params.authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: params.authUserId,
      sessionKey: rawSessionKey,
    });
    if (!identity) {
      return createError(
        ErrorCodes.NOT_FOUND,
        `Session ${rawSessionKey} not found`,
      );
    }
    return { sessionId: identity.sessionId };
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: rawSessionKey,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${rawSessionKey} not found`,
    );
  }

  return { sessionId: identity.sessionId };
}

export async function queueEnqueue(
  params: QueueEnqueueParams,
  authUserId?: string,
): Promise<QueueEnqueueResult | RpcError> {
  const {
    sessionKey,
    userId: requestedUserId,
    message,
    mode,
    priority,
    source,
    sourceMetadata,
  } = params;
  const userId = authUserId ?? requestedUserId;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (!userId || !message) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionKey, userId, and message are required',
    );
  }
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionId is no longer accepted; use sessionKey',
    );
  }

  try {
    const resolved = await resolveQueueSessionId({
      sessionKey,
      authUserId,
    });

    if ('code' in resolved) {
      return resolved;
    }

    const item = await queueService.enqueue(resolved.sessionId, userId, message, {
      mode,
      priority,
      source,
      sourceMetadata,
    });

    return {
      id: item.id,
      status: item.status,
      queuedAt: item.createdAt?.getTime() ?? Date.now(),
    };
  } catch (error) {
    log.error(
      { err: error, sessionId: requestedSessionId, sessionKey },
      'Failed to enqueue',
    );
    return createError(ErrorCodes.INTERNAL_ERROR, 'Failed to enqueue message');
  }
}

export async function queueStats(
  params: QueueStatsParams,
  authUserId?: string,
): Promise<QueueStatsResult | RpcError> {
  const requestedSessionId = (params as { sessionId?: string }).sessionId;
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionId is no longer accepted; use sessionKey',
    );
  }
  try {
    let sessionId: string | undefined;

    if (params.sessionKey) {
      const resolved = await resolveQueueSessionId({
        sessionKey: params.sessionKey,
        authUserId,
      });

      if ('code' in resolved) {
        return resolved;
      }

      sessionId = resolved.sessionId;
    }

    const stats = await queueService.getStats(sessionId, authUserId);
    return stats;
  } catch (error) {
    log.error(
      { err: error, sessionId: requestedSessionId, sessionKey: params.sessionKey },
      'Failed to get queue stats',
    );
    return createError(ErrorCodes.INTERNAL_ERROR, 'Failed to get queue stats');
  }
}

export async function queuePending(
  params: QueuePendingParams,
  authUserId?: string,
): Promise<QueuePendingResult | RpcError> {
  const requestedSessionId = (params as { sessionId?: string }).sessionId;
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionId is no longer accepted; use sessionKey',
    );
  }
  try {
    const resolved = await resolveQueueSessionId({
      sessionKey: params.sessionKey,
      authUserId,
    });

    if ('code' in resolved) {
      return resolved;
    }

    const items = await queueService.getPending(resolved.sessionId);
    return {
      items: items.map((item) => ({
        id: item.id,
        message: item.message,
        priority: item.priority,
        mode: item.mode,
        createdAt: item.createdAt?.getTime() ?? Date.now(),
      })),
    };
  } catch (error) {
    log.error(
      { err: error, sessionId: requestedSessionId, sessionKey: params.sessionKey },
      'Failed to get pending items',
    );
    return createError(ErrorCodes.INTERNAL_ERROR, 'Failed to get pending items');
  }
}

export async function queueCancel(
  params: QueueCancelParams,
  authUserId?: string,
): Promise<QueueCancelResult | RpcError> {
  const requestedSessionId = (params as { sessionId?: string }).sessionId;
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionId is no longer accepted; use sessionKey',
    );
  }
  try {
    const resolved = await resolveQueueSessionId({
      sessionKey: params.sessionKey,
      authUserId,
    });

    if ('code' in resolved) {
      return resolved;
    }

    const cancelled = await queueService.cancelPending(resolved.sessionId);
    return { cancelled };
  } catch (error) {
    log.error(
      { err: error, sessionId: requestedSessionId, sessionKey: params.sessionKey },
      'Failed to cancel pending items',
    );
    return createError(ErrorCodes.INTERNAL_ERROR, 'Failed to cancel pending items');
  }
}
