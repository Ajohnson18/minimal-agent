import { beforeEach, describe, expect, test, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  getExecApprovalRecord: vi.fn(),
  getSessionOwnerUserId: vi.fn(),
  getUserBySlackExternalId: vi.fn(),
  getUserRoleById: vi.fn(),
}));

vi.mock("../../../src/services/exec-approval-store.js", () => storeMocks);

import {
  authorizeSlackApprovalResolver,
  authorizeUserApprovalResolver,
} from "../../../src/services/exec-approval-auth.js";

describe("exec approval auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.getExecApprovalRecord.mockResolvedValue({
      id: "approval-1",
      sessionId: "session-1",
      userId: "owner-user",
      agentId: "main",
      command: "echo hi",
      status: "pending",
      decision: null,
    });
  });

  test("allows session owner to resolve approval", async () => {
    storeMocks.getSessionOwnerUserId.mockResolvedValue("owner-user");
    storeMocks.getUserRoleById.mockResolvedValue("member");

    const result = await authorizeUserApprovalResolver({
      approvalId: "approval-1",
      userId: "owner-user",
    });

    expect(result).toEqual({ ok: true, resolvedBy: "owner-user" });
  });

  test("allows admin to resolve non-owned approval", async () => {
    storeMocks.getSessionOwnerUserId.mockResolvedValue("owner-user");
    storeMocks.getUserRoleById.mockResolvedValue("admin");

    const result = await authorizeUserApprovalResolver({
      approvalId: "approval-1",
      userId: "admin-user",
    });

    expect(result).toEqual({ ok: true, resolvedBy: "admin-user" });
  });

  test("denies member who is not session owner", async () => {
    storeMocks.getSessionOwnerUserId.mockResolvedValue("owner-user");
    storeMocks.getUserRoleById.mockResolvedValue("member");

    const result = await authorizeUserApprovalResolver({
      approvalId: "approval-1",
      userId: "member-user",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not authorized");
  });

  test("allows Slack actor mapped to session owner", async () => {
    storeMocks.getSessionOwnerUserId.mockResolvedValue("owner-user");
    storeMocks.getUserBySlackExternalId.mockResolvedValue({
      id: "owner-user",
      role: "member",
    });

    const result = await authorizeSlackApprovalResolver({
      approvalId: "approval-1",
      slackUserId: "U123",
    });

    expect(result).toEqual({ ok: true, resolvedBy: "owner-user" });
  });
});
