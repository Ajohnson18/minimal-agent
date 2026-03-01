import { pgTable, varchar, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const kaiDashboardMetrics = pgTable("kai_dashboard_metrics", {
  id: varchar("id", { length: 255 }).primaryKey(),
  powerId: varchar("power_id", { length: 255 }).notNull(),
  powerName: varchar("power_name", { length: 255 }).notNull().default(""),
  key: varchar("key", { length: 255 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  value: text("value").notNull(),
  unit: varchar("unit", { length: 50 }),
  type: varchar("type", { length: 50 }).notNull().default("number"),
  icon: varchar("icon", { length: 50 }),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  lastRunId: varchar("last_run_id", { length: 255 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  powerKeyIdx: uniqueIndex("kai_dashboard_metrics_power_key_idx").on(table.powerId, table.key),
}));

export type KaiDashboardMetric = typeof kaiDashboardMetrics.$inferSelect;
