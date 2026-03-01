/**
 * Sessions Methods
 *
 * RPC handlers for session management.
 */
import { db } from "../../db/client.js";
import { avaSessions, avaMessages } from "../../db/schema/index.js";
import { eq, desc, sql, and } from "drizzle-orm";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import { createLogger } from "../../lib/logger.js";
import { deleteSessionAndTerminateWork } from "../services/session-lifecycle-guard.js";
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from "../services/session-identity.js";
import type {
  SessionsListParams,
  SessionsListResult,
  SessionsPreviewParams,
  SessionsPreviewResult,
  SessionsGetParams,
  SessionsGetResult,
  SessionsResetParams,
  SessionsResetResult,
  SessionsDeleteParams,
  SessionsDeleteResult,
  SessionInfo,
} from "../protocol/methods.js";
import { getSessionPreviewSnippet } from "./chat.js";

const log = createLogger("gateway", { method: "sessions" });

function resolveUserId(authUserId?: string, requestedUserId?: string): string | null {
  if (authUserId) {
    return authUserId;
  }
  return requestedUserId ?? null;
}

async function resolveRequestedSessionId(params: {
  sessionKey?: string;
  authUserId?: string;
}): Promise<{ sessionId: string; sessionKey: string } | null> {
  if (!params.sessionKey) {
    return null;
  }

  if (params.authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: params.authUserId,
      sessionKey: params.sessionKey,
    });
    return identity
      ? { sessionId: identity.sessionId, sessionKey: identity.sessionKey }
      : null;
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: params.sessionKey,
  });
  return identity
    ? { sessionId: identity.sessionId, sessionKey: identity.sessionKey }
    : null;
}

export async function sessionsList(
  params: SessionsListParams,
  authUserId?: string,
): Promise<SessionsListResult | RpcError> {
  const { userId: requestedUserId, source, limit = 50, offset = 0 } = params;
  const userId = resolveUserId(authUserId, requestedUserId);

  if (!userId) {
    return createError(ErrorCodes.UNAUTHORIZED, "userId is required");
  }

  try {
    // Build where conditions
    const conditions = [];
    conditions.push(eq(avaSessions.userId, userId));
    if (source) {
      conditions.push(eq(avaSessions.source, source));
    }

    // Get sessions with message count
    const sessionsQuery = db
      .select({
        id: avaSessions.id,
        userId: avaSessions.userId,
        source: avaSessions.source,
        title: avaSessions.title,
        status: avaSessions.status,
        tokenCount: avaSessions.tokenCount,
        createdAt: avaSessions.createdAt,
        lastMessageAt: avaSessions.lastMessageAt,
        messageCount: sql<number>`(
          SELECT COUNT(*) FROM ${avaMessages}
          WHERE ${avaMessages.sessionId} = ${avaSessions.id}
        )`.as("messageCount"),
      })
      .from(avaSessions)
      .orderBy(desc(avaSessions.lastMessageAt))
      .limit(limit)
      .offset(offset);

    const sessions =
      conditions.length > 0
        ? await sessionsQuery.where(and(...conditions))
        : await sessionsQuery;

    // Get total count
    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(avaSessions);

    const [{ count: total }] =
      conditions.length > 0
        ? await countQuery.where(and(...conditions))
        : await countQuery;

    const sessionInfosWithNulls = await Promise.all(
      sessions.map(async (s) => {
        const identity = await resolveGatewaySessionIdentity({ sessionId: s.id });
        if (!identity) {
          return null;
        }
        const info: SessionInfo = {
          sessionKey: identity.sessionKey,
          userId: s.userId,
          source: s.source,
          title: s.title ?? undefined,
          status: s.status,
          messageCount: Number(s.messageCount),
          tokenCount: s.tokenCount ?? undefined,
          createdAt: s.createdAt?.getTime() ?? Date.now(),
          lastMessageAt: s.lastMessageAt?.getTime(),
        };
        return info;
      }),
    );
    const sessionInfos = sessionInfosWithNulls.filter(
      (session): session is SessionInfo => session !== null,
    );

    return {
      sessions: sessionInfos,
      total: Number(total),
    };
  } catch (error) {
    log.error({ err: error }, "Failed to list sessions");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list sessions");
  }
}

export async function sessionsPreview(
  params: SessionsPreviewParams,
  authUserId?: string,
): Promise<SessionsPreviewResult | RpcError> {
  const userId = resolveUserId(authUserId, undefined);
  if (!userId) {
    return createError(ErrorCodes.UNAUTHORIZED, "userId is required");
  }

  const requestedKeys = (params.keys ?? [])
    .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    .map((key) => key.trim());
  const source = params.source?.trim();
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(200, Math.floor(params.limit as number)))
    : 50;

  try {
    const resolvedSessions = requestedKeys.length > 0
      ? await Promise.all(
          requestedKeys.map(async (sessionKey) => {
            const identity = await resolveGatewaySessionIdentityForUser({
              userId,
              sessionKey,
            });
            if (!identity) return null;
            const [session] = await db
              .select({
                id: avaSessions.id,
                title: avaSessions.title,
                source: avaSessions.source,
                status: avaSessions.status,
                lastMessageAt: avaSessions.lastMessageAt,
              })
              .from(avaSessions)
              .where(eq(avaSessions.id, identity.sessionId))
              .limit(1);
            if (!session) return null;
            return {
              sessionId: session.id,
              sessionKey: identity.sessionKey,
              title: session.title,
              source: session.source,
              status: session.status,
              lastMessageAt: session.lastMessageAt,
            };
          }),
        )
      : await db
          .select({
            id: avaSessions.id,
            title: avaSessions.title,
            source: avaSessions.source,
            status: avaSessions.status,
            lastMessageAt: avaSessions.lastMessageAt,
          })
          .from(avaSessions)
          .where(
            source
              ? and(eq(avaSessions.userId, userId), eq(avaSessions.source, source))
              : eq(avaSessions.userId, userId),
          )
          .orderBy(desc(avaSessions.lastMessageAt))
          .limit(limit)
          .then(async (sessions) =>
            Promise.all(
              sessions.map(async (session) => {
                const identity = await resolveGatewaySessionIdentity({
                  sessionId: session.id,
                });
                if (!identity) return null;
                return {
                  sessionId: session.id,
                  sessionKey: identity.sessionKey,
                  title: session.title,
                  source: session.source,
                  status: session.status,
                  lastMessageAt: session.lastMessageAt,
                };
              }),
            ),
          );

    const previews = await Promise.all(
      resolvedSessions
        .filter((row): row is NonNullable<(typeof resolvedSessions)[number]> => row !== null)
        .slice(0, limit)
        .map(async (row) => ({
          sessionKey: row.sessionKey,
          title: row.title ?? undefined,
          source: row.source,
          status: row.status,
          lastMessageAt: row.lastMessageAt?.getTime(),
          preview: await getSessionPreviewSnippet(row.sessionId),
        })),
    );

    return { previews };
  } catch (error) {
    log.error({ err: error, userId }, "Failed to preview sessions");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to preview sessions");
  }
}

export async function sessionsGet(
  params: SessionsGetParams,
  authUserId?: string,
): Promise<SessionsGetResult | RpcError> {
  const { sessionKey } = params;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveRequestedSessionId({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${sessionKey} not found`,
    );
  }

  try {
    const [session] = await db
      .select({
        id: avaSessions.id,
        userId: avaSessions.userId,
        source: avaSessions.source,
        externalId: avaSessions.externalId,
        title: avaSessions.title,
        status: avaSessions.status,
        tokenCount: avaSessions.tokenCount,
        createdAt: avaSessions.createdAt,
        lastMessageAt: avaSessions.lastMessageAt,
        messageCount: sql<number>`(
          SELECT COUNT(*) FROM ${avaMessages}
          WHERE ${avaMessages.sessionId} = ${avaSessions.id}
        )`.as("messageCount"),
      })
      .from(avaSessions)
      .where(
        eq(avaSessions.id, identity.sessionId),
      )
      .limit(1);

    if (!session) {
      return createError(
        ErrorCodes.NOT_FOUND,
        `Session ${identity.sessionId} not found`
      );
    }

    return {
      sessionKey: identity.sessionKey,
      userId: session.userId,
      source: session.source,
      externalId: session.externalId ?? undefined,
      title: session.title ?? undefined,
      status: session.status,
      messageCount: Number(session.messageCount),
      tokenCount: session.tokenCount ?? undefined,
      createdAt: session.createdAt?.getTime() ?? Date.now(),
      lastMessageAt: session.lastMessageAt?.getTime(),
    };
  } catch (error) {
    log.error({ err: error, sessionKey }, "Failed to get session");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to get session");
  }
}

export async function sessionsReset(
  params: SessionsResetParams,
  authUserId?: string,
): Promise<SessionsResetResult | RpcError> {
  const { sessionKey } = params;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveRequestedSessionId({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${sessionKey} not found`,
    );
  }

  try {
    // Check session exists
    const [session] = await db
      .select({ id: avaSessions.id })
      .from(avaSessions)
      .where(eq(avaSessions.id, identity.sessionId))
      .limit(1);

    if (!session) {
      return createError(
        ErrorCodes.NOT_FOUND,
        `Session ${identity.sessionId} not found`
      );
    }

    // Delete all messages for this session
    const result = await db
      .delete(avaMessages)
      .where(eq(avaMessages.sessionId, identity.sessionId));

    // Reset token count
    await db
      .update(avaSessions)
      .set({ tokenCount: 0, updatedAt: new Date() })
      .where(
        authUserId
          ? and(eq(avaSessions.id, identity.sessionId), eq(avaSessions.userId, authUserId))
          : eq(avaSessions.id, identity.sessionId),
      );

    return {
      reset: true,
      messagesDeleted: result.rowCount ?? 0,
    };
  } catch (error) {
    log.error({ err: error, sessionKey }, "Failed to reset session");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to reset session");
  }
}

export async function sessionsDelete(
  params: SessionsDeleteParams,
  authUserId?: string,
): Promise<SessionsDeleteResult | RpcError> {
  const { sessionKey } = params;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveRequestedSessionId({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${sessionKey} not found`,
    );
  }

  try {
    await deleteSessionAndTerminateWork(identity.sessionId, "gateway-sessions-delete");

    // Delete messages first (foreign key constraint)
    await db.delete(avaMessages).where(eq(avaMessages.sessionId, identity.sessionId));

    // Delete session
    const result = await db
      .delete(avaSessions)
      .where(eq(avaSessions.id, identity.sessionId));

    return {
      deleted: (result.rowCount ?? 0) > 0,
    };
  } catch (error) {
    log.error({ err: error, sessionKey }, "Failed to delete session");
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to delete session");
  }
}
