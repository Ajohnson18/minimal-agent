/**
 * Skills Loader
 *
 * Loads and configures skills for the agent using pi-coding-agent's built-in support.
 * Supports metadata gating (bins, anyBins, env).
 */
import type { Skill } from "@mariozechner/pi-coding-agent";
import { getAllSkillPaths } from "./config.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export type { Skill };

export interface SkillMetadata {
  gating?: {
    emoji?: string;
    requires?: {
      bins?: string[];
      anyBins?: string[];
      env?: string[];
      config?: string[];
    };
    always?: boolean;
  };
}

export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
  metadata?: SkillMetadata;
}

/**
 * Check if a binary exists on PATH.
 */
function binExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a skill passes its gating requirements.
 * Skills without metadata or without requires always pass.
 */
function passesGating(skill: SkillSummary): { pass: boolean; reason?: string } {
  const req = skill.metadata?.gating?.requires;
  if (!req) return { pass: true };
  if (skill.metadata?.gating?.always) return { pass: true };

  // Check bins: all must exist
  if (req.bins?.length) {
    const missing = req.bins.filter((b) => !binExists(b));
    if (missing.length > 0) {
      return { pass: false, reason: `missing bins: ${missing.join(", ")}` };
    }
  }

  // Check anyBins: at least one must exist
  if (req.anyBins?.length) {
    const hasAny = req.anyBins.some((b) => binExists(b));
    if (!hasAny) {
      return { pass: false, reason: `none of bins found: ${req.anyBins.join(", ")}` };
    }
  }

  // Check env: all must be set
  if (req.env?.length) {
    const missing = req.env.filter((e) => !process.env[e]);
    if (missing.length > 0) {
      return { pass: false, reason: `missing env: ${missing.join(", ")}` };
    }
  }

  return { pass: true };
}

/**
 * Discover skills from all configured directories.
 * Returns summaries without loading full content.
 * Skills that fail gating are filtered out.
 */
export async function discoverSkills(): Promise<SkillSummary[]> {
  const skillPaths = getAllSkillPaths();
  const skills: SkillSummary[] = [];
  const seenNames = new Set<string>();

  for (const dir of skillPaths) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillPath)) {
            const skill = parseSkillFile(skillPath, entry.name);
            if (skill && !seenNames.has(skill.name)) {
              const gate = passesGating(skill);
              if (gate.pass) {
                skills.push(skill);
                seenNames.add(skill.name);
              } else {
                console.log(`[SKILLS] Filtered "${skill.name}": ${gate.reason}`);
              }
            }
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const skillPath = join(dir, entry.name);
          const name = basename(entry.name, ".md");
          const skill = parseSkillFile(skillPath, name);
          if (skill && !seenNames.has(skill.name)) {
            const gate = passesGating(skill);
            if (gate.pass) {
              skills.push(skill);
              seenNames.add(skill.name);
            } else {
              console.log(`[SKILLS] Filtered "${skill.name}": ${gate.reason}`);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to scan skills directory ${dir}:`, error);
    }
  }

  return skills;
}

/**
 * Parse a skill file and extract name, description, and optional metadata from frontmatter.
 */
function parseSkillFile(
  filePath: string,
  fallbackName: string
): SkillSummary | null {
  try {
    const content = readFileSync(filePath, "utf-8");

    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || fallbackName;
    const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || "";

    if (!description) {
      return null;
    }

    // Parse optional metadata (single-line JSON in YAML frontmatter)
    let metadata: SkillMetadata | undefined;
    const metaMatch = frontmatter.match(/^metadata:\s*(.+)$/m);
    if (metaMatch) {
      try {
        const raw = metaMatch[1].trim();
        if (raw.startsWith("{")) {
          metadata = JSON.parse(raw) as SkillMetadata;
        }
      } catch {
        // Multi-line or invalid JSON metadata, try collecting lines
        try {
          const metaIdx = frontmatter.indexOf("metadata:");
          if (metaIdx >= 0) {
            let jsonStr = frontmatter.slice(metaIdx + "metadata:".length).trim();
            if (jsonStr.startsWith("{")) {
              // Find matching closing brace
              let depth = 0;
              let endIdx = 0;
              for (let i = 0; i < jsonStr.length; i++) {
                if (jsonStr[i] === "{") depth++;
                else if (jsonStr[i] === "}") depth--;
                if (depth === 0) { endIdx = i + 1; break; }
              }
              jsonStr = jsonStr.slice(0, endIdx);
              metadata = JSON.parse(jsonStr) as SkillMetadata;
            }
          }
        } catch {
          // Give up on metadata parsing — skill still loads without gating
        }
      }
    }

    return { name, description, filePath, metadata };
  } catch {
    return null;
  }
}

/**
 * Format skills for inclusion in system prompt.
 * Uses XML format per Agent Skills specification.
 * Replaces {baseDir} with the skill's directory path.
 */
function compactPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export function formatSkillsForPrompt(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "",
    "## Available Skills",
    "",
    "You have access to specialized skills. To use a skill, read its SKILL.md file.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    const baseDir = compactPath(dirname(skill.filePath));
    const skillPath = skill.filePath;
    lines.push(`  <skill name="${skill.name}">`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push(`    <path>${skillPath}</path>`);
    lines.push(`    <baseDir>${baseDir}</baseDir>`);
    lines.push(`  </skill>`);
  }

  lines.push("</available_skills>");
  lines.push("");
  lines.push(
    "When a task matches a skill's description, use the `read` tool to load its full instructions."
  );
  lines.push(
    "When reading a skill, replace {baseDir} with the skill's <baseDir> path."
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Load skills and return them for external use.
 */
export async function loadSkills(): Promise<{
  skills: SkillSummary[];
  promptSection: string;
}> {
  const skills = await discoverSkills();
  const promptSection = formatSkillsForPrompt(skills);

  console.log(
    `Loaded ${skills.length} skill(s):`,
    skills.map((s) => s.name).join(", ") || "(none)"
  );

  return { skills, promptSection };
}
