import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

export interface JwtClaims {
  sub?: string;
  user_id?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

export interface AuthContext {
  userId: string;
  claims: JwtClaims;
  token: string;
}

export interface VerifyJwtOptions {
  issuer?: string;
  audience?: string;
  nowMs?: number;
}

export class JwtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtVerificationError";
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function parseJsonSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(decodeBase64Url(segment)) as T;
  } catch {
    throw new JwtVerificationError(`Invalid JWT ${label}`);
  }
}

function hasValidAudience(claim: string | string[] | undefined, expected: string): boolean {
  if (!claim) {
    return false;
  }
  if (Array.isArray(claim)) {
    return claim.includes(expected);
  }
  return claim === expected;
}

function assertTimingSafeEqual(actual: string, expected: string): void {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new JwtVerificationError("Invalid JWT signature");
  }
}

export function verifyJwt(token: string, options: VerifyJwtOptions = {}): AuthContext {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new JwtVerificationError("Malformed JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJsonSegment<{ alg?: string; typ?: string }>(encodedHeader, "header");

  if (header.alg !== "HS256") {
    throw new JwtVerificationError("Unsupported JWT algorithm");
  }

  const signedInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", env.JWT_SECRET)
    .update(signedInput)
    .digest("base64url");

  assertTimingSafeEqual(encodedSignature, expectedSignature);

  const claims = parseJsonSegment<JwtClaims>(encodedPayload, "payload");
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);

  if (typeof claims.nbf === "number" && nowSec < claims.nbf) {
    throw new JwtVerificationError("JWT not active yet");
  }

  if (typeof claims.exp === "number" && nowSec >= claims.exp) {
    throw new JwtVerificationError("JWT expired");
  }

  if (options.issuer && claims.iss !== options.issuer) {
    throw new JwtVerificationError("Invalid JWT issuer");
  }

  if (options.audience && !hasValidAudience(claims.aud, options.audience)) {
    throw new JwtVerificationError("Invalid JWT audience");
  }

  const userId =
    typeof claims.sub === "string" && claims.sub.trim().length > 0
      ? claims.sub
      : typeof claims.user_id === "string" && claims.user_id.trim().length > 0
        ? claims.user_id
        : null;

  if (!userId) {
    throw new JwtVerificationError("JWT missing subject");
  }

  return {
    userId,
    claims,
    token,
  };
}
