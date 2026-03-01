/**
 * Test SQL Tool against real Somethings DB.
 * Validates: inline vs file results, no auto-LIMIT, blocked queries, file output.
 *
 * Usage: npx tsx src/scripts/test-sql-tool.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { createSqlTool } from "../agent/tools/sql.tool.js";
import { existsSync, readFileSync } from "node:fs";

const CTX = undefined as any;

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`OK (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, duration, error: errorMsg });
    console.log(`FAILED`);
    console.log(`    Error: ${errorMsg}`);
  }
}

function getResultText(result: any): string {
  return result.content[0].text;
}

async function main() {
  console.log("\n===================================================");
  console.log("         SQL Tool Test Suite (Real DB)");
  console.log("===================================================\n");

  const tool = createSqlTool();

  // ─── 1. Small query — inline table ───
  console.log("1. Small Results (Inline Table)");
  console.log("---------------------------------------------------");

  await runTest("Small query returns inline table", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "SELECT id, first_name, last_name FROM users WHERE role = 'MENTOR' AND deactivated = false LIMIT 5" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (text.includes("saved to")) throw new Error("Small result should be inline, not file");
    if (!text.includes("row(s) returned")) throw new Error("Should have row count");
    if (!text.includes("first_name")) throw new Error("Should have column names");
    console.log(`\n    Preview: ${text.slice(0, 150)}...`);
  });

  console.log("");

  // ─── 2. Large query — file-based CSV ───
  console.log("2. Large Results (File CSV)");
  console.log("---------------------------------------------------");

  await runTest("Large query writes CSV to file", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "SELECT id, first_name, last_name, email, role FROM users WHERE deactivated = false" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("saved to")) throw new Error(`Should save to file. Got: ${text.slice(0, 200)}`);
    if (!text.includes(".csv")) throw new Error("Should mention CSV file path");
    if (!text.includes("slack_message")) throw new Error("Should hint about slack_message");

    // Extract file path and verify file exists
    const pathMatch = text.match(/saved to: (.+\.csv)/);
    if (!pathMatch) throw new Error("Could not extract file path");
    const filePath = pathMatch[1];
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length < 10) throw new Error(`CSV too short: ${lines.length} lines`);
    console.log(`\n    File: ${filePath} (${lines.length} rows, ${(content.length / 1024).toFixed(1)} KB)`);
  });

  console.log("");

  // ─── 3. No auto-LIMIT injection ───
  console.log("3. No Auto-LIMIT");
  console.log("---------------------------------------------------");

  await runTest("Query without LIMIT is not modified", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "SELECT COUNT(*) as cnt FROM users" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    // COUNT(*) returns 1 row — should be inline
    if (text.includes("saved to")) throw new Error("COUNT query should be inline");
    if (!text.includes("cnt")) throw new Error("Should have cnt column");
    // The actual count should be > 100, proving LIMIT was not injected
    const match = text.match(/(\d{3,})/);
    if (!match) throw new Error("Should have a number > 100");
    console.log(`\n    Count: ${match[1]}`);
  });

  await runTest("User-provided LIMIT is respected", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "SELECT id FROM users LIMIT 3" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("3 row(s)")) throw new Error(`Expected 3 rows. Got: ${text.slice(0, 100)}`);
  });

  console.log("");

  // ─── 4. Blocked queries ───
  console.log("4. Security (Blocked Queries)");
  console.log("---------------------------------------------------");

  await runTest("INSERT is blocked", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "INSERT INTO users (id) VALUES ('test')" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("blocked") && !text.includes("Only SELECT")) throw new Error(`Should block INSERT. Got: ${text}`);
  });

  await runTest("DROP is blocked", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "DROP TABLE users" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("blocked") && !text.includes("Only SELECT")) throw new Error(`Should block DROP. Got: ${text}`);
  });

  await runTest("DELETE is blocked", async () => {
    const result = await tool.execute(
      "test",
      { database: "somethings", query: "DELETE FROM users WHERE id = 'test'" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("blocked") && !text.includes("Only SELECT")) throw new Error(`Should block DELETE. Got: ${text}`);
  });

  console.log("");

  // ─── 5. Missing database ───
  console.log("5. Error Handling");
  console.log("---------------------------------------------------");

  await runTest("Unknown database returns helpful error", async () => {
    const result = await tool.execute(
      "test",
      { database: "nonexistent", query: "SELECT 1" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("not configured")) throw new Error(`Should say not configured. Got: ${text}`);
  });

  await runTest("No database or connection_string returns error", async () => {
    const result = await tool.execute(
      "test",
      { query: "SELECT 1" },
      undefined,
      undefined,
      CTX
    );
    const text = getResultText(result);
    if (!text.includes("required")) throw new Error(`Should say required. Got: ${text}`);
  });

  console.log("");

  // ─── Summary ───
  console.log("===================================================");
  console.log("                    SUMMARY");
  console.log("===================================================");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n  Total: ${results.length} tests`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${(totalTime / 1000).toFixed(1)}s\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log("  All tests passed!\n");
  process.exit(0);
}

main();
