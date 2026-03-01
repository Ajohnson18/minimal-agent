import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../lib/config-loader.js";
import {
  JwtVerificationError,
  verifyJwt,
  type VerifyJwtOptions,
} from "../lib/auth/jwt.js";
import { extractBearerTokenFromHeaders } from "../lib/auth/token-extract.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("web", { component: "http-auth" });

function getVerifyOptions(): VerifyJwtOptions {
  const authConfig = getConfig().server.auth;
  return {
    issuer: authConfig.issuer || undefined,
    audience: authConfig.audience || undefined,
  };
}

export function requireHttpAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authConfig = getConfig().server.auth;

  if (!authConfig.required) {
    next();
    return;
  }

  const token = extractBearerTokenFromHeaders(req.headers);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    req.auth = verifyJwt(token, getVerifyOptions());
    next();
  } catch (error) {
    if (error instanceof JwtVerificationError) {
      log.warn({ reason: error.message, path: req.path }, "HTTP auth rejected request");
    } else {
      log.error({ err: error, path: req.path }, "HTTP auth failed unexpectedly");
    }
    res.status(401).json({ error: "Unauthorized" });
  }
}
