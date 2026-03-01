import { beforeEach, describe, expect, test } from "vitest";

import type { IncomingMessage } from "node:http";
import { authenticateGatewayRequest } from "../../../src/gateway/auth.js";
import { createTestJwt } from "../../helpers/auth.js";
import { reloadConfig } from "../../../src/lib/config-loader.js";

function makeRequest(
  headers: Record<string, string | string[] | undefined>,
  url = "/ws",
): IncomingMessage {
  return {
    headers,
    url,
  } as unknown as IncomingMessage;
}

describe("unit: gateway ws auth", () => {
  beforeEach(() => {
    process.env.AVA_AUTH_REQUIRED = "1";
    process.env.AVA_WS_ALLOW_QUERY_TOKEN = "1";
    reloadConfig();
  });

  test("rejects missing token when auth required", () => {
    const result = authenticateGatewayRequest(makeRequest({}));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Missing bearer token");
    }
  });

  test("accepts valid Authorization bearer token", () => {
    const token = createTestJwt({ sub: "ws-user" });
    const result = authenticateGatewayRequest(
      makeRequest({ authorization: `Bearer ${token}` }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth?.userId).toBe("ws-user");
    }
  });

  test("accepts token query param when enabled", () => {
    const token = createTestJwt({ sub: "ws-query-user" });
    const result = authenticateGatewayRequest(makeRequest({}, `/ws?token=${token}`));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth?.userId).toBe("ws-query-user");
    }
  });

  test("rejects token query param when disabled", () => {
    process.env.AVA_WS_ALLOW_QUERY_TOKEN = "0";
    reloadConfig();

    const token = createTestJwt({ sub: "ws-query-user" });
    const result = authenticateGatewayRequest(makeRequest({}, `/ws?token=${token}`));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Missing bearer token");
    }
  });
});
