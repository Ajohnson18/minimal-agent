/**
 * Subscription Methods
 *
 * RPC handlers for event subscriptions.
 */
import { runtime } from '../runtime.js';
import { createError, ErrorCodes, type RpcError } from '../protocol/types.js';
import { wakeHeartbeat } from "../services/heartbeat.service.js";
import type {
  SubscribeParams,
  SubscribeResult,
  UnsubscribeParams,
  UnsubscribeResult,
} from '../protocol/methods.js';
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from '../services/session-identity.js';

async function resolveSubscriptionSessionId(params: {
  sessionKey?: string;
  authUserId?: string;
}): Promise<string | RpcError | null> {
  if (!params.sessionKey) return null;

  if (params.authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: params.authUserId,
      sessionKey: params.sessionKey,
    });
    if (!identity) {
      return createError(
        ErrorCodes.NOT_FOUND,
        `Session ${params.sessionKey} not found`,
      );
    }
    return identity.sessionId;
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: params.sessionKey,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${params.sessionKey} not found`,
    );
  }

  return identity.sessionId;
}

export async function subscribe(
  params: SubscribeParams,
  clientId: string,
  authUserId?: string,
): Promise<SubscribeResult | RpcError> {
  const { events, sessionKey } = params;
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (!events || !Array.isArray(events) || events.length === 0) {
    return createError(ErrorCodes.INVALID_PARAMS, 'events array is required');
  }
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      'sessionId is no longer accepted; use sessionKey',
    );
  }

  const resolvedSessionId = await resolveSubscriptionSessionId({
    sessionKey,
    authUserId,
  });

  if (resolvedSessionId && typeof resolvedSessionId !== 'string') {
    return resolvedSessionId;
  }

  const hadSubscribers =
    typeof resolvedSessionId === "string"
      ? runtime.hasSessionSubscribers(resolvedSessionId)
      : false;

  const subscribed = runtime.subscribe(
    clientId,
    events,
    typeof resolvedSessionId === 'string' ? resolvedSessionId : undefined,
  );

  if (
    typeof resolvedSessionId === "string" &&
    !hadSubscribers &&
    runtime.hasSessionSubscribers(resolvedSessionId)
  ) {
    wakeHeartbeat(resolvedSessionId, {
      kind: "manual",
      source: "runtime",
      metadata: { reason: "subscriber-attached" },
    });
  }

  return { subscribed };
}

export async function unsubscribe(
  params: UnsubscribeParams,
  clientId: string,
): Promise<UnsubscribeResult | RpcError> {
  const { events } = params;

  if (!events || !Array.isArray(events) || events.length === 0) {
    return createError(ErrorCodes.INVALID_PARAMS, 'events array is required');
  }

  const unsubscribed = runtime.unsubscribe(clientId, events);
  return { unsubscribed };
}
