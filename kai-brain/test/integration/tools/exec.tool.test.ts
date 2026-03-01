import { afterEach, describe, expect, test } from "vitest";

import { createExecTool } from "../../../src/agent/tools/exec.tool.js";
import {
  getFinishedSession,
  listSessions,
  resetProcessRegistryForTests,
} from "../../../src/agent/tools/process-registry.js";
import { waitFor } from "../../helpers/wait.js";
import type { ExecApprovalDecisionResult } from "../../../src/services/exec-approval.service.js";

function deferredDecision() {
  let resolve!: (result: ExecApprovalDecisionResult) => void;
  const promise = new Promise<ExecApprovalDecisionResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForFinishedCommand(command: string): Promise<string> {
  let sessionId = "";
  await waitFor(
    () => {
      const sessions = listSessions();
      const found = sessions.finished.find((entry) => entry.command === command);
      if (!found) {
        return false;
      }
      sessionId = found.id;
      return true;
    },
    {
      timeoutMs: 4_000,
      message: `expected finished process for command: ${command}`,
    },
  );
  return sessionId;
}

describe("integration: exec tool", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  test("denies commands when allowlist does not match", async () => {
    const tool = createExecTool({
      execSecurity: "allowlist",
      execAllowlist: ["git *"],
    });

    const result = await tool.execute("call-1", {
      command: "rm -rf /tmp/nowhere",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Exec denied");

    const sessions = listSessions();
    expect(sessions.running).toHaveLength(0);
  });

  test("blocks likely env var injection in inline script bodies", async () => {
    const tool = createExecTool({ execSecurity: "full" });

    const result = await tool.execute("call-2", {
      command: "python3 -c \"print($UNSAFE)\"",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("shell variable references");
  });

  test("executes simple allowed command and records completion", async () => {
    const tool = createExecTool({ execSecurity: "full" });

    const result = await tool.execute("call-3", {
      command: "echo integration-ok",
      yieldMs: 1_000,
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("integration-ok");
    expect(text).toContain("Exit code: 0");

    const details = result.details as { sessionId?: string };
    expect(details.sessionId).toBeDefined();
    const finished = details.sessionId
      ? getFinishedSession(details.sessionId)
      : undefined;

    // Foreground execution may not persist in finished sessions; both are acceptable.
    expect(finished === undefined || finished.status === "completed").toBe(true);
  });

  test("honors stricter per-call security override", async () => {
    const tool = createExecTool({ execSecurity: "full", execAllowlist: ["echo *"] });

    const result = await tool.execute("call-4", {
      command: "echo should-not-run",
      security: "deny",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Exec denied");
  });

  test("supports env object input format", async () => {
    const tool = createExecTool({ execSecurity: "full" });

    const result = await tool.execute("call-5", {
      command: "echo $AVA_EXEC_ENV_OBJECT",
      env: { AVA_EXEC_ENV_OBJECT: "env-object-ok" },
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("env-object-ok");
  });

  test("rejects unsupported node host mode", async () => {
    const tool = createExecTool({ execSecurity: "full" });

    const result = await tool.execute("call-6", {
      command: "echo hi",
      host: "node",
      node: "local-node",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("host=node is not supported");
  });

  test("denies ask approval when no routable session context is available", async () => {
    const tool = createExecTool({ execSecurity: "full" });

    const result = await tool.execute("call-7", {
      command: "echo hi",
      ask: "always",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("routable session context");
  });

  test("enforces trusted safe-bin directories", async () => {
    const tool = createExecTool({
      execSecurity: "allowlist",
      execSafeBins: ["echo"],
      execSafeBinTrustedDirs: ["/tmp/definitely-not-a-system-bin"],
    });

    const result = await tool.execute("call-safe-bin-trusted", {
      command: "echo blocked-safe-bin",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Exec denied");
    expect(result.details).toMatchObject({
      denied: true,
      pathDrift: {
        safeBinViolations: expect.any(Array),
      },
    });
  });

  test("routes obfuscated payloads to approval flow even when ask=off", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-obfuscation-check",
      execSecurity: "full",
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-obfuscation",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-obfuscation", {
      command: "echo ZWNobyBoaQ== | base64 -d | bash",
      ask: "off",
    });

    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-obfuscation",
      obfuscationSignals: expect.arrayContaining(["base64-shell"]),
    });

    decision.resolve({
      approvalId: "approval-obfuscation",
      approved: false,
      decision: "deny",
      reason: "blocked",
    });
  });

  test("runs command when ask=always approval is granted", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-ask-allow",
      execSecurity: "full",
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-allow",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-8", {
      command: "echo ask-allow-ok",
      ask: "always",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Approval required");
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-allow",
    });

    decision.resolve({
      approvalId: "approval-allow",
      approved: true,
      decision: "allow-once",
    });

    const finishedId = await waitForFinishedCommand("echo ask-allow-ok");
    const finished = getFinishedSession(finishedId);
    expect(finished?.tail).toContain("ask-allow-ok");
  });

  test("denies command when ask approval is rejected", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-ask-deny",
      execSecurity: "allowlist",
      execAllowlist: ["git *"],
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-deny",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-9", {
      command: "echo ask-deny-nope",
      ask: "on-miss",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Approval required");
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-deny",
    });

    decision.resolve({
      approvalId: "approval-deny",
      approved: false,
      decision: "deny",
      reason: "denied by reviewer",
    });

    await waitFor(() => {
      const sessions = listSessions();
      return sessions.running.length === 0 && sessions.finished.length === 0;
    });
  });

  test("applies askFallback=full after timeout and runs command", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-ask-timeout-full",
      execSecurity: "allowlist",
      execAllowlist: ["git *"],
      execAskFallback: "full",
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-timeout-full",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-10", {
      command: "echo ask-timeout-full",
      ask: "on-miss",
    });
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-timeout-full",
    });

    decision.resolve({
      approvalId: "approval-timeout-full",
      approved: false,
      decision: "timeout",
      reason: "approval timed out",
    });

    const finishedId = await waitForFinishedCommand("echo ask-timeout-full");
    const finished = getFinishedSession(finishedId);
    expect(finished?.tail).toContain("ask-timeout-full");
  });

  test("applies askFallback=allowlist only for allowlisted commands", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-ask-timeout-allowlist",
      execSecurity: "allowlist",
      execAllowlist: ["echo *"],
      execAskFallback: "allowlist",
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-timeout-allowlist",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-11", {
      command: "echo ask-timeout-allowlist",
      ask: "always",
    });
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-timeout-allowlist",
    });

    decision.resolve({
      approvalId: "approval-timeout-allowlist",
      approved: false,
      decision: "timeout",
      reason: "approval timed out",
    });

    const finishedId = await waitForFinishedCommand("echo ask-timeout-allowlist");
    const finished = getFinishedSession(finishedId);
    expect(finished?.tail).toContain("ask-timeout-allowlist");
  });

  test("keeps command blocked when askFallback=allowlist and command is not allowlisted", async () => {
    const decision = deferredDecision();
    const tool = createExecTool({
      sessionId: "session-ask-timeout-deny",
      execSecurity: "allowlist",
      execAllowlist: ["git *"],
      execAskFallback: "allowlist",
      approvalRequesterPending: async () => ({
        ok: true,
        pending: {
          approvalId: "approval-timeout-deny",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          decisionPromise: decision.promise,
        },
      }),
    });

    const result = await tool.execute("call-12", {
      command: "echo ask-timeout-deny",
      ask: "on-miss",
    });
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: "approval-timeout-deny",
    });

    decision.resolve({
      approvalId: "approval-timeout-deny",
      approved: false,
      decision: "timeout",
      reason: "approval timed out",
    });

    await waitFor(() => {
      const sessions = listSessions();
      return !sessions.running.some((entry) => entry.command === "echo ask-timeout-deny");
    });
    expect(
      listSessions().finished.some((entry) => entry.command === "echo ask-timeout-deny"),
    ).toBe(false);
  });
});
