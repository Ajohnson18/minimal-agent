import { and, eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client.js";
import { avaOutboundDeliveryJobs } from "../../src/db/schema/outbound-delivery-jobs.js";
import { avaOutboundIdempotency } from "../../src/db/schema/outbound-idempotency.js";
import { avaSystemEvents } from "../../src/db/schema/system-events.js";

export async function truncateReliabilityTables(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      ava_messages,
      ava_queue,
      ava_system_events,
      ava_outbound_delivery_jobs,
      ava_outbound_idempotency,
      ava_session_bindings,
      ava_sessions
    RESTART IDENTITY CASCADE
  `);
}

export async function listOutboundJobs(filters?: {
  sessionId?: string;
  idempotencyKey?: string;
}): Promise<Array<typeof avaOutboundDeliveryJobs.$inferSelect>> {
  const conditions = [];

  if (filters?.sessionId) {
    conditions.push(eq(avaOutboundDeliveryJobs.sessionId, filters.sessionId));
  }

  if (filters?.idempotencyKey) {
    conditions.push(
      eq(avaOutboundDeliveryJobs.idempotencyKey, filters.idempotencyKey),
    );
  }

  return db
    .select()
    .from(avaOutboundDeliveryJobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
}

export async function listIdempotencyRecords(filters?: {
  key?: string;
}): Promise<Array<typeof avaOutboundIdempotency.$inferSelect>> {
  const conditions = [];

  if (filters?.key) {
    conditions.push(eq(avaOutboundIdempotency.idempotencyKey, filters.key));
  }

  return db
    .select()
    .from(avaOutboundIdempotency)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
}

export async function listPendingSystemEvents(sessionId?: string): Promise<
  Array<typeof avaSystemEvents.$inferSelect>
> {
  const conditions = [eq(avaSystemEvents.processed, false)];

  if (sessionId) {
    conditions.push(eq(avaSystemEvents.sessionId, sessionId));
  }

  return db
    .select()
    .from(avaSystemEvents)
    .where(and(...conditions));
}
