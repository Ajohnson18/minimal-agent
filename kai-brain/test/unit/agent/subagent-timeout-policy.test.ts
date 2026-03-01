import { describe, expect, test } from "vitest";
import { __testing } from "../../../src/agent/tools/subagent.tool.js";

describe("subagent timeout policy", () => {
  test("uses configured default timeout when omitted", () => {
    expect(__testing.clampTimeoutSec(undefined)).toBe(
      __testing.DEFAULT_SUBAGENT_TIMEOUT_SEC,
    );
  });

  test("clamps timeout to supported range", () => {
    expect(__testing.clampTimeoutSec(0)).toBe(0);
    expect(__testing.clampTimeoutSec(1)).toBe(__testing.SUBAGENT_MIN_TIMEOUT_SEC);
    expect(__testing.clampTimeoutSec(__testing.SUBAGENT_MAX_TIMEOUT_SEC + 5_000)).toBe(
      __testing.SUBAGENT_MAX_TIMEOUT_SEC,
    );
  });

  test("detects timeout error messages", () => {
    expect(__testing.isSubagentTimeoutError("Subagent timed out after 300s")).toBe(true);
    expect(__testing.isSubagentTimeoutError("Subagent timeout after 900s")).toBe(true);
    expect(__testing.isSubagentTimeoutError("SQL query failed")).toBe(false);
  });
});
