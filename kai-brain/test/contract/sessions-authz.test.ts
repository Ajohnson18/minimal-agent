import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Server } from "node:http";
import { closeHttpServer, startHttpServer } from "../helpers/http.js";
import { canBindLocalPort } from "../helpers/network.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import { createTestJwt } from "../helpers/auth.js";

const dbReady = await isTestDatabaseReady();
const canListen = await canBindLocalPort();
const describeIfReady = dbReady && canListen ? describe : describe.skip;

describeIfReady("e2e: sessions authz", () => {
  let server: Server;
  let baseUrl = "";
  const cleanupSessionIds = new Set<string>();

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
    for (const sessionId of cleanupSessionIds) {
      await deleteSession(sessionId);
    }
    cleanupSessionIds.clear();
  });

  test("lists only sessions owned by authenticated user", async () => {
    const userA = uniqueId("user-a");
    const userB = uniqueId("user-b");
    const sessionA = await createTestSession({ userId: userA, title: "A" });
    const sessionB = await createTestSession({ userId: userB, title: "B" });
    cleanupSessionIds.add(sessionA.id);
    cleanupSessionIds.add(sessionB.id);

    const tokenA = createTestJwt({ sub: userA });
    const response = await fetch(`${baseUrl}/api/ava/sessions`, {
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string; title: string | null }>;
    };
    expect(body.sessions.some((session) => session.id === sessionA.id)).toBe(true);
    expect(body.sessions.some((session) => session.id === sessionB.id)).toBe(false);
  });

  test("cannot fetch another user's session", async () => {
    const owner = uniqueId("owner");
    const outsider = uniqueId("outsider");
    const session = await createTestSession({ userId: owner, title: "private" });
    cleanupSessionIds.add(session.id);

    const token = createTestJwt({ sub: outsider });
    const response = await fetch(`${baseUrl}/api/ava/sessions/${session.id}`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(404);
  });

  test("cannot delete another user's session", async () => {
    const owner = uniqueId("owner");
    const outsider = uniqueId("outsider");
    const session = await createTestSession({ userId: owner, title: "private" });
    cleanupSessionIds.add(session.id);

    const token = createTestJwt({ sub: outsider });
    const response = await fetch(`${baseUrl}/api/ava/sessions/${session.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(404);
  });
});
