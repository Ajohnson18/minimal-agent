import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestExecApprovalPending: vi.fn(),
  waitForExecApprovalDecision: vi.fn(),
  resolveExecApprovalDecisionByUserId: vi.fn(),
  getSessionOwnerUserId: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("../../../src/services/exec-approval.service.js", () => ({
  requestExecApprovalPending: mocks.requestExecApprovalPending,
  waitForExecApprovalDecision: mocks.waitForExecApprovalDecision,
  resolveExecApprovalDecisionByUserId: mocks.resolveExecApprovalDecisionByUserId,
}));

vi.mock("../../../src/services/exec-approval-store.js", () => ({
  getSessionOwnerUserId: mocks.getSessionOwnerUserId,
}));

vi.mock("../../../src/gateway/runtime.js", () => ({
  runtime: {
    broadcast: mocks.broadcast,
  },
}));

import {
  execApprovalRequest,
  execApprovalResolve,
  execApprovalWaitDecision,
} from "../../../src/gateway/methods/exec-approval.js";
import { ErrorCodes } from "../../../src/gateway/protocol/types.js";
import { sessionKeyResolverService } from "../../../src/services/session-key-resolver.service.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;
describeIfDb("integration: gateway exec approval methods", () => {
  const createdSessions: string[] = [];
  let sessionKey = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getSessionOwnerUserId.mockResolvedValue("owner-1");

    const session = await createTestSession({
      userId: "owner-1",
      source: "test",
      externalId: `slack:C123:${uniqueId("approval-thread")}`,
    });
    createdSessions.push(session.id);

    const identity = await sessionKeyResolverService.resolveBySessionId(session.id);
    if (!identity) {
      throw new Error("Failed to resolve session identity for approval test");
    }

    sessionKey = identity.sessionKey;
  });

  afterEach(async () => {
    for (const createdSessionId of createdSessions.splice(0)) {
      await deleteSession(createdSessionId);
    }
  });

  test("request twoPhase returns accepted and broadcasts requested event", async () => {
    mocks.requestExecApprovalPending.mockResolvedValue({
      ok: true,
      pending: {
        approvalId: "approval-1",
        createdAtMs: 100,
        expiresAtMs: 200,
        decisionPromise: Promise.resolve({
          approvalId: "approval-1",
          approved: true,
          decision: "allow-once",
        }),
      },
    });

    const result = await execApprovalRequest(
      {
        sessionKey,
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "always",
        twoPhase: true,
      },
      "owner-1",
    );

    expect("status" in result && result.status === "accepted").toBe(true);
    expect(mocks.broadcast).toHaveBeenCalledWith({
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        request: {
          sessionKey,
          command: "echo hi",
          cwd: "/tmp",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          userId: "owner-1",
        },
        createdAtMs: 100,
        expiresAtMs: 200,
      },
    });
  });

  test("request without twoPhase waits and maps timeout to null decision", async () => {
    mocks.requestExecApprovalPending.mockResolvedValue({
      ok: true,
      pending: {
        approvalId: "approval-timeout",
        createdAtMs: 100,
        expiresAtMs: 200,
        decisionPromise: Promise.resolve({
          approvalId: "approval-timeout",
          approved: false,
          decision: "timeout",
          reason: "approval timed out",
        }),
      },
    });

    const result = await execApprovalRequest(
      {
        sessionKey,
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "always",
      },
      "owner-1",
    );

    expect(result).toMatchObject({
      id: "approval-timeout",
      sessionKey,
      decision: null,
      createdAtMs: 100,
      expiresAtMs: 200,
    });

    await Promise.resolve();
    expect(mocks.broadcast).toHaveBeenCalledWith({
      event: "exec.approval.resolved",
      payload: {
        id: "approval-timeout",
        decision: "timeout",
        resolvedBy: undefined,
        ts: expect.any(Number),
      },
    });
  });

  test("waitDecision returns decision or not-found", async () => {
    mocks.waitForExecApprovalDecision.mockResolvedValueOnce({
      approvalId: "approval-2",
      approved: true,
      decision: "allow-always",
    });

    const first = await execApprovalWaitDecision({ id: "approval-2" });
    expect(first).toEqual({ id: "approval-2", decision: "allow-always" });

    mocks.waitForExecApprovalDecision.mockResolvedValueOnce(null);
    const second = await execApprovalWaitDecision({ id: "approval-missing" });
    expect("code" in second && second.code === ErrorCodes.NOT_FOUND).toBe(true);
  });

  test("resolve enforces auth and broadcasts resolved event", async () => {
    const unauth = await execApprovalResolve(
      { id: "approval-3", decision: "allow-once" },
      undefined,
    );
    expect("code" in unauth && unauth.code === ErrorCodes.UNAUTHORIZED).toBe(true);

    mocks.resolveExecApprovalDecisionByUserId.mockResolvedValue({ ok: true });
    const ok = await execApprovalResolve(
      { id: "approval-3", decision: "allow-once" },
      "owner-1",
    );
    expect(ok).toEqual({ ok: true });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      event: "exec.approval.resolved",
      payload: {
        id: "approval-3",
        decision: "allow-once",
        resolvedBy: "owner-1",
        ts: expect.any(Number),
      },
    });
  });

  test("resolve maps auth failures to unauthorized", async () => {
    mocks.resolveExecApprovalDecisionByUserId.mockResolvedValue({
      ok: false,
      reason: "not authorized to resolve this approval",
    });

    const result = await execApprovalResolve(
      { id: "approval-4", decision: "deny" },
      "member-1",
    );

    expect("code" in result && result.code === ErrorCodes.UNAUTHORIZED).toBe(true);
  });
});
