import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const handleSlackMessageMock = vi.fn();

vi.mock("../../src/slack/monitor/runtime.js", () => ({
  handleSlackMessage: handleSlackMessageMock,
  storePendingMessage: vi.fn(),
  injectSystemEvent: vi.fn(),
  enqueueSlackMessage: vi.fn(),
  resolveThreadDispatchState: vi.fn(),
}));

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { closeHttpServer, startHttpServer } from "../helpers/http.js";
import { canBindLocalPort } from "../helpers/network.js";

function signBody(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
}

const canListen = await canBindLocalPort();
const describeIfNetwork = canListen ? describe : describe.skip;

describeIfNetwork("e2e: slack auth compatibility", () => {
  let server: Server;
  let baseUrl = "";
  const signingSecret = "test-signing-secret";

  beforeEach(async () => {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    handleSlackMessageMock.mockReset();
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

  test("slack signed requests remain accepted without bearer token", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as Record<string, unknown>;

    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await fetch(`${baseUrl}/api/ava/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signBody(signingSecret, timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(200);
  });

  test("slack signed requests ignore unrelated bearer headers", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as Record<string, unknown>;

    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await fetch(`${baseUrl}/api/ava/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer invalid-token",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signBody(signingSecret, timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(200);
  });
});
