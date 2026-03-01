import { existsSync, readFileSync } from "node:fs";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LIVE_STATE_KEY = Symbol.for("ava.live.test.execution.state");

function parseAllowlist(): Set<string> {
  const raw = process.env.AVA_LIVE_TEST_ALLOW?.trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isLiveEnabled(): boolean {
  const raw = process.env.AVA_LIVE_TESTS?.trim().toLowerCase() ?? "";
  return TRUE_VALUES.has(raw);
}

export function isLiveTestAllowed(scope: string): boolean {
  const allowlist = parseAllowlist();
  if (allowlist.size === 0) {
    return true;
  }

  const normalized = scope.toLowerCase();
  return allowlist.has("*") || allowlist.has(normalized);
}

export function liveGate(scope: string): {
  enabled: boolean;
  reason?: string;
} {
  if (!isLiveEnabled()) {
    return {
      enabled: false,
      reason: "Set AVA_LIVE_TESTS=1 to run live tests.",
    };
  }

  if (!isLiveTestAllowed(scope)) {
    return {
      enabled: false,
      reason: `Scope \"${scope}\" is not in AVA_LIVE_TEST_ALLOW.`,
    };
  }

  return { enabled: true };
}

export function liveTimeout(defaultMs = 120_000): number {
  const raw = Number(process.env.AVA_LIVE_TIMEOUT_MS ?? String(defaultMs));
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

type ServiceAccountLike = {
  client_email?: unknown;
  private_key?: unknown;
};

const PLACEHOLDER_PROJECT_IDS = new Set([
  "your-project-id",
  "ava-test-project",
  "test-project",
]);

function parseServiceAccountJson(raw: string | undefined): ServiceAccountLike | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as ServiceAccountLike;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasServiceAccountKeyFields(value: ServiceAccountLike | null): boolean {
  if (!value) return false;
  return (
    typeof value.client_email === "string" &&
    value.client_email.trim().length > 0 &&
    typeof value.private_key === "string" &&
    value.private_key.trim().length > 0
  );
}

function readServiceAccountFromFile(path: string | undefined): ServiceAccountLike | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed || !existsSync(trimmed)) return null;

  try {
    return parseServiceAccountJson(readFileSync(trimmed, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Returns true only when live Vertex credentials appear to be real
 * service-account credentials (not test placeholders).
 */
export function hasLiveVertexCredentials(): boolean {
  const inline = parseServiceAccountJson(process.env.VERTEX_AI_SERVICE_ACCOUNT_KEY);
  if (hasServiceAccountKeyFields(inline)) {
    return true;
  }

  const fromFile = readServiceAccountFromFile(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
  return hasServiceAccountKeyFields(fromFile);
}

export function hasLiveVertexProjectId(): boolean {
  const projectId = process.env.VERTEX_AI_PROJECT_ID?.trim();
  if (!projectId) return false;
  return !PLACEHOLDER_PROJECT_IDS.has(projectId.toLowerCase());
}

export function liveVertexConfigIssue(): string | null {
  if (!hasLiveVertexProjectId()) {
    return "Set VERTEX_AI_PROJECT_ID to a real GCP project id (not a placeholder).";
  }

  if (!hasLiveVertexCredentials()) {
    return "Real Vertex credentials are not configured.";
  }

  return null;
}

type LiveExecutionState = {
  executedCount: number;
  scopes: Set<string>;
};

function getLiveExecutionState(): LiveExecutionState {
  const globalObject = globalThis as typeof globalThis & {
    [LIVE_STATE_KEY]?: LiveExecutionState;
  };

  if (!globalObject[LIVE_STATE_KEY]) {
    globalObject[LIVE_STATE_KEY] = {
      executedCount: 0,
      scopes: new Set<string>(),
    };
  }

  return globalObject[LIVE_STATE_KEY]!;
}

export function markLiveTestExecuted(scope: string): void {
  const state = getLiveExecutionState();
  state.executedCount += 1;
  state.scopes.add(scope.toLowerCase());
}

export function getLiveExecutionSummary(): {
  executedCount: number;
  scopes: string[];
} {
  const state = getLiveExecutionState();
  return {
    executedCount: state.executedCount,
    scopes: Array.from(state.scopes).sort(),
  };
}

export function resetLiveExecutionSummary(): void {
  const state = getLiveExecutionState();
  state.executedCount = 0;
  state.scopes.clear();
}
