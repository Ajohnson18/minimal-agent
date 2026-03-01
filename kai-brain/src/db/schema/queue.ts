/**
 * Queue Schema
 *
 * Persistent queue for agent execution requests.
 * Survives server restarts and allows for crash recovery.
 */
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { avaSessions } from "./sessions.js";

export const avaQueue = pgTable("ava_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .references(() => avaSessions.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id").notNull(),

  // Message content
  message: text("message").notNull(),

  // Queue management
  status: text("status").notNull().default("pending"), // pending, processing, completed, error, cancelled
  priority: integer("priority").notNull().default(0), // Higher = more urgent
  runId: text("run_id"), // Associated agent run ID

  // Queue mode context
  mode: text("mode").notNull().default("followup"), // steer, followup, collect, interrupt
  batchId: text("batch_id"), // For grouping collected messages

  // Source tracking (for routing responses)
  source: text("source").notNull().default("api"), // slack, api, cron, etc.
  sourceMetadata: jsonb("source_metadata"), // Channel-specific routing info

  // Result (for completed items)
  result: text("result"),
  error: text("error"),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export type QueueItem = typeof avaQueue.$inferSelect;
export type NewQueueItem = typeof avaQueue.$inferInsert;
