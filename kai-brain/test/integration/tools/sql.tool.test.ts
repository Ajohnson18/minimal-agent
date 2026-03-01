import { describe, expect, test } from "vitest";

import { existsSync, rmSync } from "node:fs";
import { createSqlTool } from "../../../src/agent/tools/sql.tool.js";
import { isTestDatabaseReady } from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: sql tool", () => {
  const connectionString = process.env.DATABASE_URL!;

  test("enforces read-only queries", async () => {
    const tool = createSqlTool();

    const result = await tool.execute("tc-1", {
      connection_string: connectionString,
      query: "DELETE FROM ava_sessions",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Only SELECT queries are allowed");
  });

  test("returns inline result for small select", async () => {
    const tool = createSqlTool();

    const result = await tool.execute("tc-2", {
      connection_string: connectionString,
      query: "SELECT 1 AS one",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("one");
    expect(text).toContain("1");
  });

  test("writes large result sets to csv file", async () => {
    const tool = createSqlTool();

    const result = await tool.execute("tc-3", {
      connection_string: connectionString,
      query: "SELECT generate_series AS n FROM generate_series(1, 80)",
    });

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Results saved to:");

    const pathMatch = text.match(/Results saved to:\s*(.+)$/m);
    expect(pathMatch).not.toBeNull();
    const filePath = pathMatch?.[1]?.trim() ?? "";
    expect(existsSync(filePath)).toBe(true);

    rmSync(filePath, { force: true });
  });
});
