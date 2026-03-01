import { randomUUID } from "node:crypto";
import { db, pool } from "../../src/db/client.js";
import { avaSessions, type AvaSession } from "../../src/db/schema/sessions.js";
import { eq } from "drizzle-orm";

const REQUIRED_TABLES = [
  "ava_sessions",
  "ava_messages",
  "ava_queue",
  "ava_cron_jobs",
  "ava_system_events",
  "ava_outbound_delivery_jobs",
  "ava_outbound_idempotency",
  "ava_session_bindings",
  "ava_exec_approvals",
  "ava_exec_allowlist_entries",
  "ava_users",
  "ava_user_identities",
  "ava_memory",
  "ava_compaction_history",
];

const failOnSkip = process.env.AVA_FAIL_ON_SKIP === "1";

export function uniqueId(prefix = "test"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function isTestDatabaseReady(): Promise<boolean> {
  try {
    await pool.query("select 1");
    const result = await pool.query<{
      tablename: string;
    }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename = any($1)",
      [REQUIRED_TABLES],
    );
    const existing = new Set(result.rows.map((row) => row.tablename));
    const missing = REQUIRED_TABLES.filter((name) => !existing.has(name));
    if (missing.length > 0 && failOnSkip) {
      throw new Error(
        `Test database is missing required tables: ${missing.join(", ")}. Run pnpm db:push:ci.`,
      );
    }
    return missing.length === 0;
  } catch (error) {
    if (failOnSkip) {
      throw error;
    }
    return false;
  }
}

export async function createTestSession(overrides?: {
  userId?: string;
  title?: string;
  source?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}): Promise<AvaSession> {
  const [session] = await db
    .insert(avaSessions)
    .values({
      userId: overrides?.userId ?? uniqueId("user"),
      title: overrides?.title ?? "test-session",
      source: overrides?.source ?? "test",
      externalId: overrides?.externalId,
      status: "active",
      metadata: overrides?.metadata ?? {},
    })
    .returning();

  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(avaSessions).where(eq(avaSessions.id, sessionId));
}
