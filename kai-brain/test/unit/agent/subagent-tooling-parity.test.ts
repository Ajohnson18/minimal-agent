import { describe, expect, test } from "vitest";
import { createCustomTools } from "../../../src/agent/pi-converter.js";

describe("subagent tooling parity", () => {
  test("nested subagent sessions receive shared action-based spawn_subagent tool", () => {
    const tools = createCustomTools({
      userId: "user-nested",
      sessionId: "session-nested",
      sessionSource: "subagent",
      subagentDepth: 1,
    });

    const spawnTool = tools.find((tool) => tool.name === "spawn_subagent");
    expect(spawnTool).toBeDefined();

    const schema = spawnTool?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(schema?.properties).toBeDefined();
    expect(schema?.properties?.action).toBeDefined();
    expect(schema?.properties?.run_id).toBeDefined();
    expect(schema?.properties?.delivery).toBeDefined();
  });
});
