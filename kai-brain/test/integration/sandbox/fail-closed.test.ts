import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeAgentWithPi: vi.fn(),
  resolveSandboxContext: vi.fn(),
}));

vi.mock("../../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: mocks.executeAgentWithPi,
  resolveSandboxContext: mocks.resolveSandboxContext,
}));

import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";
import { sessionKeyResolverService } from "../../../src/services/session-key-resolver.service.js";
import { agentRun } from "../../../src/gateway/methods/agent.js";
import { runtime } from "../../../src/gateway/runtime.js";
import { ErrorCodes } from "../../../src/gateway/protocol/types.js";
import { SANDBOX_UNAVAILABLE_CODE, SandboxUnavailableError } from "../../../src/sandbox/errors.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: sandbox fail-closed", () => {
  const cleanupSessionIds = new Set<string>();

  afterEach(async () => {
    for (const sessionId of cleanupSessionIds) {
      await deleteSession(sessionId);
    }
    cleanupSessionIds.clear();
    runtime.resetForTests();
    mocks.executeAgentWithPi.mockReset();
    mocks.resolveSandboxContext.mockReset();
  });

  test("agent.run returns SANDBOX_UNAVAILABLE and never starts host execution", async () => {
    const userId = uniqueId("sandbox-user");
    const session = await createTestSession({ userId, source: "test" });
    cleanupSessionIds.add(session.id);
    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session identity");
    }

    mocks.resolveSandboxContext.mockRejectedValueOnce(
      new SandboxUnavailableError(
        "Sandbox is required but unavailable for this request.",
        {
          userId,
          sessionId: session.id,
          scopeKey: "shared",
          mode: "all",
          image: "ava-sandbox-exec",
          network: "none",
        },
      ),
    );

    const result = await agentRun(
      {
        sessionKey: identity.sessionKey,
        message: "hello",
      },
      userId,
    );

    expect("code" in result).toBe(true);
    if (!("code" in result)) {
      throw new Error("Expected RPC error result");
    }

    expect(result.code).toBe(ErrorCodes.SANDBOX_UNAVAILABLE);
    expect(result.data).toEqual({ code: SANDBOX_UNAVAILABLE_CODE });
    expect(mocks.executeAgentWithPi).not.toHaveBeenCalled();
    expect(runtime.getRunsBySession(session.id)).toHaveLength(0);
  });
});
