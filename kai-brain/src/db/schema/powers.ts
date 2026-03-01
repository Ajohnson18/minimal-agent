import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

export interface PowerArtifactDeclaration {
  key: string;
  label: string;
  type: string;
}

export const kaiPowers = pgTable("kai_powers", {
  id: varchar("id", { length: 255 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull(),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  icon: varchar("icon", { length: 50 }).default("⚡").notNull(),
  category: varchar("category", { length: 100 }).default("general").notNull(),
  source: varchar("source", { length: 50 }).default("local").notNull(), // local, custom, community
  enabled: boolean("enabled").default(true).notNull(),
  dependsOn: jsonb("depends_on").default([]).$type<string[]>(),
  skills: jsonb("skills").default([]).$type<string[]>(),
  tools: jsonb("tools").default([]).$type<string[]>(),
  steps: jsonb("steps").default([]).$type<string[]>(),
  artifacts: jsonb("artifacts").default([]).$type<PowerArtifactDeclaration[]>(),
  output: text("output").default(""),
  prompt: text("prompt").default(""),
  refinements: text("refinements").default(""),
  previousPrompt: text("previous_prompt").default(""),
  locked: boolean("locked").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type KaiPower = typeof kaiPowers.$inferSelect;
