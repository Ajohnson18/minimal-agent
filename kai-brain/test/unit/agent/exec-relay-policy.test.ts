import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queueSystemEventMock = vi.hoisted(() => vi.fn());
const wakeHeartbeatMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/gateway/services/system-events.js", () => ({
  queueSystemEvent: queueSystemEventMock,
}));

vi.mock("../../../src/gateway/services/heartbeat.service.js", () => ({
  wakeHeartbeat: wakeHeartbeatMock,
}));

import { createExecTool } from "../../../src/agent/tools/exec.tool.js";
import {
  listSessions,
  resetProcessRegistryForTests,
} from "../../../src/agent/tools/process-registry.js";
import { waitFor } from "../../helpers/wait.js";

async function waitForNoRunningExecSessions(): Promise<void> {
  await waitFor(
    () => listSessions().running.length === 0,
    { timeoutMs: 3_000 },
  );
}

describe("exec completion policy", () => {
  beforeEach(() => {
    queueSystemEventMock.mockReset();
    queueSystemEventMock.mockResolvedValue(null);
    wakeHeartbeatMock.mockReset();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
  });

  test("suppresses relay when completionPolicy.relay=silent", async () => {
    const tool = createExecTool({
      sessionId: "session-relay-silent-override",
      execSecurity: "full",
    });

    const result = await tool.execute("call-relay-1", {
      command: "echo relay-silent",
      background: true,
      completionPolicy: {
        relay: "silent",
        relevance: "internal",
      },
    });

    expect(result.details).toMatchObject({ status: "running" });
    await waitForNoRunningExecSessions();

    expect(queueSystemEventMock).not.toHaveBeenCalled();
    expect(wakeHeartbeatMock).not.toHaveBeenCalled();
  });

  test("queues relay in default auto policy", async () => {
    const tool = createExecTool({
      sessionId: "session-relay-auto",
      execSecurity: "full",
    });

    const result = await tool.execute("call-relay-2", {
      command: "echo relay-auto",
      background: true,
    });

    expect(result.details).toMatchObject({ status: "running" });
    await waitFor(
      () => queueSystemEventMock.mock.calls.length === 1,
      { timeoutMs: 3_000 },
    );
    expect(queueSystemEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          outputSeq: expect.objectContaining({
            last: expect.any(Number),
            stdout: expect.any(Number),
            stderr: expect.any(Number),
          }),
        }),
      }),
    );
    expect(wakeHeartbeatMock).toHaveBeenCalledWith(
      "session-relay-auto",
      {
        kind: "event",
        eventKind: "exec.completion",
        source: "exec",
      },
    );
  });

  test("forces relay when completionPolicy.relay=always", async () => {
    const tool = createExecTool({
      sessionId: "session-relay-force",
      execSecurity: "full",
    });

    const result = await tool.execute("call-relay-3", {
      command: "echo relay-force",
      background: true,
      completionPolicy: {
        relay: "always",
        relevance: "user",
        reason: "force-relay-test",
      },
    });

    expect(result.details).toMatchObject({ status: "running" });
    await waitFor(
      () => queueSystemEventMock.mock.calls.length === 1,
      { timeoutMs: 3_000 },
    );

    expect(queueSystemEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-relay-force",
        kind: "exec.completion",
        payload: expect.objectContaining({
          completionPolicy: expect.objectContaining({
            relay: "always",
            relevance: "user",
            reason: "force-relay-test",
          }),
        }),
      }),
    );
    expect(wakeHeartbeatMock).toHaveBeenCalledWith(
      "session-relay-force",
      {
        kind: "event",
        eventKind: "exec.completion",
        source: "exec",
      },
    );
  });
});
