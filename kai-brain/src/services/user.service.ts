import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  avaUsers,
  avaUserIdentities,
  type AvaUser,
  type UserRole,
  type UserConfigOverrides,
  type UserCredentials,
} from "../db/schema/users.js";
import { encryptCredentials, decryptCredentials } from "./credential-vault.js";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("user-service");

// ── Resolution (provider + externalId -> AvaUser) ──────────────────

/**
 * Resolve an external identity to an AVA user. Creates the user + identity
 * on first interaction (lazy-init). The first user ever (or AVA_OWNER_SLACK_ID)
 * is automatically assigned the `owner` role.
 */
export async function resolveUser(
  provider: string,
  externalId: string,
  displayName?: string,
): Promise<AvaUser> {
  const existing = await db
    .select({ user: avaUsers })
    .from(avaUserIdentities)
    .innerJoin(avaUsers, eq(avaUserIdentities.userId, avaUsers.id))
    .where(
      and(
        eq(avaUserIdentities.provider, provider),
        eq(avaUserIdentities.externalId, externalId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const user = existing[0].user;
    if (displayName && !user.displayName) {
      await db
        .update(avaUsers)
        .set({ displayName })
        .where(eq(avaUsers.id, user.id));
      user.displayName = displayName;
    }
    return user;
  }

  return createUserWithIdentity(provider, externalId, displayName);
}

async function createUserWithIdentity(
  provider: string,
  externalId: string,
  displayName?: string,
): Promise<AvaUser> {
  const role = await determineInitialRole(provider, externalId);

  const [user] = await db
    .insert(avaUsers)
    .values({
      displayName: displayName ?? null,
      role,
      config: {},
    })
    .returning();

  await db.insert(avaUserIdentities).values({
    userId: user.id,
    provider,
    externalId,
  });

  log.info({ userId: user.id, provider, externalId, role }, "Created new user");
  return user;
}

async function determineInitialRole(
  provider: string,
  externalId: string,
): Promise<UserRole> {
  if (
    env.AVA_OWNER_SLACK_ID &&
    provider === "slack" &&
    externalId === env.AVA_OWNER_SLACK_ID
  ) {
    return "owner";
  }

  const existingOwner = await db
    .select({ id: avaUsers.id })
    .from(avaUsers)
    .where(eq(avaUsers.role, "owner"))
    .limit(1);

  if (existingOwner.length === 0) return "owner";
  return "member";
}

// ── Identity linking ───────────────────────────────────────────────

export async function linkIdentity(
  userId: string,
  provider: string,
  externalId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(avaUserIdentities)
    .values({ userId, provider, externalId, metadata: metadata ?? {} })
    .onConflictDoUpdate({
      target: [avaUserIdentities.provider, avaUserIdentities.externalId],
      set: { userId, metadata: metadata ?? {} },
    });
}

export async function getUserIdentities(userId: string) {
  return db
    .select()
    .from(avaUserIdentities)
    .where(eq(avaUserIdentities.userId, userId));
}

export async function unlinkIdentity(
  userId: string,
  provider: string,
  externalId: string,
): Promise<boolean> {
  const result = await db
    .delete(avaUserIdentities)
    .where(
      and(
        eq(avaUserIdentities.userId, userId),
        eq(avaUserIdentities.provider, provider),
        eq(avaUserIdentities.externalId, externalId),
      ),
    )
    .returning();
  return result.length > 0;
}

// ── Role management ────────────────────────────────────────────────

export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<AvaUser | null> {
  const [updated] = await db
    .update(avaUsers)
    .set({ role, updatedAt: new Date() })
    .where(eq(avaUsers.id, userId))
    .returning();
  return updated ?? null;
}

// ── Config management ──────────────────────────────────────────────

export async function getUserConfig(
  userId: string,
): Promise<UserConfigOverrides> {
  const [user] = await db
    .select({ config: avaUsers.config })
    .from(avaUsers)
    .where(eq(avaUsers.id, userId))
    .limit(1);
  return (user?.config as UserConfigOverrides) ?? {};
}

export async function updateUserConfig(
  userId: string,
  patch: Partial<UserConfigOverrides>,
): Promise<void> {
  const current = await getUserConfig(userId);
  const merged = { ...current, ...patch };
  await db
    .update(avaUsers)
    .set({ config: merged, updatedAt: new Date() })
    .where(eq(avaUsers.id, userId));
}

// ── Credential management ──────────────────────────────────────────

export async function getUserCredentials(
  userId: string,
): Promise<UserCredentials | null> {
  const [user] = await db
    .select({ credentials: avaUsers.credentials })
    .from(avaUsers)
    .where(eq(avaUsers.id, userId))
    .limit(1);
  return decryptCredentials<UserCredentials>(user?.credentials);
}

let _ownerCredsCache: { creds: UserCredentials | null; expiresAt: number } | null = null;
const OWNER_CREDS_TTL_MS = 60_000;

export async function getOwnerCredentials(): Promise<UserCredentials | null> {
  if (_ownerCredsCache && Date.now() < _ownerCredsCache.expiresAt) {
    return _ownerCredsCache.creds;
  }
  const [owner] = await db
    .select({ id: avaUsers.id, credentials: avaUsers.credentials })
    .from(avaUsers)
    .where(eq(avaUsers.role, "owner"))
    .limit(1);
  if (!owner) return null;
  const creds = decryptCredentials<UserCredentials>(owner.credentials);
  _ownerCredsCache = { creds, expiresAt: Date.now() + OWNER_CREDS_TTL_MS };
  return creds;
}

export function invalidateOwnerCredsCache(): void {
  _ownerCredsCache = null;
}

export function mergeCredentials(
  base: UserCredentials | null,
  overlay: UserCredentials | null,
): UserCredentials | null {
  if (!base && !overlay) return null;
  const baseCustom = base?.custom ?? [];
  const overlayCustom = overlay?.custom ?? [];
  if (baseCustom.length === 0 && overlayCustom.length === 0) {
    return overlay ?? base;
  }
  const merged = new Map(baseCustom.map((c) => [c.key, c]));
  for (const c of overlayCustom) {
    merged.set(c.key, c);
  }
  return {
    ...base,
    ...overlay,
    custom: Array.from(merged.values()),
  };
}

export async function setUserCredentials(
  userId: string,
  credentials: UserCredentials,
): Promise<void> {
  const encrypted = encryptCredentials(credentials);
  await db
    .update(avaUsers)
    .set({ credentials: encrypted, updatedAt: new Date() })
    .where(eq(avaUsers.id, userId));
  invalidateOwnerCredsCache();
}

export async function setCredentialKey(
  userId: string,
  key: string,
  value: string,
): Promise<void> {
  const current = (await getUserCredentials(userId)) ?? {};
  if (!current.custom) current.custom = [];

  const idx = current.custom.findIndex((c) => c.key === key);
  if (idx >= 0) {
    current.custom[idx].value = value;
  } else {
    current.custom.push({ key, value });
  }
  await setUserCredentials(userId, current);
}

export async function deleteCredentialKey(
  userId: string,
  key: string,
): Promise<boolean> {
  const current = (await getUserCredentials(userId)) ?? {};
  if (!current.custom) return false;
  const before = current.custom.length;
  current.custom = current.custom.filter((c) => c.key !== key);
  if (current.custom.length === before) return false;
  await setUserCredentials(userId, current);
  return true;
}

export async function listCredentialKeys(
  userId: string,
): Promise<string[]> {
  const creds = await getUserCredentials(userId);
  if (!creds) return [];
  return (creds.custom ?? []).map((c) => c.key);
}

// ── Listing ────────────────────────────────────────────────────────

export async function listUsers(): Promise<
  Array<{ id: string; displayName: string | null; role: UserRole }>
> {
  const rows = await db
    .select({
      id: avaUsers.id,
      displayName: avaUsers.displayName,
      role: avaUsers.role,
    })
    .from(avaUsers)
    .orderBy(avaUsers.createdAt);
  return rows as Array<{ id: string; displayName: string | null; role: UserRole }>;
}

export async function getUserById(userId: string): Promise<AvaUser | null> {
  const [user] = await db
    .select()
    .from(avaUsers)
    .where(eq(avaUsers.id, userId))
    .limit(1);
  return user ?? null;
}

/**
 * Look up a user by a linked Slack ID. Useful for resolving @mentions in commands.
 */
export async function getUserBySlackId(
  slackId: string,
): Promise<AvaUser | null> {
  const rows = await db
    .select({ user: avaUsers })
    .from(avaUserIdentities)
    .innerJoin(avaUsers, eq(avaUserIdentities.userId, avaUsers.id))
    .where(
      and(
        eq(avaUserIdentities.provider, "slack"),
        eq(avaUserIdentities.externalId, slackId),
      ),
    )
    .limit(1);
  return rows[0]?.user ?? null;
}
