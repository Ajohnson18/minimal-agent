import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const avaHookExecutions = pgTable(
  'ava_hook_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phase: varchar('phase', { length: 120 }).notNull(),
    plugin: varchar('plugin', { length: 255 }).notNull(),
    priority: integer('priority').default(0).notNull(),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    latencyMs: integer('latency_ms').default(0).notNull(),
    sessionId: varchar('session_id', { length: 255 }),
    sessionKey: varchar('session_key', { length: 255 }),
    runId: varchar('run_id', { length: 255 }),
    error: text('error'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_hook_exec_phase_created').on(table.phase, table.createdAt),
    index('idx_hook_exec_session').on(table.sessionId, table.sessionKey),
    index('idx_hook_exec_plugin').on(table.plugin, table.createdAt),
  ],
);

export type AvaHookExecution = typeof avaHookExecutions.$inferSelect;
export type NewAvaHookExecution = typeof avaHookExecutions.$inferInsert;
