/**
 * Queue Service
 *
 * Manages message queuing for agent execution.
 * Supports multiple queue modes.
 */
import { db } from "../../db/client.js";
import { avaQueue, type QueueItem } from "../../db/schema/queue.js";
import { eq, and, asc, desc, sql } from "drizzle-orm";

export type { QueueItem } from "../../db/schema/queue.js";

export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "interrupt"
  | "isolated";

export interface QueueOptions {
  mode?: QueueMode;
  priority?: number;
  source?: string;
  sourceMetadata?: Record<string, unknown>;
  batchId?: string;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  error: number;
}

class QueueService {
  // In-memory tracking of processing items (for quick lookup)
  private processing = new Map<string, QueueItem>();

  // Debounce timers for collect mode
  private collectTimers = new Map<string, NodeJS.Timeout>();
  private readonly COLLECT_DEBOUNCE_MS = 2000;

  /**
   * Add a message to the queue for a session
   */
  async enqueue(
    sessionId: string,
    userId: string,
    message: string,
    options: QueueOptions = {}
  ): Promise<QueueItem> {
    const { mode = "followup", batchId } = options;

    // Handle interrupt mode - cancel pending items
    if (mode === "interrupt") {
      await this.cancelPending(sessionId);
    }

    // For steer mode, only queue if there's already something processing
    if (mode === "steer") {
      const isProcessing = await this.isSessionProcessing(sessionId);
      if (!isProcessing) {
        // Process immediately (don't queue)
        return this.createItem(sessionId, userId, message, {
          ...options,
          status: "pending",
        });
      }
    }

    // For collect mode, batch messages together
    if (mode === "collect") {
      const effectiveBatchId = batchId || `batch:${sessionId}:${Date.now()}`;

      // Clear existing debounce timer
      const existingTimer = this.collectTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Add to batch
      const item = await this.createItem(sessionId, userId, message, {
        ...options,
        batchId: effectiveBatchId,
        status: "pending",
      });

      // Set new debounce timer
      this.collectTimers.set(
        sessionId,
        setTimeout(() => {
          this.collectTimers.delete(sessionId);
          // Batch will be processed by the next dequeue call
        }, this.COLLECT_DEBOUNCE_MS)
      );

      return item;
    }

    // Default: add to queue
    const item = await this.createItem(sessionId, userId, message, {
      ...options,
      status: "pending",
    });
    // Notify processor to drain immediately (event-driven, no polling)
    this.onEnqueue?.();
    return item;
  }

  /** Callback for event-driven drain (set by queue processor). */
  onEnqueue?: () => void;

  /**
   * Get the next item to process for a session
   */
  async dequeue(sessionId: string): Promise<QueueItem | null> {
    // Check if already processing
    if (await this.isSessionProcessing(sessionId)) {
      return null;
    }

    // Check for collect mode debounce
    if (this.collectTimers.has(sessionId)) {
      return null;
    }

    // Get next pending item (or batch of items for collect mode)
    const [nextItem] = await db
      .select()
      .from(avaQueue)
      .where(
        and(eq(avaQueue.sessionId, sessionId), eq(avaQueue.status, "pending"))
      )
      .orderBy(desc(avaQueue.priority), asc(avaQueue.createdAt))
      .limit(1);

    if (!nextItem) {
      return null;
    }

    // Check if this is part of a collect batch
    if (nextItem.batchId) {
      return this.dequeueBatch(nextItem.batchId);
    }

    // Mark as processing
    const [updated] = await db
      .update(avaQueue)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(avaQueue.id, nextItem.id))
      .returning();

    if (updated) {
      this.processing.set(updated.id, updated);
    }

    return updated || null;
  }

  /**
   * Dequeue a batch of collected messages
   */
  private async dequeueBatch(batchId: string): Promise<QueueItem | null> {
    // Get all messages in the batch
    const batchItems = await db
      .select()
      .from(avaQueue)
      .where(and(eq(avaQueue.batchId, batchId), eq(avaQueue.status, "pending")))
      .orderBy(asc(avaQueue.createdAt));

    if (batchItems.length === 0) {
      return null;
    }

    // Combine messages
    const combinedMessage =
      batchItems.length === 1
        ? batchItems[0].message
        : `Multiple messages received:\n\n${batchItems
            .map((item, i) => `${i + 1}. ${item.message}`)
            .join("\n\n")}`;

    // Mark all as processing
    await db
      .update(avaQueue)
      .set({ status: "processing", startedAt: new Date() })
      .where(
        and(eq(avaQueue.batchId, batchId), eq(avaQueue.status, "pending"))
      );

    // Return the first item with combined message
    const item: QueueItem = {
      ...batchItems[0],
      message: combinedMessage,
      status: "processing",
      startedAt: new Date(),
    };

    this.processing.set(item.id, item);
    return item;
  }

  /**
   * Mark a queue item as completed
   */
  async complete(
    itemId: string,
    result?: string,
    runId?: string
  ): Promise<void> {
    await db
      .update(avaQueue)
      .set({
        status: "completed",
        result,
        runId,
        completedAt: new Date(),
      })
      .where(eq(avaQueue.id, itemId));

    this.processing.delete(itemId);

    // Also complete batch items if applicable
    const item = await this.getItem(itemId);
    if (item?.batchId) {
      await db
        .update(avaQueue)
        .set({
          status: "completed",
          result,
          runId,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(avaQueue.batchId, item.batchId),
            eq(avaQueue.status, "processing")
          )
        );
    }
  }

  /**
   * Mark a queue item as failed
   */
  async fail(itemId: string, error: string): Promise<void> {
    await db
      .update(avaQueue)
      .set({
        status: "error",
        error,
        completedAt: new Date(),
      })
      .where(eq(avaQueue.id, itemId));

    this.processing.delete(itemId);

    // Also fail batch items if applicable
    const item = await this.getItem(itemId);
    if (item?.batchId) {
      await db
        .update(avaQueue)
        .set({
          status: "error",
          error,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(avaQueue.batchId, item.batchId),
            eq(avaQueue.status, "processing")
          )
        );
    }
  }

  /**
   * Cancel pending items for a session
   */
  async cancelPending(sessionId: string): Promise<number> {
    const result = await db
      .update(avaQueue)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(eq(avaQueue.sessionId, sessionId), eq(avaQueue.status, "pending"))
      );

    return result.rowCount ?? 0;
  }

  /**
   * Check if a session has items being processed
   */
  async isSessionProcessing(sessionId: string): Promise<boolean> {
    // Quick check in memory first
    for (const item of this.processing.values()) {
      if (item.sessionId === sessionId) {
        return true;
      }
    }

    // Check database
    const [processing] = await db
      .select({ id: avaQueue.id })
      .from(avaQueue)
      .where(
        and(
          eq(avaQueue.sessionId, sessionId),
          eq(avaQueue.status, "processing")
        )
      )
      .limit(1);

    return !!processing;
  }

  /**
   * Get queue stats for a session
   */
  async getStats(sessionId?: string, userId?: string): Promise<QueueStats> {
    const conditions = [];
    if (sessionId) {
      conditions.push(eq(avaQueue.sessionId, sessionId));
    }
    if (userId) {
      conditions.push(eq(avaQueue.userId, userId));
    }

    const result = await db
      .select({
        status: avaQueue.status,
        count: sql<number>`count(*)`,
      })
      .from(avaQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(avaQueue.status);

    const stats: QueueStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      error: 0,
    };

    for (const row of result) {
      if (row.status in stats) {
        stats[row.status as keyof QueueStats] = Number(row.count);
      }
    }

    return stats;
  }

  /**
   * Get a queue item by ID
   */
  async getItem(itemId: string): Promise<QueueItem | null> {
    const [item] = await db
      .select()
      .from(avaQueue)
      .where(eq(avaQueue.id, itemId))
      .limit(1);

    return item || null;
  }

  /**
   * Get pending items for a session
   */
  async getPending(sessionId: string): Promise<QueueItem[]> {
    return db
      .select()
      .from(avaQueue)
      .where(
        and(eq(avaQueue.sessionId, sessionId), eq(avaQueue.status, "pending"))
      )
      .orderBy(desc(avaQueue.priority), asc(avaQueue.createdAt));
  }

  /**
   * Clean up old completed/error items (older than 24 hours)
   */
  async cleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db
      .delete(avaQueue)
      .where(
        and(
          sql`${avaQueue.status} IN ('completed', 'error', 'cancelled')`,
          sql`${avaQueue.completedAt} < ${cutoff}`
        )
      );

    return result.rowCount ?? 0;
  }

  /**
   * Recover stuck processing items on startup
   */
  async recoverStuck(): Promise<number> {
    // Items processing for more than 5 minutes are considered stuck
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);

    const result = await db
      .update(avaQueue)
      .set({ status: "pending", startedAt: null })
      .where(
        and(
          eq(avaQueue.status, "processing"),
          sql`${avaQueue.startedAt} < ${cutoff}`
        )
      );

    return result.rowCount ?? 0;
  }

  /**
   * Test-only reset for in-memory queue state.
   */
  resetForTests(): void {
    for (const timer of this.collectTimers.values()) {
      clearTimeout(timer);
    }
    this.collectTimers.clear();
    this.processing.clear();
    this.onEnqueue = undefined;
  }

  private async createItem(
    sessionId: string,
    userId: string,
    message: string,
    options: QueueOptions & { status?: string }
  ): Promise<QueueItem> {
    const [item] = await db
      .insert(avaQueue)
      .values({
        sessionId,
        userId,
        message,
        status: options.status || "pending",
        mode: options.mode || "followup",
        priority: options.priority || 0,
        source: options.source || "api",
        sourceMetadata: options.sourceMetadata,
        batchId: options.batchId,
      })
      .returning();

    return item;
  }
}

export const queueService = new QueueService();
