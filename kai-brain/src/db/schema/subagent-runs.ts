import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const avaSubagentRuns = pgTable(
  "ava_subagent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: varchar("run_id", { length: 128 }).notNull(),
    parentSessionId: varchar("parent_session_id", { length: 255 }).notNull(),
    parentSessionKey: varchar("parent_session_key", { length: 255 }),
    childSessionId: varchar("child_session_id", { length: 255 }),
    childSessionKey: varchar("child_session_key", { length: 255 }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    mode: varchar("mode", { length: 32 }).default("run").notNull(),
    task: text("task").notNull(),
    type: varchar("type", { length: 64 }).default("general").notNull(),
    depth: integer("depth").default(0).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    announceMode: varchar("announce_mode", { length: 16 }).default("full"),
    announceSummary: text("announce_summary"),
    result: text("result"),
    error: text("error"),
    toolsUsed: jsonb("tools_used").default([]).$type<string[]>().notNull(),
    deliveryContext: jsonb("delivery_context")
      .default({})
      .$type<Record<string, unknown>>(),
    requesterIsSubagent: boolean("requester_is_subagent")
      .default(false)
      .notNull(),
    announceTriggered: boolean("announce_triggered").default(false).notNull(),
    cleanupHandled: boolean("cleanup_handled").default(false).notNull(),
    cleanupCompletedAt: timestamp("cleanup_completed_at", { withTimezone: true }),
    announceRetryCount: integer("announce_retry_count").default(0).notNull(),
    lastAnnounceRetryAt: timestamp("last_announce_retry_at", {
      withTimezone: true,
    }),
    endedReason: varchar("ended_reason", { length: 128 }),
    suppressAnnounceReason: varchar("suppress_announce_reason", {
      length: 128,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("idx_subagent_runs_run_id").on(table.runId),
    index("idx_subagent_runs_parent_status").on(
      table.parentSessionId,
      table.status,
      table.startedAt,
    ),
    index("idx_subagent_runs_child").on(table.childSessionId),
    index("idx_subagent_runs_updated").on(table.updatedAt),
    index("idx_subagent_runs_parent_key").on(table.parentSessionKey),
  ],
);

export type AvaSubagentRun = typeof avaSubagentRuns.$inferSelect;
export type NewAvaSubagentRun = typeof avaSubagentRuns.$inferInsert;
