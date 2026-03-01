import type { PowerDefinition, PowerInfo, PowerArtifactDeclaration } from "./types.js";
import { discoverPowers } from "./loader.js";
import { getWritablePowersDir } from "./config.js";
import { db } from "../db/client.js";
import { kaiSkillTreeNodes } from "../db/schema/settings.js";
import { kaiPowers } from "../db/schema/powers.js";
import { kaiPowerVersions } from "../db/schema/power-versions.js";
import { eq, desc } from "drizzle-orm";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

let cachedPowers: PowerDefinition[] | null = null;

// ---------------------------------------------------------------------------
// Loading — files are the source of truth, DB is metadata
// ---------------------------------------------------------------------------

export async function getAllPowers(): Promise<PowerDefinition[]> {
  if (!cachedPowers) {
    const filePowers = await discoverPowers();
    try {
      await syncFilePowersToDb(filePowers);
      await mergeDbMetadataIntoFilePowers(filePowers);
      cachedPowers = filePowers;
    } catch (err) {
      console.warn("[POWERS] DB sync failed, serving file-discovered powers only:", err);
      cachedPowers = filePowers;
    }
  }
  return cachedPowers;
}

export function reloadPowers(): void {
  cachedPowers = null;
}

export async function getPowerById(
  id: string,
): Promise<PowerDefinition | undefined> {
  const powers = await getAllPowers();
  return powers.find((p) => p.id === id);
}

/**
 * Sync file-discovered powers into DB for metadata tracking.
 * Also snapshots a version when the prompt changes.
 */
async function syncFilePowersToDb(powers: PowerDefinition[]): Promise<void> {
  // Load existing prompt hashes to detect changes
  const existing = await db
    .select({ id: kaiPowers.id, prompt: kaiPowers.prompt })
    .from(kaiPowers);
  const oldPromptMap = new Map(existing.map((r) => [r.id, r.prompt ?? ""]));

  for (const p of powers) {
    const fileName = basename(p.filePath);
    const oldPrompt = oldPromptMap.get(p.id);
    const isNew = oldPrompt === undefined;
    const promptChanged = !isNew && oldPrompt !== p.prompt && p.prompt.length > 0;

    // Snapshot version if prompt changed
    if (promptChanged) {
      try {
        await db.insert(kaiPowerVersions).values({
          id: crypto.randomUUID(),
          powerId: p.id,
          prompt: oldPrompt,
          changeNote: "Before update",
        });
      } catch {}
    }

    // Snapshot initial version for new powers
    if (isNew && p.prompt.length > 0) {
      try {
        await db.insert(kaiPowerVersions).values({
          id: crypto.randomUUID(),
          powerId: p.id,
          prompt: p.prompt,
          changeNote: "Initial version",
        });
      } catch {}
    }

    await db
      .insert(kaiPowers)
      .values({
        id: p.id,
        name: p.name,
        description: p.description,
        fileName,
        icon: p.icon,
        category: p.category,
        source: "local",
        enabled: true,
        dependsOn: p.dependsOn,
        skills: p.skills,
        tools: p.tools,
        steps: p.steps,
        artifacts: p.artifacts,
        output: p.output,
        prompt: p.prompt,
      })
      .onConflictDoUpdate({
        target: kaiPowers.id,
        set: {
          name: p.name,
          description: p.description,
          fileName,
          icon: p.icon,
          category: p.category,
          source: "local",
          dependsOn: p.dependsOn,
          skills: p.skills,
          tools: p.tools,
          steps: p.steps,
          artifacts: p.artifacts,
          output: p.output,
          prompt: p.prompt,
          updatedAt: new Date(),
        },
      });
  }
  if (powers.length > 0) {
    console.log(`[POWERS] Synced ${powers.length} power(s) to database`);
  }
}

/**
 * Pull DB-only metadata (refinements, locked, previousPrompt) into file powers.
 */
async function mergeDbMetadataIntoFilePowers(filePowers: PowerDefinition[]): Promise<void> {
  if (filePowers.length === 0) return;
  const ids = filePowers.map((p) => p.id);
  const dbRows = await db
    .select({
      id: kaiPowers.id,
      refinements: kaiPowers.refinements,
      previousPrompt: kaiPowers.previousPrompt,
      locked: kaiPowers.locked,
    })
    .from(kaiPowers);
  const metaMap = new Map(
    dbRows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]),
  );
  for (const p of filePowers) {
    const meta = metaMap.get(p.id);
    if (meta) {
      if (meta.refinements && !p.refinements) p.refinements = meta.refinements;
      if (meta.previousPrompt) p.previousPrompt = meta.previousPrompt ?? "";
      p.locked = meta.locked;
    }
  }
}

// ---------------------------------------------------------------------------
// Delete / community install (DB operations)
// ---------------------------------------------------------------------------

export async function deletePower(powerId: string): Promise<boolean> {
  const power = await getPowerById(powerId);
  if (!power) return false;
  await db.update(kaiPowers).set({ enabled: false, updatedAt: new Date() }).where(eq(kaiPowers.id, powerId));
  reloadPowers();
  return true;
}

export async function installCommunityPower(params: {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  dependsOn: string[];
  steps: string[];
  prompt: string;
}): Promise<PowerInfo> {
  // Write the file so it becomes a local power
  writePowerFile({
    id: params.id,
    name: params.name,
    description: params.description,
    icon: params.icon,
    category: params.category,
    dependsOn: params.dependsOn,
    steps: params.steps,
    prompt: params.prompt,
  });

  reloadPowers();

  const activeIntegrations = await getActiveIntegrations();
  const deps = params.dependsOn;
  const missing = deps.filter((d) => !activeIntegrations.has(d));

  return {
    id: params.id,
    name: params.name,
    description: params.description,
    fileName: "POWER.md",
    icon: params.icon,
    category: params.category,
    source: "local",
    enabled: true,
    dependsOn: deps,
    skills: [],
    tools: [],
    steps: params.steps,
    artifacts: [],
    output: "",
    available: missing.length === 0,
    missingIntegrations: missing,
  };
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export interface PowerVersion {
  id: string;
  prompt: string;
  changeNote: string;
  createdAt: number;
}

export async function getPowerVersions(powerId: string, limit = 20): Promise<PowerVersion[]> {
  const rows = await db
    .select()
    .from(kaiPowerVersions)
    .where(eq(kaiPowerVersions.powerId, powerId))
    .orderBy(desc(kaiPowerVersions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    prompt: r.prompt,
    changeNote: r.changeNote ?? "",
    createdAt: r.createdAt.getTime(),
  }));
}

// ---------------------------------------------------------------------------
// Refinements & prompt rewrite — metadata in DB, logic in file
// ---------------------------------------------------------------------------

export async function updatePowerRefinements(powerId: string, refinements: string): Promise<void> {
  await db
    .update(kaiPowers)
    .set({ refinements, updatedAt: new Date() })
    .where(eq(kaiPowers.id, powerId));
  reloadPowers();
}

export async function updatePowerPrompt(powerId: string, newPrompt: string, previousPrompt: string): Promise<void> {
  // Archive previous prompt in DB for rollback
  await db
    .update(kaiPowers)
    .set({ previousPrompt, updatedAt: new Date() })
    .where(eq(kaiPowers.id, powerId));

  // Rewrite the POWER.md file — source of truth
  const power = await getPowerById(powerId);
  if (power?.filePath && existsSync(power.filePath)) {
    rewritePowerFilePrompt(power.filePath, newPrompt);
  }

  reloadPowers();
}

export async function getPowerRefinements(powerId: string): Promise<string> {
  const [row] = await db
    .select({ refinements: kaiPowers.refinements })
    .from(kaiPowers)
    .where(eq(kaiPowers.id, powerId));
  return row?.refinements ?? "";
}

// ---------------------------------------------------------------------------
// File write helpers (internal only — used by community install & prompt rewrite)
// ---------------------------------------------------------------------------

function writePowerFile(power: {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
  dependsOn?: string[];
  skills?: string[];
  tools?: string[];
  steps?: string[];
  artifacts?: PowerArtifactDeclaration[];
  output?: string;
  prompt?: string;
}): void {
  const powersDir = getWritablePowersDir();
  const dir = join(powersDir, power.id);
  if (!existsSync(powersDir)) mkdirSync(powersDir, { recursive: true });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const fm: string[] = ["---"];
  fm.push(`id: ${power.id}`);
  fm.push(`name: ${power.name}`);
  fm.push(`description: ${power.description}`);
  if (power.icon) fm.push(`icon: ${power.icon}`);
  if (power.category) fm.push(`category: ${power.category}`);
  if (power.dependsOn?.length) fm.push(`integrations: ${power.dependsOn.join(", ")}`);
  if (power.skills?.length) fm.push(`skills: ${power.skills.join(", ")}`);
  if (power.tools?.length) fm.push(`tools: ${power.tools.join(", ")}`);
  if (power.output) fm.push(`output: ${power.output}`);
  if (power.steps?.length) {
    fm.push("steps:");
    for (const s of power.steps) fm.push(`  - ${s}`);
  }
  if (power.artifacts?.length) {
    fm.push("artifacts:");
    for (const a of power.artifacts) {
      fm.push(`  - key: ${a.key}`);
      fm.push(`    label: ${a.label}`);
      fm.push(`    type: ${a.type}`);
    }
  }
  fm.push("---");

  writeFileSync(join(dir, "POWER.md"), `${fm.join("\n")}\n\n${power.prompt || ""}\n`, "utf-8");
}

function rewritePowerFilePrompt(filePath: string, newPrompt: string): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^(---\s*\n[\s\S]*?\n---)\s*/);
    if (fmMatch) {
      writeFileSync(filePath, `${fmMatch[1]}\n\n${newPrompt}\n`, "utf-8");
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getActiveIntegrations(): Promise<Set<string>> {
  const nodes = await db
    .select({ id: kaiSkillTreeNodes.id, status: kaiSkillTreeNodes.status })
    .from(kaiSkillTreeNodes)
    .where(eq(kaiSkillTreeNodes.nodeType, "integration"));
  return new Set(nodes.filter((n) => n.status === "active").map((n) => n.id));
}

export async function getAvailablePowers(): Promise<PowerInfo[]> {
  const powers = await getAllPowers();

  let activeIntegrations = new Set<string>();
  let enabledMap = new Map<string, boolean>();

  try {
    activeIntegrations = await getActiveIntegrations();
    const enabledIds = await db
      .select({ id: kaiPowers.id, enabled: kaiPowers.enabled })
      .from(kaiPowers);
    enabledMap = new Map(enabledIds.map((r) => [r.id, r.enabled]));
  } catch {
    // DB not ready — serve powers with default availability
  }

  return powers.map((p) => {
    const enabled = enabledMap.get(p.id) ?? true;
    const missing = p.dependsOn.filter((i) => !activeIntegrations.has(i));
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      fileName: basename(p.filePath),
      icon: p.icon,
      category: p.category,
      source: p.source,
      enabled,
      dependsOn: p.dependsOn,
      skills: p.skills,
      tools: p.tools,
      steps: p.steps,
      artifacts: p.artifacts,
      output: p.output,
      available: enabled && missing.length === 0,
      missingIntegrations: missing,
    };
  });
}
