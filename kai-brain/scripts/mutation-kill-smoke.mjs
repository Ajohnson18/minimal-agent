#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();

function replaceOnce(source, find, replace) {
  const index = source.indexOf(find);
  if (index < 0) {
    throw new Error(`Could not find mutation target snippet: ${find.slice(0, 80)}...`);
  }
  return source.slice(0, index) + replace + source.slice(index + find.length);
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
      });
    });
  });
}

async function runMutatedCase(definition) {
  const filePath = path.join(ROOT, definition.file);
  const original = await fs.readFile(filePath, "utf8");
  const mutated = definition.mutate(original);

  if (mutated === original) {
    throw new Error(`Mutation for ${definition.id} did not change ${definition.file}`);
  }

  await fs.writeFile(filePath, mutated, "utf8");

  try {
    const result = await runCommand(
      "pnpm",
      ["vitest", "run", "--config", definition.config, definition.testFile, "-t", definition.testName],
      {
        ...process.env,
        AVA_FAIL_ON_SKIP: "1",
      },
    );

    return {
      ...result,
      killed: result.code !== 0,
    };
  } finally {
    await fs.writeFile(filePath, original, "utf8");
  }
}

const MUTATIONS = [
  {
    id: "delivery-route-miss",
    description: "Skips current session binding and falls back to stale route snapshot",
    file: "src/gateway/services/delivery-router.ts",
    config: "vitest.integration.config.ts",
    testFile: "test/integration/gateway/outbound-delivery-pump.test.ts",
    testName: "prefers current session binding over route snapshot",
    mutate(source) {
      return replaceOnce(source, "if (identity.sessionKey) {", "if (false && identity.sessionKey) {");
    },
  },
  {
    id: "no-target-infinite-retry",
    description: "Disables heartbeat self-termination for repeated no-delivery-target failures",
    file: "src/gateway/services/heartbeat-wake.ts",
    config: "vitest.unit.config.ts",
    testFile: "test/unit/gateway/heartbeat-wake.test.ts",
    testName: "terminates heartbeat after consecutive no-delivery-target failures",
    mutate(source) {
      return replaceOnce(
        source,
        'if (retryCause === "no-delivery-target" && attempt > MAX_CONSECUTIVE_NO_DELIVERY_FAILURES) {',
        'if (retryCause === "no-delivery-target" && false && attempt > MAX_CONSECUTIVE_NO_DELIVERY_FAILURES) {',
      );
    },
  },
  {
    id: "subscribe-race",
    description: "Acknowledges subscribe before session subscription is actually registered",
    file: "src/gateway/methods/subscriptions.ts",
    config: "vitest.process-e2e.config.ts",
    testFile: "test/process-e2e/gateway-process.e2e.test.ts",
    testName: "does not lose middle agent.chunk events when subscribe and run are sent back-to-back",
    mutate(source) {
      return replaceOnce(
        source,
        "  const subscribed = runtime.subscribe(\n    clientId,\n    events,\n    typeof resolvedSessionId === 'string' ? resolvedSessionId : undefined,\n  );\n  return { subscribed };",
        "  const sessionId = typeof resolvedSessionId === 'string' ? resolvedSessionId : undefined;\n  const subscribed = [...events];\n  setTimeout(() => {\n    runtime.subscribe(clientId, events, sessionId);\n  }, 50);\n  return { subscribed };",
      );
    },
  },
  {
    id: "nested-announce-truncation",
    description: "Reintroduces summary truncation for full completion results",
    file: "src/agent/subagent-announce.ts",
    config: "vitest.unit.config.ts",
    testFile: "test/unit/agent/subagent-announce.test.ts",
    testName: "does not truncate long completed results in announce payload",
    mutate(source) {
      return replaceOnce(source, "      return result;", "      return `${result.slice(0, 1000)}...[truncated]`;" );
    },
  },
  {
    id: "wildcard-session-leak",
    description: "Allows session-scoped events to leak to unsubscribed clients",
    file: "src/gateway/runtime.ts",
    config: "vitest.process-e2e.config.ts",
    testFile: "test/process-e2e/gateway-process.e2e.test.ts",
    testName: "does not leak session-scoped agent events to subscribers without sessionKey",
    mutate(source) {
      return replaceOnce(
        source,
        "      const sessionMatch =\n        !sessionId ||\n        client.sessionSubscriptions.has(sessionId);",
        "      const sessionMatch =\n        !sessionId ||\n        client.sessionSubscriptions.size === 0 ||\n        client.sessionSubscriptions.has(sessionId);",
      );
    },
  },
];

async function main() {
  const survivors = [];

  for (const mutation of MUTATIONS) {
    console.log(`\n[mutation-smoke] Running ${mutation.id}`);
    console.log(`[mutation-smoke] ${mutation.description}`);

    let result;
    try {
      result = await runMutatedCase(mutation);
    } catch (error) {
      console.error(`[mutation-smoke] ${mutation.id} setup failed`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (result.killed) {
      console.log(`[mutation-smoke] ✅ killed ${mutation.id}`);
      continue;
    }

    console.error(`[mutation-smoke] ❌ survived ${mutation.id}`);
    survivors.push(mutation.id);
  }

  if (survivors.length > 0) {
    console.error("\nMutation kill smoke failed. Surviving mutants:");
    for (const id of survivors) {
      console.error(`- ${id}`);
    }
    process.exit(1);
  }

  console.log("\nMutation kill smoke passed: all seeded mutants were killed.");
}

await main();
