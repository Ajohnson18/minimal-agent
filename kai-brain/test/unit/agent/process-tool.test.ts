import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  addSession,
  appendOutput,
  createEmptySession,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "../../../src/agent/tools/process-registry.js";
import { createProcessTool } from "../../../src/agent/tools/process.tool.js";

describe("process tool", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  test("poll and log return process output", async () => {
    const session = createEmptySession("proc-1", "echo hi");
    addSession(session);
    appendOutput(session, "stdout", "line1\nline2\n");

    const tool = createProcessTool();

    const poll = await tool.execute("call-1", {
      action: "poll",
      sessionId: "proc-1",
    });

    const pollText = poll.content[0]?.type === "text" ? poll.content[0].text : "";
    expect(pollText).toContain("line1");

    appendOutput(session, "stdout", "line3\nline4\n");

    const log = await tool.execute("call-2", {
      action: "log",
      sessionId: "proc-1",
      offset: 1,
      limit: 2,
    });

    const logText = log.content[0]?.type === "text" ? log.content[0].text : "";
    expect(logText).toContain("line2");
    expect(logText).toContain("line3");
  });

  test("write/send-keys/paste require a background writable session", async () => {
    const session = createEmptySession("proc-2", "python3 -i");
    const write = vi.fn();
    const end = vi.fn();

    session.stdin = {
      write,
      end,
      destroyed: false,
    };

    addSession(session);
    markBackgrounded(session);

    const tool = createProcessTool();

    const writeResult = await tool.execute("call-3", {
      action: "write",
      sessionId: "proc-2",
      data: "print(1)",
      eof: true,
    });

    expect(write).toHaveBeenCalledWith("print(1)");
    expect(end).toHaveBeenCalled();
    expect(writeResult.content[0]?.type === "text" && writeResult.content[0].text).toContain(
      "Written to stdin",
    );

    const keysResult = await tool.execute("call-4", {
      action: "send-keys",
      sessionId: "proc-2",
      keys: ["Ctrl-C"],
    });
    expect(keysResult.content[0]?.type === "text" && keysResult.content[0].text).toContain(
      "Sent keys",
    );

    const pasteResult = await tool.execute("call-5", {
      action: "paste",
      sessionId: "proc-2",
      text: "echo done",
    });
    expect(pasteResult.content[0]?.type === "text" && pasteResult.content[0].text).toContain(
      "Pasted",
    );
  });

  test("kill/clear/remove manage session lifecycle", async () => {
    const session = createEmptySession("proc-3", "sleep 10");
    session.child = {
      kill: vi.fn(),
    } as unknown as never;
    addSession(session);

    const tool = createProcessTool();
    const kill = await tool.execute("call-6", {
      action: "kill",
      sessionId: "proc-3",
    });
    expect(kill.content[0]?.type === "text" && kill.content[0].text).toContain("killed");

    markBackgrounded(session);
    markExited(session, 0, null, "completed");

    const clear = await tool.execute("call-7", {
      action: "clear",
      sessionId: "proc-3",
    });
    expect(clear.content[0]?.type === "text" && clear.content[0].text).toContain("cleared");
  });
});
