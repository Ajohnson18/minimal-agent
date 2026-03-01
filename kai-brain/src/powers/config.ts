import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AVA_WORKSPACE_DIR = process.env.AVA_WORKSPACE_DIR;

function findRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

let _repoRoot: string | null | undefined;
function repoRoot(): string | null {
  if (_repoRoot === undefined) _repoRoot = findRepoRoot();
  return _repoRoot;
}

export function getPowerDirectories(): string[] {
  const home = homedir();
  const root = repoRoot();

  return [
    ...(AVA_WORKSPACE_DIR ? [join(AVA_WORKSPACE_DIR, "powers")] : []),
    join(home, ".ava", "powers"),
    join(process.cwd(), ".ava", "powers"),
    join(process.cwd(), "powers"),
    // kai-data/powers relative to the monorepo root (maps to /mnt/kai-data/powers in production)
    ...(root ? [join(root, "kai-data", "powers")] : []),
    join(process.cwd(), "kai-data", "powers"),
    join(process.cwd(), "..", "kai-data", "powers"),
    // Bundled powers shipped with kai-brain (relative to compiled output)
    join(__dirname, "..", "..", "powers"),
  ];
}

export const POWERS_DIR = process.env.POWERS_DIR;

export function getAllPowerPaths(): string[] {
  const dirs = getPowerDirectories();
  if (POWERS_DIR) {
    dirs.unshift(POWERS_DIR);
  }
  return dirs;
}

/**
 * Returns the directory where new powers should be written to disk.
 * Priority: POWERS_DIR env var > kai-data/powers from repo root > first existing dir.
 */
export function getWritablePowersDir(): string {
  if (POWERS_DIR) return POWERS_DIR;

  // Prefer kai-data/powers if it exists (version-controllable)
  const root = repoRoot();
  if (root) {
    const kaiDataPowers = join(root, "kai-data", "powers");
    if (existsSync(kaiDataPowers)) return kaiDataPowers;
  }

  const dirs = getPowerDirectories();
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }
  return join(process.cwd(), "powers");
}
