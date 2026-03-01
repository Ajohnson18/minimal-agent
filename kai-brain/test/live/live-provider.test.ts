import { describe, expect, test } from "vitest";
import { executeAgentWithPi } from "../../src/agent/executor-pi.js";
import { getConfig } from "../../src/lib/config-loader.js";
import { createTestSession, deleteSession, isTestDatabaseReady, uniqueId } from "../helpers/db.js";
import {
  liveGate,
  liveTimeout,
  liveVertexConfigIssue,
  markLiveTestExecuted,
} from "./live-test-helpers.js";

const dbReady = await isTestDatabaseReady();
const liveModelId = process.env.AVA_LIVE_MODEL_ID ?? "claude-sonnet-4-5@20250929";

describe("live: provider", () => {
  test(
    "vertex live execution sanity",
    { timeout: liveTimeout() },
    async ({ skip }) => {
      const gate = liveGate("vertex");
      if (!gate.enabled) {
        skip(gate.reason);
      }
      if (!dbReady) {
        skip("Test database is not available.");
      }
      const vertexIssue = liveVertexConfigIssue();
      if (vertexIssue) {
        skip(vertexIssue);
      }
      markLiveTestExecuted("vertex");

      const session = await createTestSession({
        userId: uniqueId("live-user"),
        source: "live-test",
      });

      try {
        const result = await executeAgentWithPi({
          sessionId: session.id,
          userId: session.userId,
          prompt: "Reply with a one-line greeting.",
          provider: "vertex",
          modelId: liveModelId,
        });

        expect(result.content.trim().length).toBeGreaterThan(0);
      } finally {
        await deleteSession(session.id);
      }
    },
  );

  test(
    "browser CDP endpoint is reachable when enabled",
    { timeout: 30_000 },
    async ({ skip }) => {
      const gate = liveGate("browser");
      if (!gate.enabled) {
        skip(gate.reason);
      }
      markLiveTestExecuted("browser");

      const cdpUrl = getConfig().tools.browser.cdpUrl;
      const endpoint = `${cdpUrl.replace(/\/$/, "")}/json/version`;

      const response = await fetch(endpoint);
      expect(response.ok).toBe(true);

      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload["Browser"]).toBeTypeOf("string");
    },
  );
});
