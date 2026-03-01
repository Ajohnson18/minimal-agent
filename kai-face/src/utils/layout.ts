import { type SkillNode, type SkillNodeDef } from "../lib/skill-tree-data";

// ── Distances ───────────────────────────────────────────────────────────

const BRANCH_DIST = 180;
const TOOL_RING = 100;
const CLUSTER_RING = 170;
const TASK_ORBIT = 40;

const GAP = 0.06;
const SECTOR_HALF = Math.PI / 2; // 90° each side of branch direction

export const BRANCH_ANGLES: Record<string, number> = {
  engineering: Math.PI,
  design: 0,
  product: Math.PI / 2,
  general: -Math.PI / 2,
};

// ── Helpers ─────────────────────────────────────────────────────────────

function isLeaf(n: SkillNodeDef): boolean {
  return n.type === "tool" || n.type === "skill" || n.type === "task";
}

function angularWidth(pixelRadius: number, distance: number): number {
  return Math.max(0.06, (2 * pixelRadius) / distance);
}

function distribute(
  items: { id: string; angWidth: number; dist: number }[],
  centerAngle: number,
  halfArc: number,
  origin: { x: number; y: number },
  out: Map<string, { x: number; y: number }>,
) {
  if (items.length === 0) return;

  const totalWidth = items.reduce((s, it) => s + it.angWidth, 0);
  const totalGap = Math.max(0, items.length - 1) * GAP;
  const needed = totalWidth + totalGap;
  const available = halfArc * 2;
  const scale = needed > available ? available / needed : 1;
  const usedArc = Math.min(needed, available);

  let cursor = centerAngle - usedArc / 2;
  for (const item of items) {
    const w = item.angWidth * scale;
    const angle = cursor + w / 2;
    out.set(item.id, {
      x: Math.round(origin.x + Math.cos(angle) * item.dist),
      y: Math.round(origin.y + Math.sin(angle) * item.dist),
    });
    cursor += w + GAP * scale;
  }
}

function layoutClusterTasks(
  tasks: SkillNodeDef[],
  center: { x: number; y: number },
  outwardAngle: number,
  out: Map<string, { x: number; y: number }>,
) {
  if (tasks.length === 0) return;

  if (tasks.length === 1) {
    out.set(tasks[0].id, {
      x: Math.round(center.x + Math.cos(outwardAngle) * TASK_ORBIT),
      y: Math.round(center.y + Math.sin(outwardAngle) * TASK_ORBIT),
    });
    return;
  }

  const spread = Math.min(Math.PI * 1.2, tasks.length * 0.55);
  const step = spread / (tasks.length - 1);
  const startAngle = outwardAngle - spread / 2;

  for (let i = 0; i < tasks.length; i++) {
    const angle = startAngle + step * i;
    out.set(tasks[i].id, {
      x: Math.round(center.x + Math.cos(angle) * TASK_ORBIT),
      y: Math.round(center.y + Math.sin(angle) * TASK_ORBIT),
    });
  }
}

// ── Main layout ─────────────────────────────────────────────────────────

export function computeLayout(nodes: SkillNodeDef[]): SkillNode[] {
  if (nodes.length === 0) return [];
  const pos = new Map<string, { x: number; y: number }>();

  // 1. Brain at center
  pos.set("brain", { x: 0, y: 0 });

  // 2. Branches at fixed cardinal angles
  const branches = nodes.filter((n) => n.type === "branch");
  for (const b of branches) {
    const a = BRANCH_ANGLES[b.branch ?? ""] ?? BRANCH_ANGLES[b.id] ?? 0;
    pos.set(b.id, {
      x: Math.round(Math.cos(a) * BRANCH_DIST),
      y: Math.round(Math.sin(a) * BRANCH_DIST),
    });
  }

  // 3. Branch children — inner ring (tools) + outer ring (integration clusters)
  for (const branch of branches) {
    const bp = pos.get(branch.id)!;
    const center = BRANCH_ANGLES[branch.branch ?? ""] ?? BRANCH_ANGLES[branch.id] ?? 0;

    const directTools = nodes.filter(
      (n) => isLeaf(n) && n.branch === branch.id && !n.requiresIntegration,
    );
    const integrations = nodes.filter(
      (n) => n.type === "integration" && n.parentId === branch.id,
    );

    // Inner ring: direct tools — footprint includes label height
    const toolItems = directTools.map((n) => ({
      id: n.id,
      angWidth: angularWidth(42, TOOL_RING),
      dist: TOOL_RING,
    }));
    distribute(toolItems, center, SECTOR_HALF, bp, pos);

    // Outer ring: integration clusters — use fixed per-item step so fewer items sit closer together
    const clusterItems = integrations.map((int) => {
      const taskCount = nodes.filter(
        (n) => isLeaf(n) && n.requiresIntegration === int.id,
      ).length;
      const clusterRadius = taskCount > 0 ? TASK_ORBIT + 28 : 36;
      return {
        id: int.id,
        angWidth: angularWidth(clusterRadius, CLUSTER_RING),
        dist: CLUSTER_RING,
      };
    });
    distribute(clusterItems, center, SECTOR_HALF * 1.1, bp, pos);

    // Tasks within each cluster — tight arc facing outward from branch
    for (const int of integrations) {
      const intPos = pos.get(int.id);
      if (!intPos) continue;
      const tasks = nodes.filter(
        (n) => isLeaf(n) && n.requiresIntegration === int.id,
      );
      const outward = Math.atan2(intPos.y - bp.y, intPos.x - bp.x);
      layoutClusterTasks(tasks, intPos, outward, pos);
    }
  }

  // 4. Return positioned nodes
  return nodes.map((n) => ({
    ...n,
    x: Math.round(pos.get(n.id)?.x ?? 0),
    y: Math.round(pos.get(n.id)?.y ?? 0),
  }));
}
