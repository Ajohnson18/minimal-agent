#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const ALL_SUITES = [
  { name: "unit", script: "test:unit" },
  { name: "integration", script: "test:integration" },
  { name: "contract", script: "test:contract" },
  { name: "process-e2e", script: "test:process-e2e" },
];

const selected = (process.env.AVA_TEST_SUITES ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const suites =
  selected.length === 0
    ? ALL_SUITES
    : ALL_SUITES.filter((suite) => selected.includes(suite.name));

if (suites.length === 0) {
  console.error(
    "No suites selected. Use AVA_TEST_SUITES=unit,integration,contract,process-e2e.",
  );
  process.exit(1);
}

const maxParallelRaw = Number(process.env.AVA_TEST_MAX_PARALLEL ?? "1");
const maxParallel = Number.isFinite(maxParallelRaw) && maxParallelRaw > 0
  ? Math.min(maxParallelRaw, suites.length)
  : suites.length;

const results = [];
let running = 0;
let index = 0;

function runSuite(suite) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("pnpm", [suite.script], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    child.on("close", (code, signal) => {
      resolve({
        name: suite.name,
        script: suite.script,
        code: code ?? 1,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function schedule() {
  while (index < suites.length && running < maxParallel) {
    const suite = suites[index++];
    running += 1;
    runSuite(suite).then((result) => {
      results.push(result);
      running -= 1;
      schedule();
    });
  }

  if (index < suites.length || running > 0) {
    return;
  }

  const failed = results.filter((result) => result.code !== 0);

  console.log("\nTest suite summary:");
  for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    const status = result.code === 0 ? "PASS" : `FAIL(${result.code})`;
    console.log(`- ${result.name}: ${status} in ${seconds}s`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await schedule();
