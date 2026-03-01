/**
 * Smoke Test Suite for AVA Agent
 *
 * Run after major changes to ensure nothing is broken.
 * Tests critical paths: LLM connectivity, tool execution, agent flow.
 *
 * Usage: npx tsx src/scripts/test-agent-smoke.ts
 */
import { executeAgentWithPi } from "../agent/executor-pi.js";
import {
  getPiModel,
  getDefaultProvider,
  getDefaultModelId,
} from "../agent/pi-provider.js";
import { getPiTools } from "../agent/pi-converter.js";
import { streamSimple } from "@mariozechner/pi-ai";
import { db } from "../db/client.js";
import { avaSessions, avaMessages } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

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
    console.log(`✓ (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, duration, error: errorMsg });
    console.log(`✗ FAILED`);
    console.log(`    Error: ${errorMsg}`);
  }
}

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                 AVA Agent Smoke Test Suite                 ");
  console.log("═══════════════════════════════════════════════════════════\n");

  const testSessionId = randomUUID();
  const testUserId = `smoke-test-${Date.now()}`;

  // ─────────────────────────────────────────────────────────────────────────
  // Section 1: LLM Connectivity
  // ─────────────────────────────────────────────────────────────────────────
  console.log("1. LLM Connectivity");
  console.log("───────────────────────────────────────────────────────────");

  await runTest("Get model from provider", async () => {
    const provider = getDefaultProvider();
    const modelId = getDefaultModelId();
    const model = getPiModel(provider, modelId);
    if (!model) throw new Error("Model is null");
  });

  await runTest("Simple LLM completion (no tools)", async () => {
    const provider = getDefaultProvider();
    const modelId = getDefaultModelId();
    const model = getPiModel(provider, modelId);

    const stream = streamSimple(model, {
      systemPrompt: "You are a test assistant. Be extremely brief.",
      messages: [{ role: "user", content: 'Say "OK"', timestamp: Date.now() }],
    });

    let response = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
    }

    if (!response || response.length === 0) {
      throw new Error("Empty response from LLM");
    }
  });

  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Section 2: Tool Configuration
  // ─────────────────────────────────────────────────────────────────────────
  console.log("2. Tool Configuration");
  console.log("───────────────────────────────────────────────────────────");

  await runTest("Get built-in and custom tools", async () => {
    const { builtInTools, customTools } = getPiTools({
      userId: testUserId,
      sessionId: testSessionId,
      cwd: process.cwd(),
    });

    if (builtInTools.length === 0) {
      throw new Error("No built-in tools loaded");
    }
    if (customTools.length === 0) {
      throw new Error("No custom tools loaded");
    }

    // Verify spawn_subagent exists
    const hasSubagent = customTools.some((t) => t.name === "spawn_subagent");
    if (!hasSubagent) {
      throw new Error("spawn_subagent tool not found");
    }
  });

  await runTest("Tool schemas are Vertex AI compatible", async () => {
    const { customTools } = getPiTools({
      userId: testUserId,
      sessionId: testSessionId,
    });

    for (const tool of customTools) {
      const schema = JSON.stringify(tool.parameters);
      // Check for patterns that break Vertex AI
      if (schema.includes('"const"')) {
        throw new Error(
          `Tool "${tool.name}" uses unsupported "const" in schema`
        );
      }
      if (schema.includes('"anyOf"') && schema.includes('"const"')) {
        throw new Error(
          `Tool "${tool.name}" uses unsupported "anyOf" with "const"`
        );
      }
    }
  });

  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Section 3: Agent Execution
  // ─────────────────────────────────────────────────────────────────────────
  console.log("3. Agent Execution");
  console.log("───────────────────────────────────────────────────────────");

  // Create test session
  await db.insert(avaSessions).values({
    id: testSessionId,
    userId: testUserId,
    title: "Smoke Test Session",
    source: "test",
    status: "active",
  });

  await runTest("Execute agent with simple prompt", async () => {
    const result = await executeAgentWithPi({
      sessionId: testSessionId,
      userId: testUserId,
      prompt: "What is 2+2? Answer with just the number.",
    });

    if (!result.content || result.content.length === 0) {
      throw new Error("Empty response content");
    }
    if (result.usage.totalTokens === 0) {
      throw new Error("Zero tokens used - LLM may have failed silently");
    }
  });

  await runTest("Execute agent with tool usage (ls)", async () => {
    const result = await executeAgentWithPi({
      sessionId: testSessionId,
      userId: testUserId,
      prompt:
        "Use the ls tool to list files in the current directory. Just list 3 files.",
    });

    if (!result.content || result.content.length === 0) {
      throw new Error("Empty response content");
    }
    // Tool should have been called
    if (result.toolCalls.length === 0) {
      // This is a warning, not failure - model might answer without tool
      console.log("\n    Warning: No tool calls made");
    }
  });

  await runTest("Messages persisted to database", async () => {
    const messages = await db
      .select()
      .from(avaMessages)
      .where(eq(avaMessages.sessionId, testSessionId));

    if (messages.length === 0) {
      throw new Error("No messages found in database");
    }

    const hasUser = messages.some((m) => m.role === "user");
    if (!hasUser) throw new Error("No user messages persisted");

    // Assistant messages may or may not be saved depending on content
    // The important thing is that we have at least user messages
  });

  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Section 4: Error Handling
  // ─────────────────────────────────────────────────────────────────────────
  console.log("4. Error Handling");
  console.log("───────────────────────────────────────────────────────────");

  await runTest("Agent handles fresh session correctly", async () => {
    // Create a fresh session and verify agent works
    const freshSessionId = randomUUID();
    await db.insert(avaSessions).values({
      id: freshSessionId,
      userId: testUserId,
      title: "Fresh Test Session",
      source: "test",
      status: "active",
    });

    try {
      const result = await executeAgentWithPi({
        sessionId: freshSessionId,
        userId: testUserId,
        prompt: 'Say "test passed"',
      });

      if (!result.content) {
        throw new Error("Empty response on fresh session");
      }
    } finally {
      // Cleanup
      await db
        .delete(avaMessages)
        .where(eq(avaMessages.sessionId, freshSessionId));
      await db.delete(avaSessions).where(eq(avaSessions.id, freshSessionId));
    }
  });

  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────
  console.log("Cleanup");
  console.log("───────────────────────────────────────────────────────────");

  await runTest("Delete test session and messages", async () => {
    await db
      .delete(avaMessages)
      .where(eq(avaMessages.sessionId, testSessionId));
    await db.delete(avaSessions).where(eq(avaSessions.id, testSessionId));
  });

  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("                        SUMMARY                            ");
  console.log("═══════════════════════════════════════════════════════════");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n  Total: ${results.length} tests`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  console.log(`  Time: ${(totalTime / 1000).toFixed(1)}s\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log("  All tests passed! ✓\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFatal error:", error);
  process.exit(1);
});
