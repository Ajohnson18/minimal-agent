import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

export const avaSessionBindings = pgTable(
  "ava_session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: varchar("session_id", { length: 255 }).notNull(),
    sessionKey: varchar("session_key", { length: 255 }),
    channel: varchar("channel", { length: 50 }).notNull(),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    accountId: varchar("account_id", { length: 255 }),
    conversationId: varchar("conversation_id", { length: 255 }),
    threadId: varchar("thread_id", { length: 255 }),
    bindingKind: varchar("binding_kind", { length: 64 }).default("channel").notNull(),
    priority: integer("priority").default(0).notNull(),
    isPrimary: boolean("is_primary").default(true).notNull(),
    route: jsonb("route")
      .default({})
      .$type<Record<string, unknown>>()
      .notNull(),
    status: varchar("status", { length: 32 }).default("active").notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("idx_session_bindings_session_external").on(
      table.sessionId,
      table.externalId,
    ),
    index("idx_session_bindings_session_status").on(table.sessionId, table.status),
    index("idx_session_bindings_session_key_status").on(
      table.sessionKey,
      table.status,
      table.isPrimary,
      table.priority,
    ),
    index("idx_session_bindings_resolution").on(
      table.sessionKey,
      table.channel,
      table.accountId,
      table.conversationId,
      table.threadId,
    ),
    index("idx_session_bindings_channel_external").on(
      table.channel,
      table.externalId,
    ),
  ],
);

export type AvaSessionBinding = typeof avaSessionBindings.$inferSelect;
export type NewAvaSessionBinding = typeof avaSessionBindings.$inferInsert;
