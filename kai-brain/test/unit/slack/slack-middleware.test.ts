import { describe, expect, test, vi } from "vitest";

import crypto from "node:crypto";
import {
  handleSlackChallenge,
  verifySlackSignature,
} from "../../../src/middlewares/slack.js";

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  };
}

function signSlackBody(secret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("slack middleware", () => {
  test("accepts valid slack signature", () => {
    const secret = "test-secret";
    process.env.SLACK_SIGNING_SECRET = secret;

    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: "event_callback" });
    const signature = signSlackBody(secret, timestamp, rawBody);

    const req = {
      headers: {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      rawBody,
    } as unknown as never;

    const res = makeResponse();
    const next = vi.fn();

    verifySlackSignature(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("rejects invalid signature", () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";

    const timestamp = String(Math.floor(Date.now() / 1000));
    const req = {
      headers: {
        "x-slack-signature": "v0=bad",
        "x-slack-request-timestamp": timestamp,
      },
      rawBody: "{}",
    } as unknown as never;

    const res = makeResponse();
    const next = vi.fn();

    verifySlackSignature(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("rejects stale timestamp and missing raw body", () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const req = {
      headers: {
        "x-slack-signature": "v0=anything",
        "x-slack-request-timestamp": staleTimestamp,
      },
      rawBody: "{}",
    } as unknown as never;

    const res = makeResponse();
    const next = vi.fn();

    verifySlackSignature(req as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);

    const reqWithoutBody = {
      headers: {
        "x-slack-signature": "v0=anything",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    } as unknown as never;

    const res2 = makeResponse();
    verifySlackSignature(reqWithoutBody as never, res2 as never, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(401);
  });

  test("handles url verification challenge", () => {
    const req = {
      body: { type: "url_verification", challenge: "abc" },
    } as unknown as never;

    const res = makeResponse();
    const next = vi.fn();

    handleSlackChallenge(req as never, res as never, next);

    expect(res.send).toHaveBeenCalledWith({ challenge: "abc" });
    expect(next).not.toHaveBeenCalled();
  });
});
