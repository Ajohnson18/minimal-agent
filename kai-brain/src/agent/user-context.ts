import type {
  UserRole,
  UserConfigOverrides,
  UserCredentials,
} from "../db/schema/users.js";
import {
  resolveUser,
  getUserCredentials,
  getOwnerCredentials,
  mergeCredentials,
} from "../services/user.service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("user-context");

export interface UserContext {
  id: string;
  displayName: string | null;
  role: UserRole;
  config: UserConfigOverrides;
  credentials: UserCredentials | null;
  /** The raw external ID used to resolve this user (e.g. Slack user ID) */
  externalId: string;
  provider: string;
}

/**
 * Resolve an external identity into a full UserContext for the request lifecycle.
 * Creates the user on first interaction (lazy-init).
 * Non-owner users inherit the owner's credentials as a base layer,
 * with their own credentials taking precedence on key conflicts.
 */
export async function resolveUserContext(
  provider: string,
  externalId: string,
  displayName?: string,
): Promise<UserContext> {
  try {
    const user = await resolveUser(provider, externalId, displayName);
    const isOwner = user.role === "owner";

    const [userCreds, ownerCreds] = await Promise.all([
      getUserCredentials(user.id),
      isOwner ? Promise.resolve(null) : getOwnerCredentials(),
    ]);

    const credentials = isOwner ? userCreds : mergeCredentials(ownerCreds, userCreds);

    return {
      id: user.id,
      displayName: user.displayName,
      role: user.role as UserRole,
      config: (user.config as UserConfigOverrides) ?? {},
      credentials,
      externalId,
      provider,
    };
  } catch (err) {
    log.error({ err, provider, externalId }, "Failed to resolve user context, using fallback");
    return {
      id: externalId,
      displayName: displayName ?? null,
      role: "member",
      config: {},
      credentials: null,
      externalId,
      provider,
    };
  }
}
