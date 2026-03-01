/**
 * Event Cleanup Service
 *
 * Handles periodic cleanup of processed system events.
 */
import { systemEventsService } from './system-events.service.js';
import { createLogger } from '../lib/logger.js';
import { outboundIdempotencyService } from './outbound-idempotency.service.js';
import { outboundDeliveryQueueService } from './outbound-delivery-queue.service.js';

const log = createLogger('agent');

export class EventCleanupService {
  /**
   * Run cleanup of old events (should be called periodically)
   */
  async runCleanup(): Promise<number> {
    try {
      const [
        deletedProcessedEvents,
        droppedExpiredEvents,
        deletedIdempotency,
        droppedExpiredOutboundJobs,
      ] = await Promise.all([
        systemEventsService.cleanupOldEvents(),
        systemEventsService.dropExpiredEvents(),
        outboundIdempotencyService.cleanupExpired(),
        outboundDeliveryQueueService.dropExpiredJobs(),
      ]);

      const deleted =
        deletedProcessedEvents +
        droppedExpiredEvents +
        deletedIdempotency +
        droppedExpiredOutboundJobs;

      if (deleted > 0) {
        log.info(
          {
            deletedProcessedEvents,
            droppedExpiredEvents,
            deletedIdempotency,
            droppedExpiredOutboundJobs,
          },
          'Cleaned up stale async state',
        );
      }

      return deleted;
    } catch (error) {
      log.error({ err: error }, 'Failed to run event cleanup');
      return 0;
    }
  }
}

// Singleton instance
export const eventCleanupService = new EventCleanupService();

// Start periodic cleanup (every 6 hours)
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let cleanupInterval: NodeJS.Timeout | null = null;

export function startEventCleanup(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    void eventCleanupService.runCleanup();
  }, CLEANUP_INTERVAL_MS);

  cleanupInterval.unref();

  log.info({ intervalMs: CLEANUP_INTERVAL_MS }, 'Event cleanup scheduler started');
}

export function stopEventCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.info('Event cleanup scheduler stopped');
  }
}
