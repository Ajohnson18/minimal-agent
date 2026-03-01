import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.fn();

vi.mock("../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../src/agent/compaction.js", () => ({
  getContextSummary: vi.fn(async () => null),
}));

import type { Server } from "node:http";
import { closeHttpServer, startHttpServer } from "../helpers/http.js";
import { isTestDatabaseReady, uniqueId } from "../helpers/db.js";
import { canBindLocalPort } from "../helpers/network.js";
import { createTestJwt } from "../helpers/auth.js";

const dbReady = await isTestDatabaseReady();
const canListen = await canBindLocalPort();
const describeIfDb = dbReady && canListen ? describe : describe.skip;

describeIfDb("e2e: /api/ava/chat SSE", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.resetModules();
    executeAgentWithPiMock.mockReset();

    executeAgentWithPiMock.mockImplementation(async (options: {
      onEvent?: (event: unknown) => void;
    }) => {
      options.onEvent?.({ type: "text_delta", text: "partial" });
      options.onEvent?.({ type: "finish", text: "final" });
      return {
        content: "final answer",
        toolCalls: [],
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
        messages: [],
      };
    });

    const { createServer } = await import("../../src/api/server.js");
    const app = createServer();
    const started = await startHttpServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    await closeHttpServer(server);
  });

  test("streams SSE chunks and done payload", async () => {
    const userId = uniqueId("sse-user");
    const token = createTestJwt({ sub: userId });

    const response = await fetch(`${baseUrl}/api/ava/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: "hello",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await response.text();
    const dataLines = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.replace(/^data:\s*/, ""));

    expect(dataLines.length).toBeGreaterThan(1);

    const events = dataLines.map((line) => JSON.parse(line) as { type: string; text?: string; content?: string; session_id?: string });

    expect(events.some((event) => event.type === "text_delta" && event.text === "partial")).toBe(true);

    const done = events.find((event) => event.type === "done");
    expect(done).toBeDefined();
    expect(done?.content).toBe("final answer");
    expect(done?.session_id).toBeTypeOf("string");
  });
});
