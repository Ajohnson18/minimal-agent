import type { SkillNode } from "../../lib/skill-tree-data";

interface Props {
  node: SkillNode;
  requiresLabel?: string;
  size?: "sm" | "md";
}

export default function SkillRow({ node, requiresLabel, size = "sm" }: Props) {
  const pad = size === "md" ? "px-4 py-2.5" : "px-3 py-2";
  return (
    <div className={`flex items-center justify-between rounded-lg ${pad} ${
      node.status === "active" ? "bg-green-900/20 border border-green-800/30" :
      node.status === "available" ? "bg-gray-800/40 border border-gray-700/30" :
      "bg-gray-900/60 border border-gray-800/30 opacity-50"
    }`}>
      <span className={`text-gray-300 ${size === "md" ? "text-sm" : "text-xs"}`}>{node.label}</span>
      <div className="flex items-center gap-2">
        {requiresLabel && node.status === "locked" && <span className="text-[10px] text-gray-500">needs {requiresLabel}</span>}
        {node.status === "active" && <span className="text-[10px] text-green-400">✓</span>}
        {node.status === "available" && <span className="text-[10px] text-yellow-400">Ready</span>}
      </div>
    </div>
  );
}
