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
import { avaSessions } from './sessions.js';
import { avaMessages } from './messages.js';

export const avaToolExecutions = pgTable(
  'ava_tool_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => avaSessions.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => avaMessages.id, {
      onDelete: 'set null',
    }),
    userId: varchar('user_id', { length: 255 }).notNull(),
    toolName: varchar('tool_name', { length: 255 }).notNull(),
    toolInput: jsonb('tool_input').$type<Record<string, unknown>>(),
    toolOutput: jsonb('tool_output').$type<unknown>(),
    durationMs: integer('duration_ms'),
    status: varchar('status', { length: 50 }).notNull(), // success, error, timeout
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_ava_tool_exec_session').on(table.sessionId),
    index('idx_ava_tool_exec_user').on(table.userId),
    index('idx_ava_tool_exec_tool').on(table.toolName),
    index('idx_ava_tool_exec_created').on(table.createdAt),
  ]
);

export type AvaToolExecution = typeof avaToolExecutions.$inferSelect;
export type NewAvaToolExecution = typeof avaToolExecutions.$inferInsert;
