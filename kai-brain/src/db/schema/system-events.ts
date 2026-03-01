import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  boolean,
} from 'drizzle-orm/pg-core';

export const avaSystemEvents = pgTable(
  'ava_system_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: varchar('session_id', { length: 255 }).notNull(),
    sessionKey: varchar('session_key', { length: 255 }),
    kind: varchar('kind', { length: 120 }),
    eventKey: varchar('event_key', { length: 500 }),
    payload: jsonb('payload').default({}).$type<Record<string, unknown>>(),
    lifecycleState: varchar('lifecycle_state', { length: 32 }).default('pending').notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    text: text('text').notNull(),
    contextKey: varchar('context_key', { length: 500 }),
    processed: boolean('processed').default(false).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    claimToken: varchar('claim_token', { length: 255 }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    index('idx_system_events_session_id').on(table.sessionId),
    index('idx_system_events_session_key').on(table.sessionKey),
    index('idx_system_events_kind').on(table.kind),
    index('idx_system_events_lifecycle').on(table.lifecycleState),
    index('idx_system_events_event_key').on(table.eventKey),
    index('idx_system_events_session_event_key').on(table.sessionId, table.eventKey),
    index('idx_system_events_context_key').on(table.contextKey),
    index('idx_system_events_processed').on(table.processed),
    index('idx_system_events_created_at').on(table.createdAt),
    index('idx_system_events_type').on(table.type),
    index('idx_system_events_claim_token').on(table.claimToken),
    index('idx_system_events_claim_expires_at').on(table.claimExpiresAt),
    index('idx_system_events_expires_at').on(table.expiresAt),
  ]
);

export type AvaSystemEvent = typeof avaSystemEvents.$inferSelect;
export type NewAvaSystemEvent = typeof avaSystemEvents.$inferInsert;
