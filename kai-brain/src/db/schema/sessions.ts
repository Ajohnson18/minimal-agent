import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const avaSessions = pgTable(
  'ava_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionKey: varchar('session_key', { length: 255 }),
    agentId: varchar('agent_id', { length: 100 }).default('main'),
    scope: varchar('scope', { length: 64 }).default('main'),
    userId: varchar('user_id', { length: 255 }).notNull(),
    title: varchar('title', { length: 500 }),
    // External ID for mapping external sources (e.g., Slack thread: "slack:channel:thread_ts")
    // Unique constraint to prevent duplicate sessions for same thread
    externalId: varchar('external_id', { length: 255 }).unique(),
    // Source of the session (e.g., "web", "slack", "cli")
    source: varchar('source', { length: 50 }).default('web').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    status: varchar('status', { length: 50 }).default('active').notNull(),
    lifecycleState: varchar('lifecycle_state', { length: 32 }).default('active').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    archivedByReason: text('archived_by_reason'),
    tokenCount: integer('token_count').default(0).notNull(),
    // Context summary from compacted messages (used as system context)
    contextSummary: text('context_summary'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    index('idx_ava_sessions_session_key').on(table.sessionKey),
    index('idx_ava_sessions_agent_scope').on(table.agentId, table.scope),
    index('idx_ava_sessions_user_id').on(table.userId),
    index('idx_ava_sessions_updated').on(table.updatedAt),
    index('idx_ava_sessions_status').on(table.status),
    index('idx_ava_sessions_lifecycle_state').on(table.lifecycleState),
    index('idx_ava_sessions_external_id').on(table.externalId),
  ]
);

export type AvaSession = typeof avaSessions.$inferSelect;
export type NewAvaSession = typeof avaSessions.$inferInsert;
