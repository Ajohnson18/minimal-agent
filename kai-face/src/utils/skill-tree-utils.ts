import { type SkillNode, type SkillNodeDef } from "../lib/skill-tree-data";
import { type SkillTreeDbNode } from "../api/setup";
import { type OnboardPhase } from "../components/skill-tree/SkillTree";
import { computeLayout } from "./layout";

export function mapNodes(dbNodes: SkillTreeDbNode[]): SkillNode[] {
  const unmapped: SkillNodeDef[] = dbNodes.map((n) => ({
    id: n.id,
    label: n.label,
    description: n.description,
    type: n.nodeType as SkillNode["type"],
    status: n.status as SkillNode["status"],
    branch: n.branch as SkillNode["branch"],
    parentId: n.parentId ?? undefined,
    credentialKey: n.credentialKey ?? undefined,
    requiresIntegration: n.requiresIntegration ?? undefined,
    tools: n.tools,
    setupTasks: n.setupTasks?.map((t) => ({ id: t.id, label: t.label, detectKey: t.detectKey, required: t.required })),
  }));
  return computeLayout(unmapped);
}

export function derivePhase(nodes: SkillNode[]): OnboardPhase {
  const brain = nodes.find((n) => n.id === "brain");
  const branches = nodes.filter((n) => n.type === "branch");
  if (brain?.status !== "active") return "brain";
  if (branches.some((b) => b.status !== "active")) return "branches";
  return "complete";
}

export function deriveCompletedTasks(dbNodes: SkillTreeDbNode[]): Set<string> {
  const done = new Set<string>();
  for (const n of dbNodes) {
    for (const t of n.setupTasks ?? []) {
      if (t.completed) done.add(t.id);
    }
  }
  return done;
}
