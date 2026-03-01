import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  addSession,
  appendOutput,
  clearFinished,
  createEmptySession,
  drainSession,
  encodeKeySequence,
  encodePaste,
  getFinishedSession,
  getSession,
  killSession,
  listSessions,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
  sanitizeBinaryOutput,
} from "../../../src/agent/tools/process-registry.js";

describe("process-registry", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  test("sanitizes binary control characters", () => {
    expect(sanitizeBinaryOutput("ok\x00\x01done\n")).toBe("okdone\n");
  });

  test("appends, drains, and tracks output", () => {
    const session = createEmptySession("s1", "echo hi", process.cwd(), "scope-a");
    addSession(session);

    appendOutput(session, "stdout", "hello");
    appendOutput(session, "stderr", "warn");

    const pending = drainSession(session);
    expect(pending.stdout).toBe("hello");
    expect(pending.stderr).toBe("warn");

    const found = getSession("s1");
    expect(found?.tail).toContain("hellowarn");
    expect(found?.lastSeq).toBe(2);
    expect(found?.lastStdoutSeq).toBe(1);
    expect(found?.lastStderrSeq).toBe(2);
  });

  test("moves background sessions to finished on exit", () => {
    const session = createEmptySession("s2", "sleep 1", process.cwd(), "scope-b");
    addSession(session);
    markBackgrounded(session);

    markExited(session, 0, null, "completed");

    const finished = getFinishedSession("s2");
    expect(finished?.status).toBe("completed");

    const listed = listSessions("scope-b");
    expect(listed.running).toHaveLength(0);
    expect(listed.finished).toHaveLength(1);

    expect(clearFinished("s2")).toBe(true);
  });

  test("kills active session when child exists", () => {
    const session = createEmptySession("s3", "long", process.cwd(), "scope-c");
    const kill = vi.fn();
    session.child = { kill } as unknown as never;
    addSession(session);

    expect(killSession("s3")).toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(killSession("missing")).toBe(false);
  });

  test("encodes key and paste sequences", () => {
    expect(encodeKeySequence(["Ctrl-C", "Enter"])).toBe("\x03\r");
    expect(encodeKeySequence(["Ctrl-a"])).toBe("\x01");
    expect(encodePaste("hello", true)).toBe("\x1B[200~hello\x1B[201~");
    expect(encodePaste("hello", false)).toBe("hello");
  });
});
