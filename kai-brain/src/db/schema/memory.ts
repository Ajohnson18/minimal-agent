import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  real,
  jsonb,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// Custom type for pgvector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // Parse [1,2,3] format
    return JSON.parse(value.replace(/^\[/, '[').replace(/\]$/, ']'));
  },
});

export const avaMemory = pgTable(
  'ava_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding'),
    source: varchar('source', { length: 100 }).notNull(), // conversation, note, fact
    sourceId: uuid('source_id'),
    importance: real('importance').default(0.5).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    accessedAt: timestamp('accessed_at', { withTimezone: true }),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  },
  (table) => [
    index('idx_ava_memory_user').on(table.userId),
    index('idx_ava_memory_importance').on(table.userId, table.importance),
    // Note: Vector index needs to be created separately with raw SQL
    // CREATE INDEX idx_ava_memory_embedding ON ava_memory
    //   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  ]
);

export type AvaMemory = typeof avaMemory.$inferSelect;
export type NewAvaMemory = typeof avaMemory.$inferInsert;
