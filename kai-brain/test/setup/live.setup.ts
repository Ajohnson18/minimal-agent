import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { afterAll } from "vitest";
import { flushTraces } from "../../src/services/tracing.service.js";
import {
  getLiveExecutionSummary,
  resetLiveExecutionSummary,
} from "../live/live-test-helpers.js";

// Live suite env resolution for test execution:
// shell env > .env.local > .env, so `pnpm test:live` works out of the box
// while still allowing explicit terminal overrides.
dotenv.config({ path: ".env.local" });
dotenv.config();

const PLACEHOLDER_PROJECT_IDS = new Set([
  "your-project-id",
  "ava-test-project",
  "test-project",
]);
const BASE_PLACEHOLDER_SERVICE_ACCOUNT =
  '{"type":"service_account","project_id":"ava-test-project"}';

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    return dotenv.parse(raw);
  } catch {
    return {};
  }
}

const envValues = parseEnvFile(".env");
const localEnvValues = parseEnvFile(".env.local");

function fromEnvFiles(key: string): string | undefined {
  const local = localEnvValues[key]?.trim();
  if (local) return local;
  const base = envValues[key]?.trim();
  return base || undefined;
}

function currentValue(key: string): string {
  return (process.env[key] ?? "").trim();
}

function setFromFilesWhen(
  key: string,
  predicate: (current: string) => boolean,
): void {
  const current = currentValue(key);
  if (!predicate(current)) return;
  const fileValue = fromEnvFiles(key);
  if (!fileValue) return;
  process.env[key] = fileValue;
}

setFromFilesWhen("AVA_LIVE_TEST_ALLOW", (current) => current.length === 0);
setFromFilesWhen("VERTEX_AI_PROJECT_ID", (current) =>
  current.length === 0 || PLACEHOLDER_PROJECT_IDS.has(current.toLowerCase()),
);
setFromFilesWhen("VERTEX_AI_SERVICE_ACCOUNT_KEY", (current) => {
  if (!current) return true;
  if (current === BASE_PLACEHOLDER_SERVICE_ACCOUNT) return true;
  if (current === "{}") return true;
  return false;
});
setFromFilesWhen("GOOGLE_APPLICATION_CREDENTIALS", (current) => current.length === 0);

process.env.AVA_TEST_MODE = "1";
resetLiveExecutionSummary();

const liveEnabled = ["1", "true", "yes", "on"].includes(
  (process.env.AVA_LIVE_TESTS ?? "").trim().toLowerCase(),
);
const liveProjectId = (process.env.VERTEX_AI_PROJECT_ID ?? "").trim().toLowerCase();
if (
  liveEnabled &&
  (liveProjectId === "your-project-id" ||
    liveProjectId === "ava-test-project" ||
    liveProjectId === "test-project")
) {
  console.warn(
    "[live-tests] VERTEX_AI_PROJECT_ID is a placeholder in env. " +
      "Set a real project id (or remove it from .env.local to inherit .env).",
  );
}

afterAll(async () => {
  if (liveEnabled) {
    const summary = getLiveExecutionSummary();
    if (summary.executedCount === 0) {
      throw new Error(
        "Live tests were enabled but no live test actually executed. " +
          "Check AVA_LIVE_TEST_ALLOW and live credentials in .env/.env.local.",
      );
    }
  }

  try {
    await flushTraces();
  } catch {
    // best effort
  }
});
