import type { PowerDefinition } from "./types.js";
import { getAllPowerPaths } from "./config.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";

/**
 * Parse a POWER.md file into a PowerDefinition.
 *
 * Expected frontmatter fields:
 *   name, description, icon, category, skills (comma-sep),
 *   tools (comma-sep), integrations (comma-sep), output
 *
 * Everything after the frontmatter `---` block is the prompt body.
 */
function parsePowerFile(
  filePath: string,
  fallbackId: string,
): PowerDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const body = content.slice(fmMatch[0].length).trim();

    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
      return m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    };

    const getList = (key: string): string[] => {
      const raw = get(key);
      if (!raw) return [];
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    };

    const getYamlList = (key: string): string[] => {
      const lines = fm.split("\n");
      const items: string[] = [];
      let inBlock = false;
      for (const line of lines) {
        if (new RegExp(`^${key}:\\s*$`).test(line)) {
          inBlock = true;
          continue;
        }
        if (inBlock) {
          const itemMatch = line.match(/^\s*-\s+(.+)$/);
          if (itemMatch) {
            items.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
          } else {
            break;
          }
        }
      }
      return items;
    };

    const getSteps = (): string[] => getYamlList("steps");

    const getArtifacts = (): Array<{ key: string; label: string; type: string }> => {
      const lines = fm.split("\n");
      const artifacts: Array<{ key: string; label: string; type: string }> = [];
      let inArtifacts = false;
      let current: Record<string, string> = {};
      for (const line of lines) {
        if (/^artifacts:\s*$/.test(line)) {
          inArtifacts = true;
          continue;
        }
        if (inArtifacts) {
          const itemStart = line.match(/^\s*-\s+(\w+):\s*(.+)$/);
          const fieldLine = line.match(/^\s+(\w+):\s*(.+)$/);
          if (itemStart) {
            if (current.key) artifacts.push({ key: current.key, label: current.label || current.key, type: current.type || "text" });
            current = { [itemStart[1]]: itemStart[2].trim().replace(/^["']|["']$/g, "") };
          } else if (fieldLine && inArtifacts) {
            current[fieldLine[1]] = fieldLine[2].trim().replace(/^["']|["']$/g, "");
          } else if (!/^\s/.test(line)) {
            break;
          }
        }
      }
      if (current.key) artifacts.push({ key: current.key, label: current.label || current.key, type: current.type || "text" });
      return artifacts;
    };

    const name = get("name");
    const description = get("description");
    if (!name || !description) return null;

    let refinements = "";
    const isDirectoryPower = filePath.endsWith("/POWER.md") || filePath.endsWith("\\POWER.md");
    const learnedPath = isDirectoryPower
      ? join(dirname(filePath), "LEARNED.md")
      : filePath.replace(/\.power\.md$/, ".learned.md");
    if (existsSync(learnedPath)) {
      try { refinements = readFileSync(learnedPath, "utf-8").trim(); } catch {}
    }

    return {
      id: get("id") || fallbackId,
      name,
      description,
      icon: get("icon") || "⚡",
      category: get("category") || "general",
      source: "local" as const,
      skills: getList("skills"),
      tools: getList("tools"),
      dependsOn: getList("integrations"),
      output: get("output") || "",
      steps: getSteps(),
      artifacts: getArtifacts(),
      prompt: body,
      refinements,
      previousPrompt: "",
      locked: false,
      filePath,
    };
  } catch {
    return null;
  }
}

export async function discoverPowers(): Promise<PowerDefinition[]> {
  const powerPaths = getAllPowerPaths();
  const powers: PowerDefinition[] = [];
  const seenIds = new Set<string>();

  console.log(`[POWERS] Scanning ${powerPaths.length} directories:`, powerPaths.map(d => `${d} (${existsSync(d) ? "exists" : "missing"})`).join(", "));

  for (const dir of powerPaths) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const powerPath = join(dir, entry.name, "POWER.md");
          if (existsSync(powerPath)) {
            const power = parsePowerFile(powerPath, entry.name);
            if (power && !seenIds.has(power.id)) {
              powers.push(power);
              seenIds.add(power.id);
            }
          }
        } else if (entry.isFile() && entry.name.endsWith(".power.md")) {
          const id = basename(entry.name, ".power.md");
          const power = parsePowerFile(join(dir, entry.name), id);
          if (power && !seenIds.has(power.id)) {
            powers.push(power);
            seenIds.add(power.id);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to scan powers directory ${dir}:`, error);
    }
  }

  console.log(
    `[POWERS] Loaded ${powers.length} power(s):`,
    powers.map((p) => p.name).join(", ") || "(none)",
  );

  return powers;
}
