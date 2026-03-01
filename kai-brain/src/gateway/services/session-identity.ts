import {
  sessionKeyResolverService,
  type SessionIdentity,
} from '../../services/session-key-resolver.service.js';

export interface ResolveGatewaySessionIdentityParams {
  sessionId?: string;
  sessionKey?: string;
}

export interface GatewaySessionIdentity {
  sessionId: string;
  sessionKey: string;
}

export async function resolveGatewaySessionIdentity(
  params: ResolveGatewaySessionIdentityParams,
): Promise<GatewaySessionIdentity | null> {
  const identity = await sessionKeyResolverService.resolveIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  if (!identity) return null;

  return {
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
  };
}

export async function resolveGatewaySessionIdentityForUser(params: {
  userId: string;
  sessionKey?: string;
}): Promise<SessionIdentity | null> {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) return null;
  return sessionKeyResolverService.resolveForUser({
    userId: params.userId,
    sessionKey: rawSessionKey,
  });
}
