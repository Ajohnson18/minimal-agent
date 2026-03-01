#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const QUARANTINE_PATH = path.join(
  process.cwd(),
  "test",
  "reliability",
  "quarantine.json",
);
const QUARANTINE_POLICY_PATH = path.join(
  process.cwd(),
  "test",
  "reliability",
  "quarantine-policy.json",
);
const SUMMARY_PATH = path.join(
  process.cwd(),
  "reports",
  "reliability-quarantine-summary.md",
);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = {
  maxEntries: 3,
  maxDaysUntilExpiry: 14,
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

async function readJsonFile(filePath, { required }) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!required && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return JSON.parse(raw);
}

async function loadPolicy() {
  let parsed;
  try {
    parsed = await readJsonFile(QUARANTINE_POLICY_PATH, { required: false });
  } catch (error) {
    console.error(`Invalid JSON in ${QUARANTINE_POLICY_PATH}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!parsed) {
    return DEFAULT_POLICY;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`Reliability quarantine policy must be a JSON object (${QUARANTINE_POLICY_PATH}).`);
    process.exit(1);
  }

  const merged = {
    maxEntries: Number(parsed.maxEntries ?? DEFAULT_POLICY.maxEntries),
    maxDaysUntilExpiry: Number(parsed.maxDaysUntilExpiry ?? DEFAULT_POLICY.maxDaysUntilExpiry),
  };

  if (!isPositiveInt(merged.maxEntries) || !isPositiveInt(merged.maxDaysUntilExpiry)) {
    console.error(
      `Invalid quarantine policy values in ${QUARANTINE_POLICY_PATH} (maxEntries/maxDaysUntilExpiry must be positive integers).`,
    );
    process.exit(1);
  }

  return merged;
}

async function writeSummary(policy, entries) {
  await fs.mkdir(path.dirname(SUMMARY_PATH), { recursive: true });
  const lines = [
    "# Reliability Quarantine Summary",
    "",
    `- Entries: ${entries.length}/${policy.maxEntries}`,
    `- Max days until expiry: ${policy.maxDaysUntilExpiry}`,
    "",
  ];

  if (entries.length === 0) {
    lines.push("No quarantined reliability tests.");
  } else {
    lines.push("| Test | Owner | Expires At | Issue |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of entries) {
      lines.push(
        `| \`${entry.test}\` | ${entry.owner} | ${entry.expiresAt} | ${entry.issue} |`,
      );
    }
  }

  await fs.writeFile(SUMMARY_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const policy = await loadPolicy();
  let parsed;
  try {
    parsed = await readJsonFile(QUARANTINE_PATH, { required: false });
  } catch (error) {
    console.error(`Failed to read or parse quarantine file at ${QUARANTINE_PATH}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!parsed) {
    parsed = [];
  }

  if (!Array.isArray(parsed)) {
    console.error("Reliability quarantine file must be a JSON array.");
    process.exit(1);
  }

  const now = Date.now();
  const maxExpiry = now + policy.maxDaysUntilExpiry * DAY_MS;
  const seenTests = new Set();
  const errors = [];
  const normalizedEntries = [];

  if (parsed.length > policy.maxEntries) {
    errors.push(
      `budget exceeded: ${parsed.length} entries > maxEntries=${policy.maxEntries}`,
    );
  }

  for (const [index, entry] of parsed.entries()) {
    const prefix = `entry ${index}`;

    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const test = entry.test;
    const owner = entry.owner;
    const issue = entry.issue;
    const reason = entry.reason;
    const expiresAt = entry.expiresAt;

    if (!isNonEmptyString(test)) {
      errors.push(`${prefix}: missing non-empty "test"`);
    } else if (seenTests.has(test)) {
      errors.push(`${prefix}: duplicate test identifier "${test}"`);
    } else {
      seenTests.add(test);
    }

    if (!isNonEmptyString(owner)) {
      errors.push(`${prefix}: missing non-empty "owner"`);
    }

    if (!isNonEmptyString(issue)) {
      errors.push(`${prefix}: missing non-empty "issue"`);
    }

    if (!isNonEmptyString(reason)) {
      errors.push(`${prefix}: missing non-empty "reason"`);
    }

    if (!isNonEmptyString(expiresAt)) {
      errors.push(`${prefix}: missing non-empty "expiresAt"`);
    } else {
      const parsedExpiry = Date.parse(expiresAt);
      if (!Number.isFinite(parsedExpiry)) {
        errors.push(`${prefix}: invalid expiresAt date "${expiresAt}"`);
      } else if (parsedExpiry <= now) {
        errors.push(`${prefix}: quarantine expired at ${expiresAt}`);
      } else if (parsedExpiry > maxExpiry) {
        errors.push(
          `${prefix}: expiresAt ${expiresAt} exceeds maxDaysUntilExpiry=${policy.maxDaysUntilExpiry}`,
        );
      } else {
        normalizedEntries.push({
          test: test.trim(),
          owner: owner.trim(),
          issue: issue.trim(),
          reason: reason.trim(),
          expiresAt: new Date(parsedExpiry).toISOString(),
        });
      }
    }
  }

  await writeSummary(policy, normalizedEntries);

  if (errors.length > 0) {
    console.error("Reliability quarantine validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Reliability quarantine valid: ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} (budget ${parsed.length}/${policy.maxEntries}).`,
  );
}

await main();
