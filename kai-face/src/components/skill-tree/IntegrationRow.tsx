import type { SkillNode } from "../../lib/skill-tree-data";

interface Props {
  node: SkillNode;
  onClick: () => void;
  size?: "sm" | "md";
}

export default function IntegrationRow({ node, onClick, size = "sm" }: Props) {
  const iconSize = size === "md" ? "h-8 w-8" : "h-7 w-7";
  const pad = size === "md" ? "px-4 py-3 rounded-xl border border-gray-700/50" : "px-3 py-2.5 rounded-lg";

  return (
    <div onClick={onClick}
      className={`flex items-center gap-3 bg-gray-800/60 ${pad} cursor-pointer hover:bg-gray-800 transition-colors`}>
      <div className={`${iconSize} rounded-lg border-2 flex items-center justify-center text-[10px] font-bold shrink-0 ${
        node.status === "active" ? "border-green-500 text-green-400 bg-green-500/10" : "border-gray-600 text-gray-500 bg-gray-900"
      }`}>
        {node.logoChar ?? node.label.slice(0, 2)}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-medium text-gray-200 ${size === "md" ? "text-sm" : "text-xs"}`}>{node.label}</p>
        <p className={`text-gray-500 truncate ${size === "md" ? "text-[11px]" : "text-[10px]"}`}>{node.description}</p>
      </div>
      <span className={`shrink-0 ${size === "md" ? "text-xs" : "text-[10px]"} ${
        node.status === "active" ? "text-green-400" : node.credentialKey ? "text-blue-400" : "text-green-400"
      }`}>
        {node.status === "active" ? (size === "md" ? "✓ Connected" : "✓") : node.credentialKey ? "Add key →" : "Ready"}
      </span>
    </div>
  );
}
