export interface ToolInfo {
  name: string;
  description: string;
}

export interface SetupTask {
  id: string;
  label: string;
  detectKey?: string;
  required?: boolean;
}

export interface SkillNode {
  id: string;
  label: string;
  description: string;
  type: "brain" | "branch" | "integration" | "skill" | "tool" | "task";
  status: "locked" | "available" | "active";
  branch?: "engineering" | "design" | "product" | "general";
  parentId?: string;
  credentialKey?: string;
  requiresIntegration?: string;
  logoChar?: string;
  tools?: ToolInfo[];
  setupTasks?: SetupTask[];
  x: number;
  y: number;
}

export type SkillNodeDef = Omit<SkillNode, "x" | "y">;

export interface Connection {
  from: string;
  to: string;
}

export function getConnections(nodes: SkillNode[]): Connection[] {
  const conns: Connection[] = [];
  for (const n of nodes) {
    if (n.requiresIntegration) {
      conns.push({ from: n.requiresIntegration, to: n.id });
    } else if (n.parentId) {
      conns.push({ from: n.parentId, to: n.id });
    }
  }
  return conns;
}

export const BRANCH_COLORS: Record<string, { primary: string; glow: string; stroke: string }> = {
  engineering: { primary: "#f97316", glow: "#f9731640", stroke: "#fb923c" },
  design: { primary: "#a855f7", glow: "#a855f740", stroke: "#c084fc" },
  product: { primary: "#06b6d4", glow: "#06b6d440", stroke: "#22d3ee" },
  general: { primary: "#3b82f6", glow: "#3b82f640", stroke: "#60a5fa" },
};
