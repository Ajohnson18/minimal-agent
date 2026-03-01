/**
 * Skills Watcher
 *
 * Watches skill directories for changes and triggers re-discovery.
 * New/changed skills become available on the next agent turn.
 */
import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { getAllSkillPaths } from "./config.js";
import { loadSkills, type SkillSummary } from "./loader.js";

let cachedSkills: { skills: SkillSummary[]; promptSection: string } | null =
  null;
let dirty = true;
const watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

function markDirty() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    dirty = true;
    console.log("[SKILLS-WATCHER] Change detected, will reload on next turn");
  }, DEBOUNCE_MS);
  debounceTimer.unref();
}

/**
 * Start watching all skill directories for changes.
 */
export function startSkillsWatcher(): void {
  stopSkillsWatcher();

  const dirs = getAllSkillPaths();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith("SKILL.md")) {
          markDirty();
        }
      });
      watchers.push(watcher);
    } catch (err) {
      console.warn(`[SKILLS-WATCHER] Failed to watch ${dir}:`, err);
    }
  }

  if (watchers.length > 0) {
    console.log(
      `[SKILLS-WATCHER] Watching ${watchers.length} skill directory(ies)`
    );
  }
}

/**
 * Stop all watchers.
 */
export function stopSkillsWatcher(): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  watchers.length = 0;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Get skills, reloading only if changes were detected.
 * Use this instead of loadSkills() directly to benefit from caching + hot-reload.
 */
export async function getSkills(): Promise<{
  skills: SkillSummary[];
  promptSection: string;
}> {
  if (!cachedSkills || dirty) {
    cachedSkills = await loadSkills();
    dirty = false;
  }
  return cachedSkills;
}
