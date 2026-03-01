/**
 * Cron Schema
 *
 * Scheduled jobs for automated agent execution.
 */
import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { avaSessions } from "./sessions.js";

export const avaCronJobs = pgTable("ava_cron_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .references(() => avaSessions.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id").notNull(),

  // Job identity
  name: text("name").notNull(),
  description: text("description"),

  // Schedule configuration
  scheduleKind: text("schedule_kind").notNull(), // 'at' | 'every' | 'cron'
  scheduleValue: text("schedule_value").notNull(), // timestamp | ms interval | cron expr
  timezone: text("timezone").default("UTC"),

  // Payload
  payload: text("payload").notNull(), // Message to send to agent

  // State
  enabled: boolean("enabled").notNull().default(true),
  deleteAfterRun: boolean("delete_after_run").notNull().default(false), // For one-shot jobs

  // Execution tracking
  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: text("last_run_status"), // 'success' | 'error'
  lastRunError: text("last_run_error"),
  nextRunAt: timestamp("next_run_at"),
  runCount: text("run_count").default("0"),

  // Source tracking
  source: text("source").notNull().default("agent"), // 'agent' | 'api' | 'slack'
  sourceMetadata: jsonb("source_metadata"), // Channel-specific routing info

  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type CronJob = typeof avaCronJobs.$inferSelect;
export type NewCronJob = typeof avaCronJobs.$inferInsert;
