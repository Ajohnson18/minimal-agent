import { describe, expect, test } from "vitest";
import { spawnSubagent } from "../../src/agent/subagent-executor.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import {
  liveGate,
  liveTimeout,
  liveVertexConfigIssue,
  markLiveTestExecuted,
} from "./live-test-helpers.js";

const dbReady = await isTestDatabaseReady();
const liveModelId =
  process.env.AVA_LIVE_MODEL_ID ?? "claude-sonnet-4-5@20250929";

describe("live: subagent reliability", () => {
  test(
    "spawnSubagent returns a non-empty completion",
    { timeout: liveTimeout(180_000) },
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
      markLiveTestExecuted("subagent");

      const session = await createTestSession({
        userId: uniqueId("live-subagent-user"),
        source: "live-test",
      });

      try {
        const result = await spawnSubagent({
          task: [
            "Provide one concise sentence confirming this is a live subagent smoke run.",
            "Do not call tools unless absolutely required.",
          ].join(" "),
          parentSessionId: session.id,
          userId: session.userId,
          announceMode: "full",
          modelId: liveModelId,
          timeoutMs: 60_000,
          cleanup: true,
        });

        expect(result.success).toBe(true);
        expect(result.content.trim().length).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThan(0);
      } finally {
        await deleteSession(session.id);
      }
    },
  );

  test(
    "silent-output instructions still produce explicit success content or explicit failure",
    { timeout: liveTimeout(180_000) },
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
      markLiveTestExecuted("subagent");

      const session = await createTestSession({
        userId: uniqueId("live-subagent-empty-user"),
        source: "live-test",
      });

      try {
        const result = await spawnSubagent({
          task: [
            "Think through this request but do not output any final answer text.",
            "End silently and do not call tools.",
          ].join(" "),
          parentSessionId: session.id,
          userId: session.userId,
          announceMode: "brief",
          modelId: liveModelId,
          timeoutMs: 60_000,
          cleanup: true,
        });

        if (result.success) {
          expect(result.content.trim().length).toBeGreaterThan(0);
        } else {
          expect((result.error ?? "").trim().length).toBeGreaterThan(0);
        }
      } finally {
        await deleteSession(session.id);
      }
    },
  );
});
