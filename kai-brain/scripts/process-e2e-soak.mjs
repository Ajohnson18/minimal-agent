#!/usr/bin/env node
import { spawn } from "node:child_process";

const DEFAULT_ITERATIONS = 100;
const DEFAULT_TEST_FILE = "test/process-e2e/gateway-process.e2e.test.ts";
const DEFAULT_PATTERN = [
  "does not lose middle agent.chunk events when subscribe and run are sent back-to-back",
  "does not leak session-scoped agent events to subscribers without sessionKey",
  "cancels active run when final subscriber disconnects",
].join("|");

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function runVitestOnce({ testFile, pattern }) {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      [
        "vitest",
        "run",
        "--config",
        "vitest.process-e2e.config.ts",
        testFile,
        "-t",
        pattern,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          AVA_FAIL_ON_SKIP: "1",
        },
        shell: process.platform === "win32",
      },
    );

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

async function main() {
  const iterations = parsePositiveInt(
    process.env.AVA_PROCESS_E2E_SOAK_ITERATIONS,
    DEFAULT_ITERATIONS,
  );
  const testFile = process.env.AVA_PROCESS_E2E_SOAK_TEST_FILE ?? DEFAULT_TEST_FILE;
  const pattern = process.env.AVA_PROCESS_E2E_SOAK_PATTERN ?? DEFAULT_PATTERN;

  console.log(`[process-e2e-soak] iterations=${iterations}`);
  console.log(`[process-e2e-soak] testFile=${testFile}`);
  console.log(`[process-e2e-soak] pattern=${pattern}`);

  const startedAt = Date.now();
  for (let i = 1; i <= iterations; i += 1) {
    console.log(`\n[process-e2e-soak] iteration ${i}/${iterations}`);
    const result = await runVitestOnce({ testFile, pattern });

    if (result.code !== 0) {
      console.error(
        `[process-e2e-soak] failed at iteration ${i} (exit=${result.code}, signal=${result.signal ?? "none"})`,
      );
      process.exit(result.code);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[process-e2e-soak] passed ${iterations}/${iterations} iterations in ${elapsedSec}s`);
}

await main();
