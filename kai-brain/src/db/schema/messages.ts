import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { avaSessions } from './sessions.js';

export const avaMessages = pgTable(
  'ava_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => avaSessions.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 50 }).notNull(), // user, assistant, system, tool
    content: text('content'),
    toolCalls: jsonb('tool_calls').$type<ToolCall[]>(),
    toolCallId: varchar('tool_call_id', { length: 255 }),
    name: varchar('name', { length: 255 }), // Tool name for tool messages
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    tokenCount: integer('token_count'),
    isCompacted: boolean('is_compacted').default(false).notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    index('idx_ava_messages_session').on(table.sessionId),
    index('idx_ava_messages_created').on(table.sessionId, table.createdAt),
    index('idx_ava_messages_role').on(table.sessionId, table.role),
  ]
);

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type AvaMessage = typeof avaMessages.$inferSelect;
export type NewAvaMessage = typeof avaMessages.$inferInsert;
