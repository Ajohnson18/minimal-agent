import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  jsonb,
  text,
  index,
} from "drizzle-orm/pg-core";

export const avaOutboundDeliveryJobs = pgTable(
  "ava_outbound_delivery_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: varchar("status", { length: 32 }).default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sessionId: varchar("session_id", { length: 255 }),
    routeSnapshot: jsonb("route_snapshot")
      .default({})
      .$type<Record<string, unknown>>()
      .notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    reason: varchar("reason", { length: 120 }),
    lastError: text("last_error"),
    providerMeta: jsonb("provider_meta")
      .default({})
      .$type<Record<string, unknown>>(),
    claimedBy: varchar("claimed_by", { length: 255 }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_outbound_jobs_status_next_attempt").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("idx_outbound_jobs_session_id").on(table.sessionId),
    index("idx_outbound_jobs_idempotency_key").on(table.idempotencyKey),
    index("idx_outbound_jobs_claim_expires_at").on(table.claimExpiresAt),
    index("idx_outbound_jobs_expires_at").on(table.expiresAt),
  ],
);

export type AvaOutboundDeliveryJob = typeof avaOutboundDeliveryJobs.$inferSelect;
export type NewAvaOutboundDeliveryJob = typeof avaOutboundDeliveryJobs.$inferInsert;
