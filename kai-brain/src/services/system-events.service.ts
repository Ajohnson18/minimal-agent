/**
 * System Events Service
 *
 * Persistent PostgreSQL-backed event storage with deduplication support.
 * Replaces in-memory event queue for reliable event tracking.
 */
import { db } from '../db/client.js';
import { avaSystemEvents } from '../db/schema/system-events.js';
import { eq, and, or, desc, sql, lt } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';
import { randomUUID } from 'node:crypto';
import {
  normalizeSystemEventKind,
  validateSystemEventPayload,
  type SystemEventKind,
  type SystemEventPayload,
  type SystemEventPayloadMap,
} from '../core/system-events.js';

const log = createLogger('agent');
const LEGACY_TYPE_BY_KIND: Record<SystemEventKind, string> = {
  'exec.completion': 'exec-completion',
  'subagent.completion': 'subagent-completion',
  'cursor.completion': 'cursor-completion',
  'cron.fired': 'cron-fired',
};

function legacyTypeFromKind(kind: SystemEventKind): string {
  return LEGACY_TYPE_BY_KIND[kind];
}

export interface SystemEventInput {
  sessionId: string;
  sessionKey?: string;
  kind: SystemEventKind;
  payload: SystemEventPayload<SystemEventKind>;
  eventKey?: string;
  contextKey?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export interface SystemEvent extends SystemEventInput {
  id: string;
  lifecycleState: string;
  processed: boolean;
  processedAt: Date | null;
  claimToken?: string;
  claimedAt?: Date | null;
  claimExpiresAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
  type: string;
  text: string;
}

const EVENT_RETENTION_DAYS = 7;

export class SystemEventsService {
  private normalizePayload(
    kind: SystemEventKind,
    value: unknown,
  ): SystemEventPayloadMap[SystemEventKind] {
    return validateSystemEventPayload(kind, value);
  }

  private asDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Claim pending events atomically for a heartbeat worker.
   * Claimed events are hidden from other workers until claim expiry.
   */
  async claimPendingEvents(params: {
    sessionId: string;
    limit?: number;
    claimTtlSeconds?: number;
    claimToken?: string;
  }): Promise<{ claimToken: string; events: SystemEvent[] } | null> {
    const sessionId = params.sessionId?.trim();
    if (!sessionId) return null;

    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit!))
      : 50;
    const claimTtlSeconds = Number.isFinite(params.claimTtlSeconds)
      ? Math.max(5, Math.floor(params.claimTtlSeconds!))
      : 60;
    const claimToken = params.claimToken?.trim() || randomUUID();

    try {
      const result = await db.execute(sql`
        WITH picked AS (
          SELECT id
          FROM ava_system_events
          WHERE session_id = ${sessionId}
            AND processed = false
            AND lifecycle_state = 'pending'
            AND (expires_at IS NULL OR expires_at > now())
            AND (claim_expires_at IS NULL OR claim_expires_at < now())
          ORDER BY created_at DESC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ava_system_events e
        SET claim_token = ${claimToken},
            claimed_at = now(),
            claim_expires_at = now() + (${claimTtlSeconds} * interval '1 second'),
            lifecycle_state = 'claimed'
        FROM picked
        WHERE e.id = picked.id
        RETURNING e.*;
      `);

      const rows = ((result as unknown as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return null;
      }

      return {
        claimToken,
        events: rows.map((row) => this.mapToEvent(row)),
      };
    } catch (error) {
      log.error({ err: error, sessionId }, 'Failed to claim pending events');
      return null;
    }
  }

  async releaseClaim(claimToken: string): Promise<number> {
    const token = claimToken?.trim();
    if (!token) return 0;

    try {
      const released = await db
        .update(avaSystemEvents)
        .set({
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lifecycleState: 'pending',
        })
        .where(
          and(
            eq(avaSystemEvents.claimToken, token),
            eq(avaSystemEvents.processed, false),
          ),
        )
        .returning({ id: avaSystemEvents.id });
      return released.length;
    } catch (error) {
      log.error({ err: error, claimToken: token }, 'Failed to release claim');
      return 0;
    }
  }

  async finalizeClaim(claimToken: string): Promise<number> {
    const token = claimToken?.trim();
    if (!token) return 0;

    try {
      const finalized = await db
        .update(avaSystemEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lifecycleState: 'processed',
        })
        .where(
          and(
            eq(avaSystemEvents.claimToken, token),
            eq(avaSystemEvents.processed, false),
          ),
        )
        .returning({ id: avaSystemEvents.id });

      return finalized.length;
    } catch (error) {
      log.error({ err: error, claimToken: token }, 'Failed to finalize claim');
      return 0;
    }
  }

  /**
   * Create a new system event
   */
  async create(input: SystemEventInput): Promise<SystemEvent> {
    try {
      const kind = normalizeSystemEventKind(input.kind);
      const payload = validateSystemEventPayload(kind, input.payload);
      const text = payload.text?.trim() || '';
      const [event] = await db
        .insert(avaSystemEvents)
        .values({
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          kind,
          payload: payload as unknown as Record<string, unknown>,
          eventKey: input.eventKey,
          lifecycleState: 'pending',
          type: legacyTypeFromKind(kind),
          text,
          contextKey: input.contextKey,
          metadata: input.metadata || {},
          expiresAt: input.expiresAt,
          processed: false,
        })
        .returning();

      log.info({
        eventId: event.id,
        sessionId: input.sessionId,
        kind,
        contextKey: input.contextKey,
      }, 'System event created');

      return this.mapToEvent(event);
    } catch (error) {
      log.error({ err: error, input }, 'Failed to create system event');
      throw error;
    }
  }

  /**
   * Get pending (unprocessed) events for a session
   */
  async getPendingEvents(sessionId: string): Promise<SystemEvent[]> {
    try {
      const events = await db
        .select()
        .from(avaSystemEvents)
        .where(
          and(
            eq(avaSystemEvents.sessionId, sessionId),
            eq(avaSystemEvents.processed, false),
            or(
              sql`${avaSystemEvents.expiresAt} IS NULL`,
              sql`${avaSystemEvents.expiresAt} > now()`
            )
          )
        )
        .orderBy(desc(avaSystemEvents.createdAt));

      return events.map(e => this.mapToEvent(e));
    } catch (error) {
      log.error({ err: error, sessionId }, 'Failed to get pending events');
      return [];
    }
  }

  /**
   * Find events by context key (for deduplication)
   */
  async findByContextKey(
    contextKey: string,
    withinSeconds: number = 60,
    sessionId?: string,
  ): Promise<SystemEvent[]> {
    try {
      const cutoffTime = new Date(Date.now() - withinSeconds * 1000);
      const normalizedSessionId = sessionId?.trim();
      const filters = [
        eq(avaSystemEvents.contextKey, contextKey),
        sql`${avaSystemEvents.createdAt} >= ${cutoffTime}`,
        or(
          sql`${avaSystemEvents.expiresAt} IS NULL`,
          sql`${avaSystemEvents.expiresAt} > now()`
        ),
      ];
      if (normalizedSessionId) {
        filters.push(eq(avaSystemEvents.sessionId, normalizedSessionId));
      }

      const events = await db
        .select()
        .from(avaSystemEvents)
        .where(and(...filters))
        .orderBy(desc(avaSystemEvents.createdAt));

      return events.map(e => this.mapToEvent(e));
    } catch (error) {
      log.error(
        { err: error, contextKey, sessionId },
        'Failed to find events by context key',
      );
      return [];
    }
  }

  async findByEventKey(
    eventKey: string,
    withinSeconds: number = 60,
    sessionId?: string,
  ): Promise<SystemEvent[]> {
    const normalizedKey = eventKey.trim();
    if (!normalizedKey) return [];

    try {
      const cutoffTime = new Date(Date.now() - withinSeconds * 1000);
      const normalizedSessionId = sessionId?.trim();
      const filters = [
        eq(avaSystemEvents.eventKey, normalizedKey),
        sql`${avaSystemEvents.createdAt} >= ${cutoffTime}`,
        or(
          sql`${avaSystemEvents.expiresAt} IS NULL`,
          sql`${avaSystemEvents.expiresAt} > now()`,
        ),
      ];
      if (normalizedSessionId) {
        filters.push(eq(avaSystemEvents.sessionId, normalizedSessionId));
      }

      const events = await db
        .select()
        .from(avaSystemEvents)
        .where(and(...filters))
        .orderBy(desc(avaSystemEvents.createdAt));

      return events.map((event) => this.mapToEvent(event));
    } catch (error) {
      log.error(
        { err: error, eventKey: normalizedKey, sessionId },
        "Failed to find events by event key",
      );
      return [];
    }
  }

  /**
   * Mark event as processed
   */
  async markProcessed(eventId: string): Promise<boolean> {
    try {
      const result = await db
        .update(avaSystemEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lifecycleState: 'processed',
        })
        .where(eq(avaSystemEvents.id, eventId))
        .returning();

      if (result.length === 0) {
        log.warn({ eventId }, 'Event not found when marking as processed');
        return false;
      }

      log.info({ eventId }, 'Event marked as processed');
      return true;
    } catch (error) {
      log.error({ err: error, eventId }, 'Failed to mark event as processed');
      return false;
    }
  }

  /**
   * Mark multiple events as processed
   */
  async markMultipleProcessed(eventIds: string[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    try {
      const result = await db
        .update(avaSystemEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lifecycleState: 'processed',
        })
        .where(sql`${avaSystemEvents.id} = ANY(${eventIds})`)
        .returning();

      log.info({ count: result.length, eventIds }, 'Multiple events marked as processed');
      return result.length;
    } catch (error) {
      log.error({ err: error, eventIds }, 'Failed to mark multiple events as processed');
      return 0;
    }
  }

  /**
   * Clean up old processed events (7-day retention)
   */
  async cleanupOldEvents(): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      
      const result = await db
        .delete(avaSystemEvents)
        .where(
          and(
            eq(avaSystemEvents.processed, true),
            lt(avaSystemEvents.processedAt, cutoffDate)
          )
        )
        .returning();

      const count = result.length;
      
      if (count > 0) {
        log.info({ count, cutoffDate }, 'Cleaned up old processed events');
      }

      return count;
    } catch (error) {
      log.error({ err: error }, 'Failed to cleanup old events');
      return 0;
    }
  }

  /**
   * Get event statistics
   */
  async getStats(): Promise<{
    totalEvents: number;
    pendingEvents: number;
    processedEvents: number;
    sessionCount: number;
  }> {
    try {
      const [totalResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(avaSystemEvents);

      const [pendingResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(avaSystemEvents)
        .where(eq(avaSystemEvents.processed, false));

      const [sessionResult] = await db
        .select({ count: sql<number>`count(DISTINCT ${avaSystemEvents.sessionId})::int` })
        .from(avaSystemEvents)
        .where(eq(avaSystemEvents.processed, false));

      return {
        totalEvents: totalResult?.count ?? 0,
        pendingEvents: pendingResult?.count ?? 0,
        processedEvents: (totalResult?.count ?? 0) - (pendingResult?.count ?? 0),
        sessionCount: sessionResult?.count ?? 0,
      };
    } catch (error) {
      log.error({ err: error }, 'Failed to get event stats');
      return {
        totalEvents: 0,
        pendingEvents: 0,
        processedEvents: 0,
        sessionCount: 0,
      };
    }
  }

  /**
   * Delete all events for a session
   */
  async deleteSessionEvents(sessionId: string): Promise<number> {
    try {
      const result = await db
        .delete(avaSystemEvents)
        .where(eq(avaSystemEvents.sessionId, sessionId))
        .returning();

      const count = result.length;
      
      if (count > 0) {
        log.info({ sessionId, count }, 'Deleted session events');
      }

      return count;
    } catch (error) {
      log.error({ err: error, sessionId }, 'Failed to delete session events');
      return 0;
    }
  }

  async dropExpiredEvents(sessionId?: string): Promise<number> {
    try {
      const now = new Date();
      const conditions = [
        eq(avaSystemEvents.processed, false),
        lt(avaSystemEvents.expiresAt, now),
      ];
      if (sessionId) {
        conditions.push(eq(avaSystemEvents.sessionId, sessionId));
      }

      const deleted = await db
        .delete(avaSystemEvents)
        .where(and(...conditions))
        .returning({ id: avaSystemEvents.id });

      return deleted.length;
    } catch (error) {
      log.error({ err: error, sessionId }, 'Failed to drop expired system events');
      return 0;
    }
  }

  private mapToEvent(dbEvent: any): SystemEvent {
    const processedAt = this.asDate(dbEvent.processedAt ?? dbEvent.processed_at);
    const claimedAt = this.asDate(dbEvent.claimedAt ?? dbEvent.claimed_at);
    const claimExpiresAt = this.asDate(
      dbEvent.claimExpiresAt ?? dbEvent.claim_expires_at,
    );
    const expiresAt = this.asDate(dbEvent.expiresAt ?? dbEvent.expires_at);
    const createdAt = this.asDate(dbEvent.createdAt ?? dbEvent.created_at);
    const kind = normalizeSystemEventKind(dbEvent.kind);
    const payload = this.normalizePayload(kind, dbEvent.payload);
    const text = payload.text;
    const lifecycleState =
      typeof dbEvent.lifecycleState === 'string'
        ? dbEvent.lifecycleState
        : typeof dbEvent.lifecycle_state === 'string'
          ? dbEvent.lifecycle_state
          : dbEvent.processed
            ? 'processed'
            : dbEvent.claimToken || dbEvent.claim_token
              ? 'claimed'
              : 'pending';

    return {
      id: dbEvent.id,
      sessionId: dbEvent.sessionId ?? dbEvent.session_id,
      sessionKey: dbEvent.sessionKey ?? dbEvent.session_key ?? undefined,
      kind,
      payload,
      eventKey: dbEvent.eventKey ?? dbEvent.event_key ?? undefined,
      lifecycleState,
      type: dbEvent.type ?? legacyTypeFromKind(kind),
      text,
      contextKey: dbEvent.contextKey ?? dbEvent.context_key ?? undefined,
      processed: dbEvent.processed,
      processedAt,
      claimToken:
        typeof dbEvent.claimToken === 'string'
          ? dbEvent.claimToken
          : typeof dbEvent.claim_token === 'string'
            ? dbEvent.claim_token
            : undefined,
      claimedAt,
      claimExpiresAt,
      expiresAt,
      createdAt: createdAt ?? new Date(0),
      metadata: dbEvent.metadata || {},
    };
  }
}

// Singleton instance
export const systemEventsService = new SystemEventsService();
