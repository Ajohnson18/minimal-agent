import { BRANCH_COLORS, type SkillNode } from "../lib/skill-tree-data";

export function getNodeColor(node: SkillNode) {
  if (node.type === "brain") return { fill: "#0c1525", stroke: "#cbd5e1" };
  if (node.branch && BRANCH_COLORS[node.branch]) {
    const bc = BRANCH_COLORS[node.branch];
    if (node.status === "locked") return { fill: "#0f172a", stroke: bc.stroke };
    return { fill: "#1e293b", stroke: bc.stroke };
  }
  if (node.status === "locked") return { fill: "#0f172a", stroke: "#64748b" };
  if (node.status === "active") return { fill: "#1e293b", stroke: "#22c55e" };
  return { fill: "#1e293b", stroke: "#475569" };
}

export const NODE_RADIUS: Record<string, number> = { brain: 120, branch: 40, integration: 22, skill: 18, tool: 18, task: 12 };
