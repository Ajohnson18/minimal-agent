import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const kaiSettings = pgTable("kai_settings", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const kaiOnboarding = pgTable("kai_onboarding", {
  id: uuid("id").primaryKey().defaultRandom(),
  step: integer("step").notNull(),
  questionKey: varchar("question_key", { length: 255 }).notNull().unique(),
  label: text("label").notNull(),
  description: text("description"),
  inputType: varchar("input_type", { length: 50 }).default("text").notNull(),
  options: text("options"),
  answer: text("answer"),
  required: boolean("required").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const kaiSkillTreeNodes = pgTable("kai_skill_tree_nodes", {
  id: varchar("id", { length: 255 }).primaryKey(),
  label: varchar("label", { length: 255 }).notNull(),
  description: text("description").notNull(),
  nodeType: varchar("node_type", { length: 50 }).notNull(), // brain, branch, integration, skill
  status: varchar("status", { length: 50 }).default("locked").notNull(), // locked, available, active
  branch: varchar("branch", { length: 100 }),
  parentId: varchar("parent_id", { length: 255 }),
  credentialKey: varchar("credential_key", { length: 255 }),
  requiresIntegration: varchar("requires_integration", { length: 255 }),
  tools: jsonb("tools").default([]).$type<Array<{ name: string; description: string }>>(),
  setupTasks: jsonb("setup_tasks").default([]).$type<Array<{ id: string; label: string; detectKey?: string; completed: boolean }>>(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type KaiSetting = typeof kaiSettings.$inferSelect;
export type KaiOnboardingQuestion = typeof kaiOnboarding.$inferSelect;
export type KaiSkillTreeNode = typeof kaiSkillTreeNodes.$inferSelect;
