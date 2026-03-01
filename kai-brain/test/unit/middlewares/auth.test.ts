import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Request, Response } from "express";
import { requireHttpAuth } from "../../../src/middlewares/auth.js";
import { createTestJwt } from "../../helpers/auth.js";
import { reloadConfig } from "../../../src/lib/config-loader.js";

function createMockResponse() {
  const response = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as unknown as Response & {
    statusCode: number;
    payload: unknown;
  };
}

describe("unit: auth middleware", () => {
  beforeEach(() => {
    process.env.AVA_AUTH_REQUIRED = "1";
    reloadConfig();
  });

  test("rejects missing bearer token", () => {
    const req = { headers: {}, path: "/api/ava/chat" } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    requireHttpAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "Missing bearer token" });
  });

  test("attaches auth context for valid bearer token", () => {
    const token = createTestJwt({ sub: "middleware-user" });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      path: "/api/ava/chat",
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    requireHttpAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth?.userId).toBe("middleware-user");
  });

  test("rejects malformed token", () => {
    const req = {
      headers: { authorization: "Bearer not-a-token" },
      path: "/api/ava/chat",
    } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    requireHttpAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "Unauthorized" });
  });

  test("allows request when auth is disabled", () => {
    process.env.AVA_AUTH_REQUIRED = "0";
    reloadConfig();

    const req = { headers: {}, path: "/api/ava/chat" } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    requireHttpAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
