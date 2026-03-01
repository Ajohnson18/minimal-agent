/**
 * Notification Deduplicator
 *
 * Prevents duplicate notifications within a time window using event keys.
 * Uses PostgreSQL for persistent deduplication state.
 */
import { systemEventsService, type SystemEventInput } from './system-events.service.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('agent');

const DEDUPLICATION_WINDOW_SECONDS = 60; // 60-second window

export interface DeduplicationResult {
  isDuplicate: boolean;
  event?: {
    id: string;
    createdAt: Date;
    expiresAt?: Date | null;
  };
  existingEvents?: Array<{
    id: string;
    createdAt: Date;
    expiresAt?: Date | null;
  }>;
}

export class NotificationDeduplicator {
  /**
   * Check if an event is a duplicate within the deduplication window.
   * If not a duplicate, creates the event.
   */
  async checkAndCreate(input: SystemEventInput): Promise<DeduplicationResult> {
    const eventKey =
      typeof input.eventKey === "string" ? input.eventKey.trim() : "";

    // Hard-cut typed event pipeline: eventKey is required for deterministic dedupe.
    if (!eventKey) {
      const event = await systemEventsService.create(input);
      return {
        isDuplicate: false,
        event: {
          id: event.id,
          createdAt: event.createdAt,
          expiresAt: event.expiresAt,
        },
      };
    }

    try {
      // Check for existing events with the same event key within window.
      const existingEvents = await systemEventsService.findByEventKey(
        eventKey,
        DEDUPLICATION_WINDOW_SECONDS,
        input.sessionId,
      );

      // If duplicate events exist, don't create a new one
      if (existingEvents.length > 0) {
        log.info({
          eventKey,
          existingCount: existingEvents.length,
          sessionId: input.sessionId,
        }, 'Duplicate event detected - skipping creation');

        return {
          isDuplicate: true,
          existingEvents: existingEvents.map(e => ({
            id: e.id,
            createdAt: e.createdAt,
            expiresAt: e.expiresAt,
          })),
        };
      }

      // No duplicates found - create the event
      const event = await systemEventsService.create(input);

      log.info({
        eventId: event.id,
        eventKey,
        sessionId: input.sessionId,
      }, 'New event created (no duplicates)');

      return {
        isDuplicate: false,
        event: {
          id: event.id,
          createdAt: event.createdAt,
          expiresAt: event.expiresAt,
        },
      };
    } catch (error) {
      log.error({ err: error, input }, 'Error in deduplication check');
      
      // On error, create the event anyway (fail open)
      const event = await systemEventsService.create(input);
      return {
        isDuplicate: false,
        event: {
          id: event.id,
          createdAt: event.createdAt,
          expiresAt: event.expiresAt,
        },
      };
    }
  }

  /**
   * Check if a context key has recent events (duplicate check only, no creation)
   */
  async isDuplicate(
    eventKey: string,
    withinSeconds: number = DEDUPLICATION_WINDOW_SECONDS,
    sessionId?: string,
  ): Promise<boolean> {
    const normalizedKey = eventKey.trim();
    if (!normalizedKey) return false;

    try {
      const existingEvents = await systemEventsService.findByEventKey(
        normalizedKey,
        withinSeconds,
        sessionId,
      );

      return existingEvents.length > 0;
    } catch (error) {
      log.error({ err: error, eventKey: normalizedKey }, 'Error checking for duplicates');
      return false; // Fail open
    }
  }

  /**
   * Get the deduplication window in seconds
   */
  getDeduplicationWindow(): number {
    return DEDUPLICATION_WINDOW_SECONDS;
  }
}

// Singleton instance
export const notificationDeduplicator = new NotificationDeduplicator();
