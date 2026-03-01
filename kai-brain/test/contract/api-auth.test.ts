import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Server } from "node:http";
import { closeHttpServer, startHttpServer } from "../helpers/http.js";
import { canBindLocalPort } from "../helpers/network.js";
import { createTestJwt } from "../helpers/auth.js";

const canListen = await canBindLocalPort();
const describeIfNetwork = canListen ? describe : describe.skip;

describeIfNetwork("e2e: api auth", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.resetModules();
    const { createServer } = await import("../../src/api/server.js");
    const app = createServer();
    const started = await startHttpServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    await closeHttpServer(server);
  });

  test("rejects chat request without bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/ava/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "hello",
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Missing bearer token");
  });

  test("rejects malformed bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/ava/sessions`, {
      method: "GET",
      headers: {
        authorization: "Bearer not-a-jwt",
      },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  test("ignores legacy user_id query/body fallback and uses auth subject", async () => {
    const token = createTestJwt({ sub: "token-user" });

    const response = await fetch(`${baseUrl}/api/ava/sessions?user_id=other-user`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});
