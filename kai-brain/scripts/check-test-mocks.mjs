#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const SUITES = [
  {
    name: "process-e2e",
    dir: path.join(process.cwd(), "test", "process-e2e"),
  },
  {
    name: "reliability",
    dir: path.join(process.cwd(), "test", "reliability"),
  },
];

// Explicit external-boundary mocks allowed for deterministic test isolation.
const ALLOWED_SRC_MOCK_PATTERNS = [
  "src/lib/slack/app",
  "src/agent/executor-pi",
];

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

function normalizeTarget(target) {
  return target
    .replaceAll("\\", "/")
    .replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, "");
}

function isSrcMock(target) {
  return target.includes("src/") || target.includes("/src/");
}

function isAllowedSrcMock(target) {
  return ALLOWED_SRC_MOCK_PATTERNS.some((pattern) => target.includes(pattern));
}

async function main() {
  const violations = [];
  let totalFiles = 0;

  for (const suite of SUITES) {
    const files = await listTests(suite.dir);
    totalFiles += files.length;

    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const regex = /vi\.(?:mock|doMock)\(\s*["'`]([^"'`]+)["'`]/g;

      for (const match of content.matchAll(regex)) {
        const rawTarget = match[1];
        const target = normalizeTarget(rawTarget);

        if (!isSrcMock(target)) {
          continue;
        }

        if (!isAllowedSrcMock(target)) {
          violations.push({
            suite: suite.name,
            file,
            target: rawTarget,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      "Deterministic suites may only mock explicit external boundary modules.",
    );
    console.error("Disallowed source mocks detected:");
    for (const violation of violations) {
      const rel = path.relative(process.cwd(), violation.file);
      console.error(`- [${violation.suite}] ${rel}: ${violation.target}`);
    }
    process.exit(1);
  }

  console.log(`Test mock guard passed for ${totalFiles} deterministic test file(s).`);
}

await main();
