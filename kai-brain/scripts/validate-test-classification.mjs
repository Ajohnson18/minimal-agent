#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const LEGACY_E2E_DIR = path.join(ROOT, "test", "e2e");
const CONTRACT_DIR = path.join(ROOT, "test", "contract");
const PROCESS_E2E_DIR = path.join(ROOT, "test", "process-e2e");

async function listTests(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTests(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const legacyE2e = await listTests(LEGACY_E2E_DIR);
  if (legacyE2e.length > 0) {
    console.error("Legacy test/e2e directory is deprecated.");
    console.error("Move tests to test/contract or test/process-e2e:");
    for (const file of legacyE2e) {
      console.error(`- ${path.relative(ROOT, file)}`);
    }
    process.exit(1);
  }

  const [contractTests, processTests] = await Promise.all([
    listTests(CONTRACT_DIR),
    listTests(PROCESS_E2E_DIR),
  ]);

  if (contractTests.length === 0) {
    console.error("No contract tests found under test/contract.");
    process.exit(1);
  }
  if (processTests.length === 0) {
    console.error("No process-e2e tests found under test/process-e2e.");
    process.exit(1);
  }

  console.log(
    `Test classification valid (contract=${contractTests.length}, process-e2e=${processTests.length}).`,
  );
}

await main();
