/**
 * System Events Queue
 *
 * PostgreSQL-backed typed event storage with deduplication.
 */
import { notificationDeduplicator } from '../../services/notification-deduplicator.js';
import { systemEventsService } from '../../services/system-events.service.js';
import { createLogger } from '../../lib/logger.js';
import {
  normalizeSystemEventKind,
  type SystemEventKind,
  type SystemEventPayload,
  type SystemEventPayloadMap,
} from '../../core/system-events.js';

const log = createLogger('agent');

export interface SystemEvent<K extends SystemEventKind = SystemEventKind> {
  id: string;
  sessionId: string;
  sessionKey?: string;
  kind: K;
  payload: SystemEventPayload<K>;
  eventKey?: string;
  createdAt: number;
  lifecycleState: string;
  processed: boolean;
  processedAt?: number;
  expiresAt?: number;
  claimToken?: string;
  claimedAt?: number;
  claimExpiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ClaimedSystemEvents {
  claimToken: string;
  events: SystemEvent[];
}

export type QueueSystemEventResult =
  | { status: 'queued'; event: SystemEvent }
  | { status: 'duplicate' }
  | { status: 'failed' };

export type QueueableSystemEvent<K extends SystemEventKind = SystemEventKind> = {
  sessionId: string;
  sessionKey?: string;
  kind: K;
  payload: SystemEventPayloadMap[K];
  eventKey: string;
  metadata?: Record<string, unknown>;
  expiresAt?: number | Date;
};

function mapEvent(event: Awaited<ReturnType<typeof systemEventsService.create>>): SystemEvent {
  return {
    id: event.id,
    sessionId: event.sessionId,
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    kind: event.kind,
    payload: event.payload,
    ...(event.eventKey ? { eventKey: event.eventKey } : {}),
    createdAt: event.createdAt.getTime(),
    lifecycleState: event.lifecycleState,
    processed: event.processed,
    ...(event.processedAt ? { processedAt: event.processedAt.getTime() } : {}),
    ...(event.expiresAt ? { expiresAt: event.expiresAt.getTime() } : {}),
    ...(event.claimToken ? { claimToken: event.claimToken } : {}),
    ...(event.claimedAt ? { claimedAt: event.claimedAt.getTime() } : {}),
    ...(event.claimExpiresAt ? { claimExpiresAt: event.claimExpiresAt.getTime() } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };
}

/**
 * Queue a typed system event with deduplication.
 */
export async function queueSystemEventWithStatus(
  event: QueueableSystemEvent,
): Promise<QueueSystemEventResult> {
  try {
    const normalizedEventKey = event.eventKey?.trim();
    if (!normalizedEventKey) {
      log.warn(
        {
          sessionId: event.sessionId,
          kind: event.kind,
        },
        "Dropping system event without eventKey (typed hard-cut)",
      );
      return { status: "failed" };
    }

    const rawExpiresAt = event.expiresAt;
    const expiresAt =
      typeof rawExpiresAt === 'number'
        ? new Date(rawExpiresAt)
        : rawExpiresAt && Object.prototype.toString.call(rawExpiresAt) === '[object Date]'
          ? (rawExpiresAt as Date)
          : undefined;

    const result = await notificationDeduplicator.checkAndCreate({
      sessionId: event.sessionId,
      ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
      kind: normalizeSystemEventKind(event.kind),
      payload: event.payload,
      eventKey: normalizedEventKey,
      metadata: event.metadata,
      expiresAt,
    });

    if (result.isDuplicate) {
      log.info(
        {
          sessionId: event.sessionId,
          kind: event.kind,
          eventKey: normalizedEventKey,
        },
        'Duplicate event prevented by deduplication',
      );
      return { status: 'duplicate' };
    }

    if (!result.event) {
      log.warn({ event }, 'Event creation returned no event');
      return { status: 'failed' };
    }

    return {
      status: 'queued',
      event: {
        id: result.event.id,
        sessionId: event.sessionId,
        ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
        kind: normalizeSystemEventKind(event.kind),
        payload: event.payload,
        eventKey: normalizedEventKey,
        createdAt: result.event.createdAt.getTime(),
        lifecycleState: 'pending',
        processed: false,
        ...(result.event.expiresAt ? { expiresAt: result.event.expiresAt.getTime() } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      },
    };
  } catch (error) {
    log.error({ err: error, event }, 'Failed to queue system event');
    return { status: 'failed' };
  }
}

/**
 * Queue a typed system event with deduplication.
 */
export async function queueSystemEvent(
  event: QueueableSystemEvent,
): Promise<SystemEvent | null> {
  const result = await queueSystemEventWithStatus(event);
  return result.status === 'queued' ? result.event : null;
}

/**
 * Peek at pending events without removing them.
 */
export async function peekSystemEvents(sessionId: string): Promise<SystemEvent[]> {
  try {
    const events = await systemEventsService.getPendingEvents(sessionId);
    return events.map((event) => mapEvent(event));
  } catch (error) {
    log.error({ err: error, sessionId }, 'Failed to peek system events');
    return [];
  }
}

/**
 * Claim pending events for exclusive processing by one heartbeat run.
 */
export async function claimSystemEvents(
  sessionId: string,
  opts?: { limit?: number; claimTtlSeconds?: number; claimToken?: string },
): Promise<ClaimedSystemEvents | null> {
  try {
    const claimed = await systemEventsService.claimPendingEvents({
      sessionId,
      limit: opts?.limit,
      claimTtlSeconds: opts?.claimTtlSeconds,
      claimToken: opts?.claimToken,
    });

    if (!claimed) {
      return null;
    }

    return {
      claimToken: claimed.claimToken,
      events: claimed.events.map((event) => mapEvent(event)),
    };
  } catch (error) {
    log.error({ err: error, sessionId }, 'Failed to claim system events');
    return null;
  }
}

export async function finalizeSystemEventClaim(claimToken: string): Promise<number> {
  try {
    return await systemEventsService.finalizeClaim(claimToken);
  } catch (error) {
    log.error({ err: error, claimToken }, 'Failed to finalize system event claim');
    return 0;
  }
}

export async function releaseSystemEventClaim(claimToken: string): Promise<number> {
  try {
    return await systemEventsService.releaseClaim(claimToken);
  } catch (error) {
    log.error({ err: error, claimToken }, 'Failed to release system event claim');
    return 0;
  }
}

/**
 * Remove a specific event after successful delivery.
 */
export async function removeSystemEvent(sessionId: string, eventId: string): Promise<boolean> {
  try {
    const success = await systemEventsService.markProcessed(eventId);

    if (success) {
      log.info({ sessionId, eventId }, 'System event marked as processed');
    }

    return success;
  } catch (error) {
    log.error({ err: error, sessionId, eventId }, 'Failed to remove system event');
    return false;
  }
}

/**
 * Clear all events for a session.
 */
export async function clearSystemEvents(sessionId: string): Promise<void> {
  try {
    const count = await systemEventsService.deleteSessionEvents(sessionId);
    log.info({ sessionId, count }, 'System events cleared');
  } catch (error) {
    log.error({ err: error, sessionId }, 'Failed to clear system events');
  }
}

export async function dropExpiredSystemEvents(sessionId?: string): Promise<number> {
  try {
    return await systemEventsService.dropExpiredEvents(sessionId);
  } catch (error) {
    log.error({ err: error, sessionId }, 'Failed to drop expired system events');
    return 0;
  }
}

/**
 * Check if there are any pending events of a specific kind.
 */
export async function hasEventKind(sessionId: string, kind: SystemEventKind): Promise<boolean> {
  const events = await peekSystemEvents(sessionId);
  return events.some((event) => event.kind === kind);
}

/**
 * Get count of pending events across all sessions (for monitoring).
 */
export async function getEventStats(): Promise<{ totalEvents: number; sessionCount: number }> {
  try {
    const stats = await systemEventsService.getStats();
    return {
      totalEvents: stats.pendingEvents,
      sessionCount: stats.sessionCount,
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to get event stats');
    return { totalEvents: 0, sessionCount: 0 };
  }
}
