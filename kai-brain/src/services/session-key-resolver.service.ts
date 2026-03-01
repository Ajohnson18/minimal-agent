import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { avaSessions } from '../db/schema/sessions.js';
import { createLogger } from '../lib/logger.js';
import { normalizeSessionKey, type SessionKey } from '../core/session-key.js';

const log = createLogger('agent');

export interface SessionIdentity {
  sessionId: string;
  sessionKey: SessionKey;
  userId: string;
  agentId: string;
  scope: string;
}

function normalizeToken(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return trimmed || fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function buildDeterministicSessionKey(params: {
  sessionId: string;
  agentId?: string;
  scope?: string;
}): SessionKey {
  const agentId = normalizeToken(params.agentId, 'main');
  const scope = normalizeToken(params.scope, 'main');
  const shortId = params.sessionId.slice(0, 12).toLowerCase();
  return normalizeSessionKey(`agent:${agentId}:${scope}:${shortId}`);
}

async function mapSessionRowToIdentity(
  sessionId: string,
  row: {
    sessionKey: string | null;
    userId: string;
    agentId: string | null;
    scope: string | null;
  },
): Promise<SessionIdentity> {
  const agentId = normalizeToken(row.agentId ?? undefined, 'main');
  const scope = normalizeToken(row.scope ?? undefined, 'main');

  if (row.sessionKey && row.sessionKey.trim().length > 0) {
    return {
      sessionId,
      sessionKey: normalizeSessionKey(row.sessionKey),
      userId: row.userId,
      agentId,
      scope,
    };
  }

  const generatedKey = buildDeterministicSessionKey({
    sessionId,
    agentId,
    scope,
  });

  await db
    .update(avaSessions)
    .set({
      sessionKey: generatedKey,
      agentId,
      scope,
      updatedAt: new Date(),
    })
    .where(eq(avaSessions.id, sessionId));

  return {
    sessionId,
    sessionKey: generatedKey,
    userId: row.userId,
    agentId,
    scope,
  };
}

export class SessionKeyResolverService {
  async resolveBySessionId(sessionId: string): Promise<SessionIdentity | null> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;
    if (!isUuid(normalizedSessionId)) return null;

    const [session] = await db
      .select({
        id: avaSessions.id,
        sessionKey: avaSessions.sessionKey,
        userId: avaSessions.userId,
        agentId: avaSessions.agentId,
        scope: avaSessions.scope,
      })
      .from(avaSessions)
      .where(eq(avaSessions.id, normalizedSessionId))
      .limit(1);

    if (!session) return null;

    return mapSessionRowToIdentity(normalizedSessionId, {
      sessionKey: session.sessionKey,
      userId: session.userId,
      agentId: session.agentId,
      scope: session.scope,
    });
  }

  async resolveBySessionKey(sessionKey: string): Promise<SessionIdentity | null> {
    const normalizedSessionKey = normalizeSessionKey(sessionKey);

    const [session] = await db
      .select({
        id: avaSessions.id,
        sessionKey: avaSessions.sessionKey,
        userId: avaSessions.userId,
        agentId: avaSessions.agentId,
        scope: avaSessions.scope,
      })
      .from(avaSessions)
      .where(eq(avaSessions.sessionKey, normalizedSessionKey))
      .limit(1);

    if (!session) {
      return null;
    }

    return mapSessionRowToIdentity(session.id, {
      sessionKey: session.sessionKey,
      userId: session.userId,
      agentId: session.agentId,
      scope: session.scope,
    });
  }

  async resolveIdentity(params: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<SessionIdentity | null> {
    const rawSessionId = params.sessionId?.trim();
    const rawSessionKey = params.sessionKey?.trim();

    if (rawSessionId) {
      const byId = await this.resolveBySessionId(rawSessionId);
      if (!byId) return null;

      if (rawSessionKey) {
        const normalizedInputKey = normalizeSessionKey(rawSessionKey);
        if (normalizedInputKey !== byId.sessionKey) {
          log.warn(
            {
              sessionId: rawSessionId,
              expected: byId.sessionKey,
              provided: normalizedInputKey,
            },
            'Session identity mismatch between sessionId and sessionKey',
          );
          return null;
        }
      }

      return byId;
    }

    if (rawSessionKey) {
      return this.resolveBySessionKey(rawSessionKey);
    }

    return null;
  }

  async bindSessionKey(params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    scope?: string;
  }): Promise<SessionIdentity | null> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) return null;

    const sessionKey = normalizeSessionKey(params.sessionKey);
    const agentId = normalizeToken(params.agentId, 'main');
    const scope = normalizeToken(params.scope, 'main');

    const [updated] = await db
      .update(avaSessions)
      .set({
        sessionKey,
        agentId,
        scope,
        updatedAt: new Date(),
      })
      .where(eq(avaSessions.id, sessionId))
      .returning({
        id: avaSessions.id,
        sessionKey: avaSessions.sessionKey,
        userId: avaSessions.userId,
        agentId: avaSessions.agentId,
        scope: avaSessions.scope,
      });

    if (!updated) return null;

    return {
      sessionId: updated.id,
      sessionKey,
      userId: updated.userId,
      agentId,
      scope,
    };
  }

  async backfillMissingSessionKeys(limit = 500): Promise<number> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 500;

    const rows = await db
      .select({
        id: avaSessions.id,
        userId: avaSessions.userId,
        sessionKey: avaSessions.sessionKey,
        agentId: avaSessions.agentId,
        scope: avaSessions.scope,
      })
      .from(avaSessions)
      .where(or(isNull(avaSessions.sessionKey), eq(avaSessions.sessionKey, '')))
      .limit(safeLimit);

    for (const row of rows) {
      const sessionKey = buildDeterministicSessionKey({
        sessionId: row.id,
        agentId: row.agentId ?? undefined,
        scope: row.scope ?? undefined,
      });

      await db
        .update(avaSessions)
        .set({
          sessionKey,
          agentId: normalizeToken(row.agentId ?? undefined, 'main'),
          scope: normalizeToken(row.scope ?? undefined, 'main'),
          updatedAt: new Date(),
        })
        .where(eq(avaSessions.id, row.id));
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, 'Backfilled missing session keys');
    }

    return rows.length;
  }

  async ensureBoundIdentity(params: {
    sessionId: string;
    preferredSessionKey?: string;
    agentId?: string;
    scope?: string;
  }): Promise<SessionIdentity | null> {
    const current = await this.resolveBySessionId(params.sessionId);
    if (!current) return null;

    if (params.preferredSessionKey) {
      const normalizedPreferred = normalizeSessionKey(params.preferredSessionKey);
      if (normalizedPreferred !== current.sessionKey) {
        return this.bindSessionKey({
          sessionId: current.sessionId,
          sessionKey: normalizedPreferred,
          agentId: params.agentId ?? current.agentId,
          scope: params.scope ?? current.scope,
        });
      }
    }

    return current;
  }

  async resolveForUser(params: {
    userId: string;
    sessionKey: string;
  }): Promise<SessionIdentity | null> {
    const normalizedSessionKey = normalizeSessionKey(params.sessionKey);
    const [session] = await db
      .select({
        id: avaSessions.id,
        sessionKey: avaSessions.sessionKey,
        userId: avaSessions.userId,
        agentId: avaSessions.agentId,
        scope: avaSessions.scope,
      })
      .from(avaSessions)
      .where(
        and(
          eq(avaSessions.userId, params.userId.trim()),
          eq(avaSessions.sessionKey, normalizedSessionKey),
        ),
      )
      .limit(1);

    if (!session) return null;

    return mapSessionRowToIdentity(session.id, {
      sessionKey: session.sessionKey,
      userId: session.userId,
      agentId: session.agentId,
      scope: session.scope,
    });
  }
}

export const sessionKeyResolverService = new SessionKeyResolverService();
