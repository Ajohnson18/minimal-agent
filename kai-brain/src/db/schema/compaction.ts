import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { avaSessions } from './sessions.js';

export const avaCompactionHistory = pgTable(
  'ava_compaction_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => avaSessions.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    messagesCompacted: integer('messages_compacted').notNull(),
    tokensBefore: integer('tokens_before').notNull(),
    tokensAfter: integer('tokens_after').notNull(),
    firstMessageId: uuid('first_message_id'),
    lastMessageId: uuid('last_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_ava_compaction_session').on(table.sessionId),
  ]
);

export type AvaCompactionHistory = typeof avaCompactionHistory.$inferSelect;
export type NewAvaCompactionHistory = typeof avaCompactionHistory.$inferInsert;
