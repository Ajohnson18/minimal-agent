import { createHmac } from "node:crypto";

export interface TestJwtOptions {
  sub?: string;
  user_id?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  nowSec?: number;
  secret?: string;
  extraClaims?: Record<string, unknown>;
}

function encodeBase64Url(input: unknown): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function createTestJwt(options: TestJwtOptions = {}): string {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const secret = options.secret ?? process.env.JWT_SECRET ?? "ava-test-jwt-secret";
  const subject = options.sub ?? options.user_id ?? "test-user";

  const payload = {
    sub: subject,
    iat: options.iat ?? nowSec,
    exp: options.exp ?? nowSec + 3600,
    ...(options.nbf !== undefined ? { nbf: options.nbf } : {}),
    ...(options.iss ? { iss: options.iss } : {}),
    ...(options.aud ? { aud: options.aud } : {}),
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.extraClaims ?? {}),
  };

  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const encodedHeader = encodeBase64Url(header);
  const encodedPayload = encodeBase64Url(payload);
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
