import { describe, expect, test } from "vitest";

import { verifyJwt, JwtVerificationError } from "../../../src/lib/auth/jwt.js";
import { createTestJwt } from "../../helpers/auth.js";

describe("unit: jwt auth", () => {
  test("verifies HS256 token and extracts subject", () => {
    const token = createTestJwt({ sub: "user-123" });

    const auth = verifyJwt(token);

    expect(auth.userId).toBe("user-123");
    expect(auth.claims.sub).toBe("user-123");
  });

  test("falls back to user_id claim when sub is missing", () => {
    const token = createTestJwt({
      sub: "",
      user_id: "legacy-user",
      extraClaims: { sub: undefined },
    });

    const auth = verifyJwt(token);

    expect(auth.userId).toBe("legacy-user");
  });

  test("rejects expired token", () => {
    const token = createTestJwt({ nowSec: 1000, exp: 1001 });

    expect(() => verifyJwt(token, { nowMs: 1002 * 1000 })).toThrow(
      JwtVerificationError,
    );
  });

  test("rejects token with invalid signature", () => {
    const token = createTestJwt({ sub: "user-a", secret: "wrong-secret" });

    expect(() => verifyJwt(token)).toThrow(JwtVerificationError);
  });

  test("enforces issuer and audience when configured", () => {
    const token = createTestJwt({
      sub: "user-a",
      iss: "ava",
      aud: "ava-api",
    });

    expect(() =>
      verifyJwt(token, {
        issuer: "ava",
        audience: "ava-api",
      }),
    ).not.toThrow();

    expect(() =>
      verifyJwt(token, {
        issuer: "other",
      }),
    ).toThrow(JwtVerificationError);

    expect(() =>
      verifyJwt(token, {
        audience: "other-api",
      }),
    ).toThrow(JwtVerificationError);
  });
});
