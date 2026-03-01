import type { UserCredentials } from "../db/schema/users.js";

const DANGEROUS_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYLIB",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
]);

const DANGEROUS_PREFIXES = ["LD_", "DYLD_"];

function isDangerousEnvVar(key: string): boolean {
  const upper = key.toUpperCase();
  if (DANGEROUS_ENV_VARS.has(upper)) return true;
  for (const prefix of DANGEROUS_PREFIXES) {
    if (upper.startsWith(prefix) && !DANGEROUS_ENV_VARS.has(upper)) return true;
  }
  if (upper === "PATH") return true;
  return false;
}

/**
 * Validate that user-provided env vars don't contain dangerous keys.
 * Throws if a dangerous var is detected.
 */
export function validateExecEnv(
  env: Array<{ key: string; value: string }>,
): void {
  for (const { key } of env) {
    if (isDangerousEnvVar(key)) {
      throw new Error(
        `Security: environment variable '${key}' is forbidden in exec calls.`,
      );
    }
  }
}

/**
 * Build the env for an exec call:
 * 1. Start with process.env
 * 2. Inject user credentials as env vars (key uppercased)
 * 3. Merge user-provided env vars (from tool call)
 * 4. Validate no dangerous vars
 */
export function buildExecEnv(
  baseEnv: NodeJS.ProcessEnv,
  userEnv?: Array<{ key: string; value: string }>,
  userCredentials?: UserCredentials | null,
): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv } as Record<string, string>;

  if (userCredentials?.custom) {
    for (const { key, value } of userCredentials.custom) {
      const envName = key.toUpperCase();
      if (!isDangerousEnvVar(envName)) {
        env[envName] = value;
      }
    }
  }

  if (userEnv) {
    validateExecEnv(userEnv);
    for (const { key, value } of userEnv) {
      env[key] = value;
    }
  }

  return env;
}
