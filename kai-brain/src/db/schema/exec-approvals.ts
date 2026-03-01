import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type ExecApprovalStatus =
  | "pending"
  | "resolved"
  | "expired"
  | "error";

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export const avaExecApprovals = pgTable(
  "ava_exec_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: varchar("session_id", { length: 255 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    agentId: varchar("agent_id", { length: 100 }).default("main").notNull(),
    command: text("command").notNull(),
    cwd: text("cwd"),
    host: varchar("host", { length: 32 }).notNull(),
    security: varchar("security", { length: 32 }).notNull(),
    ask: varchar("ask", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 })
      .default("pending")
      .notNull()
      .$type<ExecApprovalStatus>(),
    decision: varchar("decision", { length: 32 }).$type<ExecApprovalDecision>(),
    reason: text("reason"),
    resolvedBy: varchar("resolved_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_exec_approvals_status").on(table.status),
    index("idx_exec_approvals_session_id").on(table.sessionId),
    index("idx_exec_approvals_expires_at").on(table.expiresAt),
    index("idx_exec_approvals_user_agent").on(table.userId, table.agentId),
  ],
);

export const avaExecAllowlistEntries = pgTable(
  "ava_exec_allowlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    agentId: varchar("agent_id", { length: 100 }).default("main").notNull(),
    pattern: text("pattern").notNull(),
    createdByApprovalId: uuid("created_by_approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedCommand: text("last_used_command"),
    lastResolvedPath: text("last_resolved_path"),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("idx_exec_allowlist_unique").on(
      table.userId,
      table.agentId,
      table.pattern,
    ),
    index("idx_exec_allowlist_user_agent").on(table.userId, table.agentId),
    index("idx_exec_allowlist_created_by").on(table.createdByApprovalId),
  ],
);

export type AvaExecApproval = typeof avaExecApprovals.$inferSelect;
export type NewAvaExecApproval = typeof avaExecApprovals.$inferInsert;
export type AvaExecAllowlistEntry = typeof avaExecAllowlistEntries.$inferSelect;
export type NewAvaExecAllowlistEntry = typeof avaExecAllowlistEntries.$inferInsert;
