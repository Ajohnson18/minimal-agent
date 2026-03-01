import { pgTable, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import type { PowerResponse } from "../../powers/types.js";

export const kaiPowerRuns = pgTable("kai_power_runs", {
  id: varchar("id", { length: 255 }).primaryKey(),
  powerId: varchar("power_id", { length: 255 }).notNull(),
  powerName: varchar("power_name", { length: 255 }).notNull().default(""),
  runId: varchar("run_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
  result: jsonb("result").$type<PowerResponse | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type KaiPowerRun = typeof kaiPowerRuns.$inferSelect;
