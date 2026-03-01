import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
} from "drizzle-orm/pg-core";

export const avaOutboundIdempotency = pgTable(
  "ava_outbound_idempotency",
  {
    idempotencyKey: varchar("idempotency_key", { length: 255 }).primaryKey(),
    state: varchar("state", { length: 32 }).default("pending").notNull(),
    deliveryJobId: varchar("delivery_job_id", { length: 255 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_ava_outbound_idempotency_expires_at").on(table.expiresAt),
    index("idx_ava_outbound_idempotency_state").on(table.state),
    index("idx_ava_outbound_idempotency_delivery_job_id").on(table.deliveryJobId),
  ],
);

export type AvaOutboundIdempotency = typeof avaOutboundIdempotency.$inferSelect;
export type NewAvaOutboundIdempotency = typeof avaOutboundIdempotency.$inferInsert;
