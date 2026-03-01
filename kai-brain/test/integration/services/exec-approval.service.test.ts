import { afterEach, describe, expect, test } from "vitest";

import { eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import {
  avaExecAllowlistEntries,
  avaExecApprovals,
} from "../../../src/db/schema/exec-approvals.js";
import { createExecTool } from "../../../src/agent/tools/exec.tool.js";
import {
  getExecAllowlistForUser,
  registerExecApprovalNotifier,
  requestExecApprovalPending,
  resetExecApprovalServiceForTests,
  resolveExecApprovalDecisionByUserId,
} from "../../../src/services/exec-approval.service.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: exec approval service", () => {
  const createdSessions: string[] = [];
  const cleanupUsers: string[] = [];

  afterEach(async () => {
    resetExecApprovalServiceForTests();
    for (const userId of cleanupUsers) {
      await db
        .delete(avaExecAllowlistEntries)
        .where(eq(avaExecAllowlistEntries.userId, userId));
      await db.delete(avaExecApprovals).where(eq(avaExecApprovals.userId, userId));
    }
    cleanupUsers.length = 0;
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
    createdSessions.length = 0;
  });

  test("allow-always persists and later exec call bypasses approval for same user+agent", async () => {
    const userId = uniqueId("approval-user");
    cleanupUsers.push(userId);
    const source = uniqueId("approval-source");
    const session = await createTestSession({
      userId,
      source,
      externalId: `${source}:external`,
    });
    createdSessions.push(session.id);

    registerExecApprovalNotifier({
      name: `test-notifier-${source}`,
      supports: (ctx) => ctx.source === source,
      sendPrompt: async () => ({ ok: true }),
    });

    const started = await requestExecApprovalPending({
      sessionId: session.id,
      command: "echo approval-persist",
      cwd: process.cwd(),
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
      userId,
      agentId: "main",
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error("expected approval request to start");
    }

    const resolved = await resolveExecApprovalDecisionByUserId({
      approvalId: started.pending.approvalId,
      decision: "allow-always",
      userId,
    });
    expect(resolved.ok).toBe(true);

    const decision = await started.pending.decisionPromise;
    expect(decision.decision).toBe("allow-always");

    const persisted = await getExecAllowlistForUser({
      userId,
      agentId: "main",
      baseAllowlist: [],
    });
    expect(persisted.some((pattern) => pattern.includes("echo"))).toBe(true);

    const tool = createExecTool({
      userId,
      agentId: "main",
      execSecurity: "allowlist",
      execAsk: "on-miss",
      execAllowlist: [],
    });
    const result = await tool.execute("call-persisted", {
      command: "echo persisted-bypass",
      yieldMs: 1_000,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("persisted-bypass");
    expect(text).toContain("Exit code: 0");
  });
});
