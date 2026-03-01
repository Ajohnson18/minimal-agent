import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execInContainer: vi.fn(),
  writeFileDocker: vi.fn(),
  executePython: vi.fn(),
  formatPythonResult: vi.fn(),
  isSandboxReady: vi.fn(),
}));

vi.mock("../../../src/sandbox/container-manager.js", () => ({
  execInContainer: mocks.execInContainer,
}));

vi.mock("../../../src/sandbox/docker-operations.js", () => ({
  writeFileDocker: mocks.writeFileDocker,
}));

vi.mock("../../../src/sandbox/index.js", () => ({
  executePython: mocks.executePython,
  formatPythonResult: mocks.formatPythonResult,
  isSandboxReady: mocks.isSandboxReady,
}));

import { createPythonTool } from "../../../src/agent/tools/python.tool.js";

function asExecResult(overrides?: Partial<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}>): {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
} {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

describe("integration: python tool sandbox path", () => {
  beforeEach(() => {
    mocks.execInContainer.mockReset();
    mocks.writeFileDocker.mockReset();
    mocks.executePython.mockReset();
    mocks.formatPythonResult.mockReset();
    mocks.isSandboxReady.mockReset();
  });

  test("executes python via session container and returns created files", async () => {
    const tool = createPythonTool({ sandboxContainer: "sandbox-session-1" });

    mocks.execInContainer
      .mockResolvedValueOnce(asExecResult({ stdout: "42\n" }))
      .mockResolvedValueOnce(asExecResult({ stdout: "/workspace/output.txt\n" }))
      .mockResolvedValueOnce(asExecResult());

    const result = await tool.execute("call-1", {
      code: "print(40+2)",
      timeout: 10,
      input_files: [
        {
          filename: "input.txt",
          content: "hello",
        },
      ],
    });

    expect(mocks.writeFileDocker).toHaveBeenCalledTimes(2);
    expect(mocks.writeFileDocker).toHaveBeenNthCalledWith(
      1,
      "sandbox-session-1",
      "/workspace/input.txt",
      "hello",
    );
    expect(mocks.execInContainer).toHaveBeenCalledTimes(3);

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Output:");
    expect(text).toContain("42");
    expect(text).toContain("output.txt");
    expect(text).toContain("Exit code: 0");

    const details = result.details as {
      success: boolean;
      timedOut: boolean;
      outputFiles: string[];
      exitCode: number;
    };
    expect(details.success).toBe(true);
    expect(details.timedOut).toBe(false);
    expect(details.outputFiles).toContain("output.txt");
    expect(details.exitCode).toBe(0);
  });

  test("surfaces timeout from sandbox execution without retrying host path", async () => {
    const tool = createPythonTool({ sandboxContainer: "sandbox-session-2" });

    mocks.execInContainer
      .mockResolvedValueOnce(
        asExecResult({
          stdout: "",
          stderr: "Execution timed out",
          exitCode: 124,
          timedOut: true,
        }),
      )
      .mockResolvedValueOnce(asExecResult({ stdout: "" }))
      .mockResolvedValueOnce(asExecResult());

    const result = await tool.execute("call-2", {
      code: "import time\ntime.sleep(120)",
      timeout: 1,
    });

    expect(mocks.execInContainer).toHaveBeenCalledTimes(3);
    expect(mocks.executePython).not.toHaveBeenCalled();

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Execution timed out");
    expect(text).toContain("Exit code: 124");

    const details = result.details as {
      success: boolean;
      timedOut: boolean;
      exitCode: number;
    };
    expect(details.success).toBe(false);
    expect(details.timedOut).toBe(true);
    expect(details.exitCode).toBe(124);
  });
});
