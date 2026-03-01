#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const QUARANTINE_PATH = path.join(process.cwd(), "test", "reliability", "quarantine.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, next);
    i += 1;
  }
  return args;
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value.trim();
}

function resolveExpiresAt(args) {
  const explicit = args.get("expires-at");
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid --expires-at value: ${explicit}`);
    }
    return new Date(parsed).toISOString();
  }

  const daysRaw = Number(args.get("days") ?? "7");
  if (!Number.isFinite(daysRaw) || daysRaw <= 0) {
    throw new Error(`Invalid --days value: ${args.get("days")}`);
  }
  return new Date(Date.now() + Math.floor(daysRaw) * DAY_MS).toISOString();
}

async function readQuarantine() {
  try {
    const raw = await fs.readFile(QUARANTINE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("quarantine.json must be a JSON array");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function upsertEntry(entries, nextEntry) {
  const index = entries.findIndex((entry) => entry?.test === nextEntry.test);
  if (index >= 0) {
    entries[index] = {
      ...entries[index],
      ...nextEntry,
    };
    return { entries, action: "updated" };
  }

  entries.push(nextEntry);
  entries.sort((a, b) => String(a.test).localeCompare(String(b.test)));
  return { entries, action: "added" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.get("apply") === "true";

  const nextEntry = {
    test: requireNonEmpty(args.get("test"), "test"),
    owner: requireNonEmpty(args.get("owner"), "owner"),
    issue: requireNonEmpty(args.get("issue"), "issue"),
    reason: requireNonEmpty(args.get("reason"), "reason"),
    expiresAt: resolveExpiresAt(args),
  };

  const existing = await readQuarantine();
  const { entries, action } = upsertEntry([...existing], nextEntry);

  if (!apply) {
    console.log("Dry-run only. Use --apply to persist changes.");
    console.log(JSON.stringify({ action, entry: nextEntry }, null, 2));
    return;
  }

  await fs.mkdir(path.dirname(QUARANTINE_PATH), { recursive: true });
  await fs.writeFile(QUARANTINE_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  console.log(`Quarantine ${action}: ${nextEntry.test}`);
}

await main();
