import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Types ──────────────────────────────────────────────────────────

export type UserRole = "owner" | "admin" | "member";

export interface UserConfigOverrides {
  model?: { primary?: string; fallback?: string };
  timezone?: string;
  customInstructions?: string;
  toolPolicy?: {
    denied?: string[];
    allowed?: string[];
  };
  workspace?: string;
  slack?: { replyToMode?: string };
}

export interface CredentialUsageStats {
  lastUsed?: number;
  errorCount?: number;
  cooldownUntil?: number;
}

export interface UserCredentials {
  custom?: Array<{ key: string; value: string; description?: string }>;
  usageStats?: Record<string, CredentialUsageStats>;
}

// ── Tables ─────────────────────────────────────────────────────────

export const avaUsers = pgTable(
  "ava_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: varchar("display_name", { length: 255 }),
    role: varchar("role", { length: 50 })
      .default("member")
      .notNull()
      .$type<UserRole>(),
    config: jsonb("config").default({}).$type<UserConfigOverrides>(),
    credentials: text("credentials"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_ava_users_role").on(table.role)],
);

export const avaUserIdentities = pgTable(
  "ava_user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => avaUsers.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    metadata: jsonb("metadata").default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_identities_provider_external").on(
      table.provider,
      table.externalId,
    ),
    index("idx_user_identities_user").on(table.userId),
  ],
);

export type AvaUser = typeof avaUsers.$inferSelect;
export type NewAvaUser = typeof avaUsers.$inferInsert;
export type AvaUserIdentity = typeof avaUserIdentities.$inferSelect;
export type NewAvaUserIdentity = typeof avaUserIdentities.$inferInsert;
