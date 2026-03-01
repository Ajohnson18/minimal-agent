import { memo } from "react";
import type { SkillNode } from "../../lib/skill-tree-data";
import { getNodeColor, NODE_RADIUS } from "../../utils/node-colors";
import { getIntegrationLogoUrl } from "../../utils/integration-logos";

interface Props {
  node: SkillNode;
  isSelected: boolean;
  isInChain: boolean;
  isClickable: boolean;
  isExpanded?: boolean;
  isActiveTool?: boolean;
  isNew?: boolean;
  isCommandActive?: boolean;
  isDragging?: boolean;
  phase: string;
  onNodeClick: (id: string) => void;
  onDragStart?: (id: string, e: React.MouseEvent) => void;
}

const ANIM_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const ANIM_DUR = "0.5s";

export const SkillTreeNode = memo(function SkillTreeNode({ node, isSelected, isInChain, isClickable, isExpanded, isActiveTool, isNew, isCommandActive, isDragging, phase, onNodeClick, onDragStart }: Props) {
  const r = NODE_RADIUS[node.type] ?? 18;
  const brainIdle = node.type === "brain" && phase !== "brain" && !isCommandActive;
  const color = getNodeColor(node);
  const isIntegration = node.type === "integration";
  const isLocked = node.status === "locked";
  const isLeaf = node.type !== "brain" && node.type !== "branch";
  const collapsed = isLeaf && isExpanded === false;

  return (
    <g
      data-node-id={node.id}
      style={{
        transform: `translate(${node.x}px, ${node.y}px)`,
        transition: isDragging ? "none" : `transform ${ANIM_DUR} ${ANIM_EASE}`,
      }}
      onMouseDown={(e) => { if (onDragStart) { e.stopPropagation(); onDragStart(node.id, e); } }}
      onClick={(e) => { e.stopPropagation(); if (isClickable) onNodeClick(node.id); }}
      className={`skill-node-group ${isClickable ? "cursor-pointer" : "cursor-default"}`}
      opacity={isLocked && phase !== "brain" ? (isIntegration ? 0.6 : 0.55) : 1}
    >
      {/* New node spawn — rings expand from node position */}
      {isNew && (
        <>
          <circle r={r} fill="transparent" stroke={color.stroke} strokeWidth={2} opacity={0}>
            <animate attributeName="r" from={String(r)} to={String(r + 50)} dur="2s" begin="0.5s" fill="freeze" />
            <animate attributeName="opacity" values="0.9;0.5;0" keyTimes="0;0.4;1" dur="2s" begin="0.5s" fill="freeze" />
            <animate attributeName="stroke-width" from="3" to="0.5" dur="2s" begin="0.5s" fill="freeze" />
          </circle>
          <circle r={r} fill="transparent" stroke={color.stroke} strokeWidth={1.5} opacity={0}>
            <animate attributeName="r" from={String(r)} to={String(r + 35)} dur="1.8s" begin="0.8s" fill="freeze" />
            <animate attributeName="opacity" values="0.7;0.3;0" keyTimes="0;0.5;1" dur="1.8s" begin="0.8s" fill="freeze" />
          </circle>
          <circle r={r} fill="transparent" stroke={color.stroke} strokeWidth={1} opacity={0}>
            <animate attributeName="r" from={String(r)} to={String(r + 24)} dur="1.5s" begin="1.1s" fill="freeze" />
            <animate attributeName="opacity" values="0.5;0.2;0" keyTimes="0;0.5;1" dur="1.5s" begin="1.1s" fill="freeze" />
          </circle>
          <circle r={r + 6} fill="transparent" stroke={color.stroke} strokeWidth={1} opacity={0}>
            <animate attributeName="opacity" values="0;0.6;0.3;0.5;0" keyTimes="0;0.15;0.4;0.7;1" dur="4s" begin="0.5s" fill="freeze" />
          </circle>
        </>
      )}

      {/* Inner group for spawn scale animation — isolated from position transform */}
      <g>
        {isNew && (
          <>
            <animateTransform attributeName="transform" type="scale" from="0" to="1" dur="1.4s" begin="0.3s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1" keyTimes="0;1" />
            <animate attributeName="opacity" from="0" to="1" dur="0.6s" begin="0.3s" fill="freeze" />
          </>
        )}

        <g style={node.type === "brain" && phase !== "brain" ? {
          transform: `scale(${isCommandActive ? 1 : 0.6})`,
          transition: "transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
          transformOrigin: "0px 0px",
        } : collapsed && !isIntegration ? {
          transform: "scale(0.6)",
          transition: `transform ${ANIM_DUR} ${ANIM_EASE}`,
          transformOrigin: "0px 0px",
        } : undefined}>

        {/* Active tool highlight */}
        {isActiveTool && (
          <circle r={r + 14} fill="transparent" stroke="#22d3ee" strokeWidth={2} opacity={0.6} style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}>
            <animate attributeName="r" from={String(r + 8)} to={String(r + 20)} dur="1s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.8" to="0" dur="1s" repeatCount="indefinite" />
          </circle>
        )}

        {isInChain && (
          <circle r={r + 12} fill="transparent" stroke={color.stroke} strokeWidth={1} opacity={0.3}>
            <animate attributeName="r" from={String(r + 6)} to={String(r + 18)} dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" from="0.4" to="0" dur="2s" repeatCount="indefinite" />
          </circle>
        )}

        {isSelected && (
          <circle r={r + 6} fill="transparent" stroke="#3b82f6" strokeWidth={2} style={{ filter: "drop-shadow(0 0 4px #3b82f6)" }} />
        )}

        {(node.type === "brain" || node.type === "branch") && node.status === "active" && (
          <circle r={r + 4} fill="transparent" stroke={color.stroke} strokeWidth={0.5} opacity={0.3} />
        )}

        {isIntegration ? (() => {
          const logoUrl = getIntegrationLogoUrl(node.id);
          const clipId = `clip-${node.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
          const iconR = r * 0.6;
          return (
            <>
              <defs>
                <clipPath id={clipId}>
                  <circle r={iconR} />
                </clipPath>
              </defs>
              <circle r={r} fill={isLocked ? "#0f172a" : "#0f172a"}
                stroke={color.stroke} strokeWidth={1.5}
                strokeDasharray={isLocked ? "3 3" : "none"} />
              {logoUrl ? (
                <image
                  href={logoUrl}
                  x={-iconR} y={-iconR}
                  width={iconR * 2} height={iconR * 2}
                  clipPath={`url(#${clipId})`}
                  className="pointer-events-none"
                  opacity={isLocked ? 0.4 : 0.9}
                />
              ) : (
                <text textAnchor="middle" dy="0.35em"
                  className="pointer-events-none select-none font-bold"
                  style={{ fontSize: 12, fill: isLocked ? "#64748b" : color.stroke }}>
                  {node.logoChar ?? node.label.slice(0, 2)}
                </text>
              )}
              <text y={r + 16}
                textAnchor="middle" className="pointer-events-none select-none"
                style={{ fontSize: collapsed ? 5 : 12, fill: isLocked ? "#64748b" : "#94a3b8", letterSpacing: "0.01em", transition: `font-size ${ANIM_DUR} ${ANIM_EASE}, opacity ${ANIM_DUR} ${ANIM_EASE}` }}
                opacity={collapsed ? 0.4 : isLocked ? 0.6 : 0.8}>
                {node.label}
              </text>
              {isLocked && (
                <g transform={`translate(${r * 0.55}, ${-r * 0.55}) scale(0.55)`} className="pointer-events-none">
                  <rect x="-6" y="-2" width="12" height="10" rx="1.5" fill="#0f172a" stroke={color.stroke} strokeWidth="1.5" opacity={0.8} />
                  <path d="M-3-2V-5a3 3 0 016 0v3" fill="none" stroke={color.stroke} strokeWidth="1.5" strokeLinecap="round" opacity={0.8} />
                </g>
              )}
            </>
          );
        })() : (
          <>
            <circle r={r} fill={color.fill} stroke={color.stroke}
              strokeWidth={node.type === "brain" ? 2 : node.type === "branch" ? 2.5 : 1.5}
              strokeDasharray={isLocked && node.type !== "brain" && node.type !== "branch" ? "3 3" : "none"}
              style={node.type === "brain" ? { filter: `drop-shadow(0 0 4px ${color.stroke})` } : undefined} />

            {node.type === "brain" && (
              <circle r={r - 8} fill="none" stroke={color.stroke} strokeWidth={0.5} opacity={0.15} />
            )}

            {node.type !== "brain" && (
              <text y={r + (node.type === "branch" ? 20 : 16)}
                textAnchor="middle" className="pointer-events-none select-none"
                style={{
                  fontSize: node.type === "branch" ? 14 : collapsed ? 5 : 12,
                  fill: isLocked ? "#64748b" : "#94a3b8",
                  letterSpacing: node.type === "branch" ? "0.02em" : "0.01em",
                  transition: `font-size ${ANIM_DUR} ${ANIM_EASE}, opacity ${ANIM_DUR} ${ANIM_EASE}`,
                }}
                opacity={collapsed ? 0.4 : isLocked ? 0.6 : 0.8}>
                {node.label}
              </text>
            )}

            {isLocked && node.requiresIntegration && (
              <text y={r + 28}
                textAnchor="middle" className="pointer-events-none select-none"
                style={{ fontSize: collapsed ? 4 : 9, fill: "#f59e0b", letterSpacing: "0.02em", transition: `font-size ${ANIM_DUR} ${ANIM_EASE}, opacity ${ANIM_DUR} ${ANIM_EASE}` }}
                opacity={collapsed ? 0.3 : 0.7}>
                needs {node.requiresIntegration}
              </text>
            )}

            {node.type === "brain" && (
              <>
                <text textAnchor="middle"
                  dy={phase === "brain" || brainIdle ? "0.35em" : "-4em"}
                  className="fill-white pointer-events-none select-none"
                  style={{
                    fontSize: phase === "brain" || brainIdle ? 52 : 18,
                    fontWeight: 700,
                    opacity: phase === "brain" ? 1 : isCommandActive ? 0.4 : 0.85,
                  }}>改善</text>
                {phase === "brain" && node.status !== "active" && (
                  <text textAnchor="middle" dy="4.5em" className="fill-blue-300 pointer-events-none select-none"
                    style={{ fontSize: 10 }}>click to setup</text>
                )}
              </>
            )}

            {node.type === "branch" && (
              <text textAnchor="middle" dy="0.35em" className="fill-gray-300 pointer-events-none select-none"
                style={{ fontSize: 13, fontWeight: 600 }} opacity={isLocked ? 0.3 : 0.9}>
                {node.label.charAt(0)}
              </text>
            )}

            {node.type === "tool" && (
              <g transform={`scale(${r / 28})`} className="pointer-events-none">
                <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
                  fill="none" stroke={isLocked ? "#475569" : "#9ca3af"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  transform="translate(-12, -12)" />
              </g>
            )}

            {node.type === "skill" && (
              <g transform={`scale(${r / 28})`} className="pointer-events-none">
                <path d="M13 2L3 14h9l-1 10 10-12h-9l1-10z"
                  fill="none" stroke={isLocked ? "#475569" : "#9ca3af"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  transform="translate(-12, -12)" />
              </g>
            )}

            {node.type === "task" && (
              <g transform={`scale(${r / 28})`} className="pointer-events-none">
                <circle cx="0" cy="0" r="10" fill="none" stroke={isLocked ? "#475569" : "#9ca3af"} strokeWidth="2" />
                {!isLocked && <path d="M-4 0l3 3 5-6" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
              </g>
            )}

            {isLocked && node.type !== "brain" && (
              <g transform={`translate(${r * 0.55}, ${-r * 0.55}) scale(0.55)`} className="pointer-events-none">
                <rect x="-6" y="-2" width="12" height="10" rx="1.5" fill="#0f172a" stroke={color.stroke} strokeWidth="1.5" opacity={0.8} />
                <path d="M-3-2V-5a3 3 0 016 0v3" fill="none" stroke={color.stroke} strokeWidth="1.5" strokeLinecap="round" opacity={0.8} />
              </g>
            )}
          </>
        )}
        </g>
      </g>
    </g>
  );
});
