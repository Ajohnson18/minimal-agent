import { describe, expect, test } from "vitest";

import {
  buildExecEnv,
  validateExecEnv,
} from "../../../src/lib/exec-security.js";
import {
  evaluateExecAllowlist,
  isCommandAllowed,
} from "../../../src/lib/exec-approvals.js";

describe("exec-security", () => {
  test("rejects dangerous environment variables", () => {
    expect(() =>
      validateExecEnv([{ key: "PATH", value: "/tmp" }]),
    ).toThrow("forbidden");

    expect(() =>
      validateExecEnv([{ key: "LD_PRELOAD", value: "evil.so" }]),
    ).toThrow("forbidden");
  });

  test("builds env with user credentials and safe overrides", () => {
    const env = buildExecEnv(
      { HOME: "/home/test" },
      [{ key: "MY_FLAG", value: "1" }],
      {
        custom: [
          { key: "api_key", value: "secret" },
          { key: "path", value: "ignored" },
        ],
      },
    );

    expect(env.HOME).toBe("/home/test");
    expect(env.MY_FLAG).toBe("1");
    expect(env.API_KEY).toBe("secret");
    expect(env.PATH).toBeUndefined();
  });
});

describe("exec-approvals", () => {
  test("matches allowlist rules including wildcard variants", () => {
    expect(evaluateExecAllowlist("git status", ["git *"]).allowed).toBe(true);
    expect(evaluateExecAllowlist("npm run test", ["npm*"]).allowed).toBe(true);
    expect(evaluateExecAllowlist("node", ["node"]).allowed).toBe(true);
    expect(evaluateExecAllowlist("python script.py", ["node"]).allowed).toBe(
      false,
    );
  });

  test("enforces deny/allowlist/full security modes", () => {
    expect(isCommandAllowed("ls", "full", []).allowed).toBe(true);

    const deny = isCommandAllowed("ls", "deny", []);
    expect(deny.allowed).toBe(false);
    expect(deny.reason).toContain("disabled");

    const allowed = isCommandAllowed("git status", "allowlist", ["git *"]);
    expect(allowed.allowed).toBe(true);

    const blocked = isCommandAllowed("rm -rf /", "allowlist", ["git *"]);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("not in the exec allowlist");
  });
});
