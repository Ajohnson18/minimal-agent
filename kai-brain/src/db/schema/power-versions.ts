import { pgTable, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const kaiPowerVersions = pgTable("kai_power_versions", {
  id: varchar("id", { length: 255 }).primaryKey(),
  powerId: varchar("power_id", { length: 255 }).notNull(),
  prompt: text("prompt").notNull(),
  changeNote: varchar("change_note", { length: 500 }).default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type KaiPowerVersion = typeof kaiPowerVersions.$inferSelect;
