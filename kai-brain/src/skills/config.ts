/**
 * Skills Configuration
 *
 * Configures skill discovery locations for AVA.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Get skill directories to scan.
 * Returns directories in order of precedence.
 */
export function getSkillDirectories(): string[] {
  const home = homedir();

  return [
    // AVA-specific skills (highest priority)
    join(home, ".ava", "skills"),

    // Pi agent default locations
    join(home, ".pi", "agent", "skills"),

    // Compatible with Claude Code skills
    join(home, ".claude", "skills"),

    // Compatible with Codex skills
    join(home, ".codex", "skills"),

    // Project-local skills
    join(process.cwd(), ".ava", "skills"),
    join(process.cwd(), ".pi", "skills"),

    // Bundled skills (shipped with AVA, lowest priority)
    join(process.cwd(), "skills"),
  ];
}

/**
 * Environment variable for custom skills directory.
 */
export const SKILLS_DIR = process.env.SKILLS_DIR;

/**
 * Get all skill paths including custom directory.
 */
export function getAllSkillPaths(): string[] {
  const dirs = getSkillDirectories();

  // Add custom directory from env if specified
  if (SKILLS_DIR) {
    dirs.unshift(SKILLS_DIR);
  }

  return dirs;
}
