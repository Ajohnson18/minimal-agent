import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { kaiSettings, kaiOnboarding, kaiSkillTreeNodes } from "../db/schema/settings.js";
import { getCatalogEntry } from "../lib/tool-catalog.js";

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: kaiSettings.value })
    .from(kaiSettings)
    .where(eq(kaiSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(kaiSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: kaiSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function isOnboarded(): Promise<boolean> {
  const val = await getSetting("onboarded");
  return val === "true";
}

export async function getOnboardingQuestions() {
  return db.select().from(kaiOnboarding).orderBy(kaiOnboarding.step);
}

export async function setOnboardingAnswer(questionKey: string, answer: string): Promise<boolean> {
  const result = await db
    .update(kaiOnboarding)
    .set({ answer, updatedAt: new Date() })
    .where(eq(kaiOnboarding.questionKey, questionKey));
  return (result.rowCount ?? 0) > 0;
}

export async function getOnboardingAnswers(): Promise<Record<string, string>> {
  const rows = await db
    .select({ questionKey: kaiOnboarding.questionKey, answer: kaiOnboarding.answer })
    .from(kaiOnboarding);
  const answers: Record<string, string> = {};
  for (const row of rows) {
    if (row.answer) answers[row.questionKey] = row.answer;
  }
  return answers;
}

// ── Skill Tree ───────────────────────────────────────────────

export async function getSkillTreeNodes() {
  return db.select().from(kaiSkillTreeNodes).orderBy(kaiSkillTreeNodes.sortOrder);
}

export async function getSkillTreeNode(id: string) {
  const [node] = await db.select().from(kaiSkillTreeNodes).where(eq(kaiSkillTreeNodes.id, id)).limit(1);
  return node ?? null;
}

export async function updateSkillTreeNode(
  id: string,
  updates: Partial<{
    status: string;
    setupTasks: Array<{ id: string; label: string; detectKey?: string; completed: boolean }>;
  }>,
) {
  await db
    .update(kaiSkillTreeNodes)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(kaiSkillTreeNodes.id, id));
}

export async function unlockChildSkills(integrationId: string) {
  await db
    .update(kaiSkillTreeNodes)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      sql`${kaiSkillTreeNodes.requiresIntegration} = ${integrationId} AND ${kaiSkillTreeNodes.status} = 'locked'`
    );
}

export async function unlockBranchChildren(branch: string) {
  await db
    .update(kaiSkillTreeNodes)
    .set({ status: "available", updatedAt: new Date() })
    .where(
      sql`${kaiSkillTreeNodes.branch} = ${branch} AND ${kaiSkillTreeNodes.nodeType} = 'integration' AND ${kaiSkillTreeNodes.status} = 'locked'`
    );
}

// ── Tool Selection ────────────────────────────────────────────

export async function getSelectedToolIds(): Promise<string[]> {
  const answers = await getOnboardingAnswers();
  const raw = answers.team_tools;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function seedSelectedIntegrations(selectedToolIds: string[]) {
  const ids = new Set(selectedToolIds);
  const integrations: Array<typeof kaiSkillTreeNodes.$inferInsert> = [];
  const tasks: Array<typeof kaiSkillTreeNodes.$inferInsert> = [];

  for (const id of ids) {
    const entry = getCatalogEntry(id);
    if (!entry) continue;

    integrations.push({
      id: entry.id,
      label: entry.name,
      description: entry.description,
      nodeType: "integration",
      status: "locked",
      branch: entry.category,
      parentId: entry.category,
      credentialKey: entry.credentialKey,
      sortOrder: 10,
    });

    for (const t of entry.tasks) {
      tasks.push({
        id: `task:${entry.id}-${t.suffix}`,
        label: t.label,
        description: t.description,
        nodeType: "task",
        status: "locked",
        branch: entry.category,
        parentId: entry.category,
        requiresIntegration: entry.id,
        sortOrder: 300,
      });
    }
  }

  if (integrations.length > 0) {
    await db.insert(kaiSkillTreeNodes).values(integrations).onConflictDoNothing();
  }
  if (tasks.length > 0) {
    await db.insert(kaiSkillTreeNodes).values(tasks).onConflictDoNothing();
  }
}
