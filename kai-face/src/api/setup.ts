import { apiGet } from "./client";

export function getSkillTree() {
  return apiGet<{ nodes: SkillTreeDbNode[] }>("/setup/skill-tree");
}

export interface SkillTreeDbNode {
  id: string;
  label: string;
  description: string;
  nodeType: string;
  status: string;
  branch: string | null;
  parentId: string | null;
  credentialKey: string | null;
  requiresIntegration: string | null;
  tools: Array<{ name: string; description: string }>;
  setupTasks: Array<{ id: string; label: string; detectKey?: string; required?: boolean; completed: boolean }>;
}
