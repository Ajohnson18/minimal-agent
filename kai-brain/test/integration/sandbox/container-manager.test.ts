import { beforeEach, describe, expect, test, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

import {
  execInContainer,
  pruneIdleContainers,
  validateSandboxVolumeMounts,
} from "../../../src/sandbox/container-manager.js";

type ExecaResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function ok(stdout = ""): ExecaResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

describe("integration: sandbox container manager", () => {
  beforeEach(() => {
    execaMock.mockReset();
    vi.restoreAllMocks();
  });

  test("blocks dangerous docker socket mount paths", () => {
    expect(() =>
      validateSandboxVolumeMounts([
        "/var/run/docker.sock:/workspace:rw",
      ]),
    ).toThrow("Security violation");
  });

  test("filters PATH and loader variables when exec'ing in container", async () => {
    execaMock.mockResolvedValueOnce(ok("sandbox-ok"));

    const result = await execInContainer(
      "ava-sandbox-user-1",
      "echo hi",
      {
        SAFE_ENV: "1",
        PATH: "/tmp/evil",
        LD_PRELOAD: "hack.so",
        DYLD_INSERT_LIBRARIES: "hack.dylib",
      },
      "/workspace",
      4500,
    );

    expect(result.stdout).toBe("sandbox-ok");
    expect(result.exitCode).toBe(0);

    const dockerArgs = execaMock.mock.calls[0]?.[1] as string[];
    expect(dockerArgs).toContain("exec");
    expect(dockerArgs).toContain("-i");
    expect(dockerArgs).toContain("-w");
    expect(dockerArgs).toContain("/workspace");
    expect(dockerArgs).toContain("-e");
    expect(dockerArgs).toContain("SAFE_ENV=1");

    const rendered = dockerArgs.join(" ");
    expect(rendered).not.toContain("PATH=/tmp/evil");
    expect(rendered).not.toContain("LD_PRELOAD=hack.so");
    expect(rendered).not.toContain("DYLD_INSERT_LIBRARIES=hack.dylib");
  });

  test("prunes only idle sandbox containers", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "ps") {
        return ok("ava-sandbox-old\nava-sandbox-fresh\n");
      }

      if (args[0] === "inspect" && args.at(-1) === "ava-sandbox-old") {
        return ok(String(now - 20_000));
      }

      if (args[0] === "inspect" && args.at(-1) === "ava-sandbox-fresh") {
        return ok(String(now - 2_000));
      }

      if (args[0] === "rm" && args.at(-1) === "ava-sandbox-old") {
        return ok();
      }

      throw new Error(`Unexpected docker command: ${args.join(" ")}`);
    });

    const pruned = await pruneIdleContainers(10_000);

    expect(pruned).toBe(1);
    const rmCalls = execaMock.mock.calls.filter((call) => {
      const args = call[1] as string[];
      return args[0] === "rm";
    });
    expect(rmCalls).toHaveLength(1);
    expect((rmCalls[0][1] as string[]).at(-1)).toBe("ava-sandbox-old");
  });
});
