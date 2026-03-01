import type { IncomingMessage } from "node:http";
import { getConfig } from "../lib/config-loader.js";
import { verifyJwt, JwtVerificationError, type AuthContext } from "../lib/auth/jwt.js";
import { extractWsToken } from "../lib/auth/token-extract.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("gateway", { component: "ws-auth" });

export type WsAuthResult =
  | { ok: true; auth?: AuthContext }
  | { ok: false; reason: string };

export function authenticateGatewayRequest(request: IncomingMessage): WsAuthResult {
  const authConfig = getConfig().server.auth;
  const token = extractWsToken(request, {
    allowQueryToken: authConfig.wsAllowQueryToken,
  });

  if (!token) {
    if (!authConfig.required) {
      return { ok: true };
    }
    return { ok: false, reason: "Missing bearer token" };
  }

  try {
    const auth = verifyJwt(token, {
      issuer: authConfig.issuer || undefined,
      audience: authConfig.audience || undefined,
    });
    return { ok: true, auth };
  } catch (error) {
    if (error instanceof JwtVerificationError) {
      log.warn({ reason: error.message }, "WS auth rejected connection");
      return { ok: false, reason: error.message };
    }

    log.error({ err: error }, "WS auth failed unexpectedly");
    return { ok: false, reason: "Unauthorized" };
  }
}
