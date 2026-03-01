import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { avaSessionBindings } from '../db/schema/session-bindings.js';
import { createLogger } from '../lib/logger.js';
import {
  sessionKeyResolverService,
  type SessionIdentity,
} from './session-key-resolver.service.js';

const log = createLogger('agent');

export interface SessionBindingRoute {
  channel: string;
  externalId: string;
  [key: string]: unknown;
}

function normalizeExternalId(externalId: string | undefined): string {
  return typeof externalId === 'string' ? externalId.trim() : '';
}

function normalizeChannel(channel: string | undefined): string {
  return typeof channel === 'string' ? channel.trim().toLowerCase() : '';
}

function getOptionalString(route: SessionBindingRoute, key: string): string | undefined {
  const raw = route[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveRouteFields(route: SessionBindingRoute): {
  accountId?: string;
  conversationId?: string;
  threadId?: string;
} {
  const accountId =
    getOptionalString(route, 'accountId') ?? getOptionalString(route, 'workspaceId');
  const conversationId =
    getOptionalString(route, 'conversationId') ??
    getOptionalString(route, 'channelId') ??
    getOptionalString(route, 'roomId');
  const threadId =
    getOptionalString(route, 'threadId') ??
    getOptionalString(route, 'threadTs') ??
    getOptionalString(route, 'thread_ts');

  return {
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

async function resolveIdentity(sessionId: string): Promise<SessionIdentity | null> {
  return sessionKeyResolverService.resolveBySessionId(sessionId);
}

export class SessionBindingService {
  async updateBindingFromInbound(
    sessionId: string,
    route: SessionBindingRoute,
  ): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    const externalId = normalizeExternalId(route.externalId);
    const channel = normalizeChannel(route.channel);
    if (!normalizedSessionId || !externalId || !channel) {
      return;
    }

    const identity = await resolveIdentity(normalizedSessionId);
    const sessionKey = identity?.sessionKey;

    const routeFields = resolveRouteFields(route);

    try {
      const now = new Date();

      await db
        .update(avaSessionBindings)
        .set({
          status: 'inactive',
          invalidatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(avaSessionBindings.sessionId, normalizedSessionId),
            eq(avaSessionBindings.status, 'active'),
            ne(avaSessionBindings.externalId, externalId),
          ),
        );

      await db
        .insert(avaSessionBindings)
        .values({
          sessionId: normalizedSessionId,
          ...(sessionKey ? { sessionKey } : {}),
          channel,
          externalId,
          ...routeFields,
          bindingKind: 'channel',
          priority: 0,
          isPrimary: true,
          route,
          status: 'active',
          boundAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [avaSessionBindings.sessionId, avaSessionBindings.externalId],
          set: {
            ...(sessionKey ? { sessionKey } : {}),
            channel,
            ...routeFields,
            route,
            status: 'active',
            isPrimary: true,
            priority: 0,
            updatedAt: now,
            invalidatedAt: null,
          },
        });
    } catch (error) {
      log.error(
        { err: error, sessionId: normalizedSessionId, externalId },
        'Failed to update session binding',
      );
    }
  }

  async resolveCurrentBinding(
    sessionId: string,
    options?: {
      accountId?: string;
    },
  ): Promise<SessionBindingRoute | null> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;
    const normalizedAccountId = options?.accountId?.trim();

    const identity = await resolveIdentity(normalizedSessionId);
    if (identity?.sessionKey) {
      const byKey = await this.resolveCurrentBindingBySessionKey(
        identity.sessionKey,
        normalizedAccountId ? { accountId: normalizedAccountId } : undefined,
      );
      if (byKey) return byKey;
    }

    try {
      const filters = [
        eq(avaSessionBindings.sessionId, normalizedSessionId),
        eq(avaSessionBindings.status, 'active'),
      ];
      if (normalizedAccountId) {
        filters.push(eq(avaSessionBindings.accountId, normalizedAccountId));
      }

      const [binding] = await db
        .select({ route: avaSessionBindings.route })
        .from(avaSessionBindings)
        .where(and(...filters))
        .orderBy(desc(avaSessionBindings.updatedAt))
        .limit(1);

      const route = binding?.route as SessionBindingRoute | undefined;
      if (!route) return null;

      const externalId = normalizeExternalId(route.externalId);
      const channel = normalizeChannel(route.channel);
      if (!externalId || !channel) {
        return null;
      }

      return {
        ...route,
        externalId,
        channel,
      };
    } catch (error) {
      log.error(
        { err: error, sessionId: normalizedSessionId },
        'Failed to resolve current session binding',
      );
      return null;
    }
  }

  async resolveCurrentBindingBySessionKey(
    sessionKey: string,
    options?: {
      accountId?: string;
    },
  ): Promise<SessionBindingRoute | null> {
    const identity = await sessionKeyResolverService.resolveBySessionKey(sessionKey);
    const normalizedSessionKey = identity?.sessionKey ?? sessionKey.trim();
    if (!normalizedSessionKey) return null;
    const normalizedAccountId = options?.accountId?.trim();

    try {
      const filters = [
        eq(avaSessionBindings.sessionKey, normalizedSessionKey),
        eq(avaSessionBindings.status, 'active'),
      ];
      if (normalizedAccountId) {
        filters.push(eq(avaSessionBindings.accountId, normalizedAccountId));
      }

      const [binding] = await db
        .select({ route: avaSessionBindings.route })
        .from(avaSessionBindings)
        .where(and(...filters))
        .orderBy(
          desc(avaSessionBindings.isPrimary),
          desc(avaSessionBindings.priority),
          desc(avaSessionBindings.updatedAt),
        )
        .limit(1);

      const route = binding?.route as SessionBindingRoute | undefined;
      if (!route) return null;

      const externalId = normalizeExternalId(route.externalId);
      const channel = normalizeChannel(route.channel);
      if (!externalId || !channel) return null;

      return {
        ...route,
        externalId,
        channel,
      };
    } catch (error) {
      log.error(
        { err: error, sessionKey: normalizedSessionKey },
        'Failed to resolve current session binding by session key',
      );
      return null;
    }
  }

  async invalidateBinding(sessionId: string): Promise<number> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return 0;

    try {
      const now = new Date();
      const updated = await db
        .update(avaSessionBindings)
        .set({
          status: 'inactive',
          invalidatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(avaSessionBindings.sessionId, normalizedSessionId),
            eq(avaSessionBindings.status, 'active'),
          ),
        )
        .returning({ id: avaSessionBindings.id });

      return updated.length;
    } catch (error) {
      log.error(
        { err: error, sessionId: normalizedSessionId },
        'Failed to invalidate session bindings',
      );
      return 0;
    }
  }
}

export const sessionBindingService = new SessionBindingService();
