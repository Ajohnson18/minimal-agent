import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getConnections, BRANCH_COLORS, type SkillNode } from "../../lib/skill-tree-data";
import { BRANCH_ANGLES } from "../../utils/layout";
import { apiPatch } from "../../api/client";
import { getNodeColor } from "../../utils/node-colors";
import { useToast } from "../../hooks/useToast";
import { SkillTreeNode } from "./SkillTreeNode";
import CommandInput from "./CommandInput";
import DetailPanel from "./DetailPanel";
import SetupPanel from "./SetupPanel";
import KeyboardHints from "./KeyboardHints";
import ZoomControls from "./ZoomControls";
import AgentConsole from "../agent/AgentConsole";
import Toast from "../ui/Toast";
import WelcomeGuide from "./WelcomeGuide";
import MemoriesPanel from "./MemoriesPanel";

export type OnboardPhase = "brain" | "branches" | "complete";

const NAV_MAP: Record<string, Record<string, string>> = {
  brain:       { ArrowLeft: "engineering", ArrowRight: "design", ArrowDown: "product", ArrowUp: "general" },
  engineering: { ArrowRight: "brain", ArrowDown: "product", ArrowUp: "general" },
  design:      { ArrowLeft: "brain", ArrowDown: "product", ArrowUp: "general" },
  product:     { ArrowUp: "brain", ArrowLeft: "engineering", ArrowRight: "design" },
  general:     { ArrowDown: "brain", ArrowLeft: "engineering", ArrowRight: "design" },
};
const MAIN_NODES = new Set(["brain", "engineering", "design", "product", "general"]);
const BRANCH_DRILL_KEY: Record<string, string> = {
  engineering: "ArrowLeft",
  design: "ArrowRight",
  product: "ArrowDown",
  general: "ArrowUp",
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  available: { label: "Available", cls: "bg-sky-500/20 text-sky-400 border-sky-500/30" },
  locked: { label: "Locked", cls: "bg-slate-500/20 text-slate-500 border-slate-600/30" },
};

function SkillListView({ nodes, selectedId, onNodeClick }: { nodes: SkillNode[]; selectedId: string | null; onNodeClick: (n: SkillNode) => void }) {
  const { brain, branches, grouped, intgChildrenMap } = useMemo(() => {
    let brain: SkillNode | undefined;
    const branches: SkillNode[] = [];
    const grouped = new Map<string, SkillNode[]>();
    const intgChildrenMap = new Map<string, SkillNode[]>();
    for (const n of nodes) {
      if (n.type === "brain") { brain = n; continue; }
      if (n.type === "branch") { branches.push(n); grouped.set(n.id, []); continue; }
      const key = n.branch || n.parentId || "other";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(n);
      if (n.requiresIntegration) {
        if (!intgChildrenMap.has(n.requiresIntegration)) intgChildrenMap.set(n.requiresIntegration, []);
        intgChildrenMap.get(n.requiresIntegration)!.push(n);
      }
    }
    return { brain, branches, grouped, intgChildrenMap };
  }, [nodes]);

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto pt-14 pb-8 px-6 scrollbar-thin scrollbar-thumb-slate-700">
      <div className="max-w-2xl mx-auto space-y-6">
        {brain && (
          <button onClick={() => onNodeClick(brain)}
            className={`w-full text-left p-4 rounded-xl border transition-[border-color,background-color] ${selectedId === brain.id ? "bg-slate-800/80 border-slate-500" : "bg-slate-900/60 border-slate-700/40 hover:border-slate-600"}`}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-500 flex items-center justify-center text-[10px] font-bold text-slate-300">KAI</div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-white">{brain.label}</span>
                <p className="text-xs text-slate-400 truncate">{brain.description}</p>
              </div>
              <StatusBadge status={brain.status} />
            </div>
          </button>
        )}
        {branches.map((branch) => {
          const bc = BRANCH_COLORS[branch.id];
          const children = grouped.get(branch.id) || [];
          const integrations = children.filter((n) => n.type === "integration");
          const leafNodes = children.filter((n) => n.type !== "integration");
          return (
            <div key={branch.id} className="space-y-2">
              <button onClick={() => onNodeClick(branch)}
                className={`w-full text-left p-3 rounded-xl border transition-[border-color,background-color] ${selectedId === branch.id ? "bg-slate-800/80 border-slate-500" : "bg-slate-900/60 border-slate-700/40 hover:border-slate-600"}`}>
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                    style={{ background: bc?.primary + "20", color: bc?.primary, border: `1px solid ${bc?.primary}40` }}>
                    {branch.label[0]}
                  </div>
                  <span className="text-sm font-semibold text-white flex-1">{branch.label}</span>
                  <StatusBadge status={branch.status} />
                </div>
              </button>
              {integrations.length > 0 && (
                <div className="ml-5 border-l border-slate-700/40 pl-4 space-y-1.5">
                  {integrations.map((intg) => {
                    const intgChildren = intgChildrenMap.get(intg.id) ?? [];
                    return (
                      <div key={intg.id}>
                        <ListRow node={intg} selected={selectedId === intg.id} bc={bc} onClick={() => onNodeClick(intg)} />
                        {intgChildren.length > 0 && (
                          <div className="ml-5 border-l border-slate-700/30 pl-3 mt-1 space-y-1">
                            {intgChildren.map((child) => (
                              <ListRow key={child.id} node={child} selected={selectedId === child.id} bc={bc} onClick={() => onNodeClick(child)} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {leafNodes.length > 0 && (
                <div className="ml-5 border-l border-slate-700/40 pl-4 space-y-1">
                  {leafNodes.map((n) => (
                    <ListRow key={n.id} node={n} selected={selectedId === n.id} bc={bc} onClick={() => onNodeClick(n)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListRow({ node, selected, bc, onClick }: { node: SkillNode; selected: boolean; bc?: { primary: string; glow: string; stroke: string }; onClick: () => void }) {
  const typeIcon = node.type === "integration" ? "+" : node.type === "tool" ? "#" : node.type === "skill" ? "*" : "-";
  return (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-[border-color,background-color] text-xs ${selected ? "bg-slate-800/80 border-slate-500" : "bg-slate-900/40 border-transparent hover:bg-slate-800/40 hover:border-slate-700/40"}`}>
      <div className="flex items-center gap-2">
        <span className="w-4 text-center opacity-60" style={{ color: bc?.primary }}>{typeIcon}</span>
        <span className="text-slate-200 flex-1 truncate">{node.label}</span>
        {node.logoChar && <span className="text-[10px] opacity-50">{node.logoChar}</span>}
        <StatusBadge status={node.status} />
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] || STATUS_BADGE.locked;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.label}</span>;
}

const NODE_OFFSETS_KEY = "kai:node-offsets";

function loadNodeOffsets(): Record<string, { dx: number; dy: number }> {
  try { return JSON.parse(localStorage.getItem(NODE_OFFSETS_KEY) || "{}"); } catch { return {}; }
}

function getDescendantIds(startId: string, allNodes: SkillNode[]): string[] {
  const ids: string[] = [];
  const frontier = new Set([startId]);
  const visited = new Set([startId]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const n of allNodes) {
      if (visited.has(n.id)) continue;
      if ((n.parentId && frontier.has(n.parentId)) || (n.branch && frontier.has(n.branch)) || (n.requiresIntegration && frontier.has(n.requiresIntegration))) {
        ids.push(n.id);
        visited.add(n.id);
        next.add(n.id);
      }
    }
    frontier.clear();
    for (const id of next) frontier.add(id);
  }
  return ids;
}

interface Props {
  nodes: SkillNode[];
  phase: OnboardPhase;
  newNodeIds: Set<string>;
  onNodesChange: React.Dispatch<React.SetStateAction<SkillNode[]>>;
  onPhaseChange: React.Dispatch<React.SetStateAction<OnboardPhase>>;
  onReload: () => void | Promise<void>;
  isModal?: boolean;
  modalExpanded?: boolean;
  onToggleModalExpand?: () => void;
  activeToolIds?: Set<string>;
  onCommandSubmit?: (text: string) => void;
}

export default function SkillTree({
  nodes, phase, newNodeIds,
  onNodesChange, onPhaseChange, onReload,
  isModal, modalExpanded, onToggleModalExpand, activeToolIds, onCommandSubmit,
}: Props) {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [setupNodeId, setSetupNodeId] = useState<string | null>(null);
  const [completedTasks, setCompletedTasks] = useState<Set<string>>(new Set());
  const [setupSessionKey, setSetupSessionKey] = useState<string | null>(null);
  const [commandText, setCommandText] = useState("");
  const [commandFocused, setCommandFocused] = useState(false);
  const chatOpen = !!isModal;
  const [viewMode, setViewMode] = useState<"map" | "list">("map");
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });
  const [guideAutoOpen, setGuideAutoOpen] = useState(false);

  const prevPhaseRef = useRef(phase);
  const toast = useToast();

  const containerRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const svgGroupRef = useRef<SVGGElement>(null);
  const bgStarsRef = useRef<HTMLDivElement>(null);
  const bgGridRef = useRef<HTMLDivElement>(null);
  const cam = useRef({ zoom: 1, ox: 0, oy: 0 });
  const dragState = useRef({ active: false, sx: 0, sy: 0 });
  const rafId = useRef(0);
  const [, forceRender] = useState(0);

  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>(loadNodeOffsets);
  const nodeOffsetsRef = useRef(nodeOffsets);
  nodeOffsetsRef.current = nodeOffsets;
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const nodeDrag = useRef<{
    nodeId: string; descendants: string[];
    startX: number; startY: number; moved: boolean;
    origOffsets: Record<string, { dx: number; dy: number }>;
    curDx: number; curDy: number;
  } | null>(null);
  const skipClickRef = useRef(false);
  const nodeMapRef = useRef<Map<string, SkillNode>>(new Map());

  const activeTools = activeToolIds ?? new Set<string>();
  const prevActiveToolsRef = useRef<Set<string>>(new Set());
  const panToToolRef = useRef<(toolId: string) => void>(() => {});
  const panHomeChatRef = useRef(() => {});

  // ── Pan to tool nodes when activeToolIds changes (modal mode) ──
  useEffect(() => {
    if (!isModal || !activeToolIds || activeToolIds.size === 0) {
      if (isModal && activeToolIds && activeToolIds.size === 0 && prevActiveToolsRef.current.size > 0) {
        prevActiveToolsRef.current = new Set();
        panHomeChatRef.current();
      }
      return;
    }
    const newIds = [...activeToolIds].filter((id) => !prevActiveToolsRef.current.has(id));
    prevActiveToolsRef.current = new Set(activeToolIds);
    if (newIds.length > 0) {
      panToToolRef.current(newIds[0]);
    }
  }, [activeToolIds, isModal]);

  // ── Welcome guide after initial setup ────────────────────
  useEffect(() => {
    if (prevPhaseRef.current === "brain" && phase === "branches") setGuideAutoOpen(true);
    prevPhaseRef.current = phase;
  }, [phase]);

  // ── Auto-pan to newly registered nodes ─────────────────
  useEffect(() => {
    if (newNodeIds.size === 0) return;
    const firstNewId = [...newNodeIds][0];
    const node = nodeMap.get(firstNewId);
    if (!node) return;
    setSelectedId(node.id);
    const z = scaled(4.5);
    cam.current = { zoom: z, ox: -node.x, oy: -(containerSize.h * 0.18) / z - node.y };
    const g = svgGroupRef.current;
    if (g) {
      g.style.transition = "transform 1.2s cubic-bezier(0.22, 1, 0.36, 1)";
      g.setAttribute("transform", `translate(${containerSize.w / 2 + cam.current.ox * z},${containerSize.h / 2 + cam.current.oy * z}) scale(${z})`);
    }
    forceRender((n) => n + 1);
  }, [newNodeIds]);

  // ── Responsive scaling ────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let resizeRaf = 0;
    const ro = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      });
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(resizeRaf); ro.disconnect(); };
  }, []);

  const baseScale = Math.min(1, Math.min(containerSize.w, containerSize.h) / 1700);
  const scaled = useCallback((z: number) => z * baseScale, [baseScale]);

  useEffect(() => { applyCam(false); }, [containerSize]);

  // ── Memoized data ─────────────────────────────────────────
  const adjustedNodes = useMemo(() => {
    const keys = Object.keys(nodeOffsets);
    if (keys.length === 0) return nodes;
    return nodes.map((n) => { const o = nodeOffsets[n.id]; return o ? { ...n, x: n.x + o.dx, y: n.y + o.dy } : n; });
  }, [nodes, nodeOffsets]);

  const nodeMap = useMemo(() => new Map(adjustedNodes.map((n) => [n.id, n])), [adjustedNodes]);
  nodeMapRef.current = nodeMap;
  const filteredConnections = useMemo(() => getConnections(adjustedNodes), [adjustedNodes]);

  const EXPAND_BRANCHES = new Set(["engineering", "design", "product", "general"]);
  const BRANCH_SPREAD = 1.8;
  const INTEGRATION_SPREAD = 2.0;

  const displayNodes = useMemo(() => {
    const sel = selectedId ? nodeMap.get(selectedId) : null;
    if (!sel) return adjustedNodes;

    const branchId = EXPAND_BRANCHES.has(sel.id) ? sel.id
      : chatOpen && sel.branch && EXPAND_BRANCHES.has(sel.branch) ? sel.branch
      : chatOpen && sel.parentId && EXPAND_BRANCHES.has(sel.parentId) ? sel.parentId
      : null;

    if (branchId) {
      const branch = nodeMap.get(branchId)!;
      const bx = branch.x, by = branch.y;
      const branchIntegrations = new Set(
        adjustedNodes.filter((n) => n.type === "integration" && n.parentId === branchId).map((n) => n.id),
      );
      return adjustedNodes.map((n) => {
        if (n.type === "brain" || n.type === "branch") return n;
        const isDirect = n.branch === branchId || n.parentId === branchId;
        const isDescendant = n.requiresIntegration && branchIntegrations.has(n.requiresIntegration);
        if (!isDirect && !isDescendant) return n;
        const dx = n.x - bx, dy = n.y - by;
        return { ...n, x: Math.round(bx + dx * BRANCH_SPREAD), y: Math.round(by + dy * BRANCH_SPREAD) };
      });
    }

    if (sel.type === "integration") {
      const ix = sel.x, iy = sel.y;
      return adjustedNodes.map((n) => {
        if (n.requiresIntegration !== selectedId) return n;
        const dx = n.x - ix, dy = n.y - iy;
        return { ...n, x: Math.round(ix + dx * INTEGRATION_SPREAD), y: Math.round(iy + dy * INTEGRATION_SPREAD) };
      });
    }

    return adjustedNodes;
  }, [adjustedNodes, selectedId, nodeMap, chatOpen]);

  const displayNodeMap = useMemo(() => new Map(displayNodes.map((n) => [n.id, n])), [displayNodes]);

  const visibleNodes = useMemo(() =>
    phase === "brain" ? displayNodes.filter((n) => n.type === "brain" || n.type === "branch") : displayNodes,
  [displayNodes, phase]);
  const visibleConnections = useMemo(() =>
    phase === "brain" ? filteredConnections.filter((c) => c.from === "brain") : filteredConnections,
  [filteredConnections, phase]);
  const selected = selectedId ? nodeMap.get(selectedId) ?? null : null;

  const expandedIds = useMemo(() => {
    const sel = selectedId ? nodeMap.get(selectedId) : null;
    if (!sel) return new Set<string>();
    const ids = new Set<string>();
    if (EXPAND_BRANCHES.has(sel.id)) {
      const branchInts = new Set<string>();
      adjustedNodes.forEach((n) => {
        if (n.branch === sel.id || n.parentId === sel.id) { ids.add(n.id); if (n.type === "integration") branchInts.add(n.id); }
      });
      adjustedNodes.forEach((n) => { if (n.requiresIntegration && branchInts.has(n.requiresIntegration)) ids.add(n.id); });
    } else if (sel.type === "integration") {
      adjustedNodes.forEach((n) => { if (n.requiresIntegration === selectedId) ids.add(n.id); });
    }
    return ids;
  }, [adjustedNodes, selectedId, nodeMap]);

  // ── Camera (ref-based for perf) ───────────────────────────
  function applyCam(animate = false) {
    const g = svgGroupRef.current;
    if (!g) return;
    const { zoom, ox, oy } = cam.current;
    g.style.transition = animate ? "transform 0.6s cubic-bezier(0.4,0,0.2,1)" : "none";
    g.setAttribute("transform", `translate(${containerSize.w / 2 + ox * zoom},${containerSize.h / 2 + oy * zoom}) scale(${zoom})`);
    if (bgStarsRef.current) {
      bgStarsRef.current.style.backgroundPosition = `${ox * 0.3}px ${oy * 0.3}px, ${13 + ox * 0.15}px ${17 + oy * 0.15}px`;
      bgStarsRef.current.style.transition = animate ? "background-position 0.6s cubic-bezier(0.4,0,0.2,1)" : "none";
    }
    if (bgGridRef.current) {
      bgGridRef.current.style.backgroundPosition = `${ox * 0.5}px ${oy * 0.5}px`;
      bgGridRef.current.style.transition = animate ? "background-position 0.6s cubic-bezier(0.4,0,0.2,1)" : "none";
    }
  }

  function animateTo(targetZoom: number, offset: { x: number; y: number }) {
    cam.current = { zoom: targetZoom, ox: offset.x, oy: offset.y };
    applyCam(true);
    forceRender((n) => n + 1);
  }

  // ── Input handlers (rAF-throttled for 60fps) ─────────────
  function handleWheel(e: React.WheelEvent) {
    if (chatOpen) return;
    e.preventDefault();
    cam.current.zoom = Math.max(scaled(0.3), Math.min(scaled(3), cam.current.zoom + (e.deltaY > 0 ? -0.1 : 0.1) * baseScale));
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(() => { rafId.current = 0; applyCam(false); });
    }
  }
  function handleMouseDown(e: React.MouseEvent) {
    if (chatOpen || e.button !== 0) return;
    dragState.current = { active: true, sx: e.clientX - cam.current.ox * cam.current.zoom, sy: e.clientY - cam.current.oy * cam.current.zoom };
  }
  function handleNodeDragStart(nodeId: string, e: React.MouseEvent) {
    if (chatOpen || e.button !== 0) return;
    const descendants = getDescendantIds(nodeId, adjustedNodes);
    const origOffsets: Record<string, { dx: number; dy: number }> = {};
    for (const id of [nodeId, ...descendants]) origOffsets[id] = nodeOffsetsRef.current[id] || { dx: 0, dy: 0 };
    nodeDrag.current = { nodeId, descendants, startX: e.clientX, startY: e.clientY, moved: false, origOffsets, curDx: 0, curDy: 0 };
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (chatOpen) return;
    if (nodeDrag.current) {
      const dx = e.clientX - nodeDrag.current.startX;
      const dy = e.clientY - nodeDrag.current.startY;
      if (!nodeDrag.current.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        nodeDrag.current.moved = true;
        setIsDraggingNode(true);
      }
      nodeDrag.current.curDx = dx / cam.current.zoom;
      nodeDrag.current.curDy = dy / cam.current.zoom;
      if (!rafId.current) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = 0;
          if (!nodeDrag.current) return;
          const { nodeId: nid, descendants: desc, origOffsets, curDx, curDy } = nodeDrag.current;
          setNodeOffsets((prev) => {
            const next = { ...prev };
            for (const id of [nid, ...desc]) {
              const orig = origOffsets[id] || { dx: 0, dy: 0 };
              next[id] = { dx: orig.dx + curDx, dy: orig.dy + curDy };
            }
            return next;
          });
        });
      }
      return;
    }
    if (!dragState.current.active) return;
    cam.current.ox = (e.clientX - dragState.current.sx) / cam.current.zoom;
    cam.current.oy = (e.clientY - dragState.current.sy) / cam.current.zoom;
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(() => { rafId.current = 0; applyCam(false); });
    }
  }
  function handleMouseUp() {
    if (nodeDrag.current) {
      if (nodeDrag.current.moved) {
        skipClickRef.current = true;
        try { localStorage.setItem(NODE_OFFSETS_KEY, JSON.stringify(nodeOffsetsRef.current)); } catch {}
      }
      nodeDrag.current = null;
      setIsDraggingNode(false);
      return;
    }
    dragState.current.active = false;
  }

  // ── Navigation ────────────────────────────────────────────
  function spreadPositionFor(node: SkillNode): { x: number; y: number } {
    const branchId =
      node.branch && EXPAND_BRANCHES.has(node.branch) ? node.branch
      : node.parentId && EXPAND_BRANCHES.has(node.parentId) ? node.parentId
      : null;
    if (branchId) {
      const branch = nodeMap.get(branchId);
      if (branch) return { x: Math.round(branch.x + (node.x - branch.x) * BRANCH_SPREAD), y: Math.round(branch.y + (node.y - branch.y) * BRANCH_SPREAD) };
    }
    if (node.requiresIntegration) {
      const intg = nodeMap.get(node.requiresIntegration);
      const intgBranch = intg?.parentId && EXPAND_BRANCHES.has(intg.parentId) ? nodeMap.get(intg.parentId) : null;
      if (intgBranch) return { x: Math.round(intgBranch.x + (node.x - intgBranch.x) * BRANCH_SPREAD), y: Math.round(intgBranch.y + (node.y - intgBranch.y) * BRANCH_SPREAD) };
    }
    return node;
  }

  function panToNode(node: SkillNode) {
    const isSmall = node.type === "tool" || node.type === "skill" || node.type === "integration";
    const base = isSmall ? 2.8 : 2.5;
    const pos = spreadPositionFor(node);
    const z = chatOpen ? scaled(base * 5) : scaled(base);
    animateTo(z, { x: -pos.x, y: -pos.y });
  }
  function goHome() { setSelectedId("brain"); animateTo(scaled(chatOpen ? 6 : 1.5), { x: 0, y: 0 }); }
  function goHomeTyping() { setSelectedId("brain"); animateTo(scaled(3.0), { x: 0, y: 0 }); }

  panToToolRef.current = (toolId: string) => {
    const node = nodeMap.get(toolId) ?? nodeMap.get(`tool:${toolId}`);
    if (!node) return;
    setSelectedId(node.id);
    const pos = spreadPositionFor(node);
    const z = scaled(18);
    animateTo(z, { x: -pos.x, y: -pos.y });
  };
  panHomeChatRef.current = () => {
    setSelectedId("brain");
    animateTo(scaled(8), { x: 0, y: 0 });
  };
  function handleNodeClick(node: SkillNode) {
    if (skipClickRef.current) { skipClickRef.current = false; return; }
    setMemoriesOpen(false);
    if (phase === "brain" && node.id === "brain") {
      if (node.setupTasks && node.setupTasks.length > 0) {
        setSetupNodeId("brain");
      } else {
        handleBrainActivate();
      }
      return;
    }
    if (node.id === "brain" && phase !== "brain") {
      goHomeTyping(); setCommandFocused(true);
      setTimeout(() => commandRef.current?.focus(), 0);
      return;
    }
    if (phase === "branches" && node.type === "branch" && node.status === "available" && node.setupTasks && node.setupTasks.length > 0) {
      setSelectedId(node.id);
      panToNode(node);
      setSetupNodeId(node.id);
      return;
    }
    if (node.id === selectedId) { setSelectedId(null); animateTo(scaled(1.5), { x: 0, y: 0 }); } else { setSelectedId(node.id); panToNode(node); }
  }
  const handleNodeClickRef = useRef(handleNodeClick);
  handleNodeClickRef.current = handleNodeClick;
  const handleNodeClickById = useCallback((id: string) => {
    const node = nodeMapRef.current.get(id);
    if (node) handleNodeClickRef.current(node);
  }, []);

  // ── Brain activation ──────────────────────────────────────
  async function saveNodeState(id: string, updates: Record<string, unknown>) {
    try { return await apiPatch<Record<string, unknown>>(`/setup/skill-tree/${id}`, updates); } catch { return {}; }
  }
  async function handleBrainActivate() {
    try {
      const result = await saveNodeState("brain", { status: "active" });
      if (result.sessionKey) setSetupSessionKey(result.sessionKey as string);
      for (const b of ["engineering", "design", "product", "general"]) await saveNodeState(b, { status: "available" });
      await onReload();
      toast.show("KAI is initializing in the background.");
      setSelectedId(null);
      setTimeout(() => { onPhaseChange("branches"); animateTo(scaled(1.6), { x: 0, y: 0 }); }, 500);
    } catch (err) { console.error(err); }
  }

  async function handleBranchActivate(branchId: string) {
    try {
      await saveNodeState(branchId, { status: "active" });
      onNodesChange((prev) => prev.map((n) => n.id === branchId ? { ...n, status: "active" as const } : n));
      await onReload();
      const allActive = nodes.filter((n) => n.type === "branch").every((b) => b.id === branchId || b.status === "active");
      if (allActive) onPhaseChange("complete");
      setSelectedId(null);
      animateTo(scaled(1.5), { x: 0, y: 0 });
    } catch (err) { console.error(err); }
  }

  function handleSetupComplete() {
    const id = setupNodeId;
    setSetupNodeId(null);
    if (!id) return;
    if (id === "brain") handleBrainActivate();
    else handleBranchActivate(id);
  }

  function handleSetupTaskComplete(taskId: string) {
    setCompletedTasks((prev) => new Set([...prev, taskId]));
  }

  // ── Keyboard ──────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (commandFocused && e.key !== "Escape") return;

    const sel = selectedId ? nodeMap.get(selectedId) : null;
    const isArrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);

    // Integration selected: arrows cycle siblings, Escape goes to parent branch
    if (sel?.type === "integration") {
      if (isArrow) {
        e.preventDefault();
        const siblings = nodes.filter((n) => n.type === "integration" && n.parentId === sel.parentId);
        const idx = siblings.findIndex((n) => n.id === sel.id);
        const dir = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
        const next = siblings[(idx + dir + siblings.length) % siblings.length];
        if (next) { setSelectedId(next.id); panToNode(next); }
        requestAnimationFrame(() => containerRef.current?.focus());
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const parent = sel.parentId ? nodeMap.get(sel.parentId) : null;
        if (parent) { setSelectedId(parent.id); panToNode(parent); } else { setSelectedId(null); animateTo(scaled(1.5), { x: 0, y: 0 }); }
        requestAnimationFrame(() => containerRef.current?.focus());
        return;
      }
    }

    // Branch selected: Enter or outward arrow drills into integrations
    if (sel?.type === "branch" && (e.key === "Enter" || e.key === BRANCH_DRILL_KEY[sel.id])) {
      const integrations = nodes.filter((n) => n.type === "integration" && n.parentId === sel.id);
      if (integrations.length > 0) {
        e.preventDefault();
        setSelectedId(integrations[0].id);
        panToNode(integrations[0]);
        return;
      }
    }

    // Main node arrow navigation
    let nextId: string | null = null;
    if (!selectedId || !MAIN_NODES.has(selectedId)) {
      if (isArrow) nextId = "brain";
    } else { nextId = NAV_MAP[selectedId]?.[e.key] ?? null; }

    if (nextId) {
      e.preventDefault();
      if (nextId === "brain" && phase !== "brain") goHome();
      else { const n = nodeMap.get(nextId); if (n) { setSelectedId(nextId); panToNode(n); } }
    }
    if (e.key === "Enter" && selectedId && sel?.type !== "branch" && !commandFocused) { e.preventDefault(); const n = nodeMap.get(selectedId); if (n) handleNodeClick(n); }
    if (e.key === "Escape") {
      if (commandFocused) { commandRef.current?.blur(); setCommandFocused(false); setCommandText(""); goHome(); return; }
      setSelectedId(null); animateTo(scaled(1.5), { x: 0, y: 0 }); return;
    }
    if (!commandFocused && phase !== "brain" && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      goHomeTyping(); setCommandFocused(true); setCommandText(e.key);
      setTimeout(() => commandRef.current?.focus(), 0); e.preventDefault();
    }
  }, [selectedId, nodeMap, nodes, commandFocused, baseScale, phase]);

  function handleCommandSubmit(text: string) {
    setCommandText("");
    setCommandFocused(false);
    if (onCommandSubmit) {
      onCommandSubmit(text);
    } else {
      navigate({ to: "/", search: { msg: text } });
    }
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="relative h-full w-full">
      {/* Graph container — full screen or mini modal */}
      <div className={isModal
          ? `relative w-full h-full rounded-2xl overflow-hidden`
          : "relative h-full w-full overflow-hidden"
        }
        ref={containerRef}
        style={{ background: "linear-gradient(145deg, #020617 0%, #0a0f1e 35%, #06081a 65%, #020617 100%)" }}
        tabIndex={chatOpen ? -1 : 0} onKeyDown={chatOpen ? undefined : handleKeyDown}>

      {/* Mini modal header */}
      {isModal && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-2 bg-gradient-to-b from-gray-900/95 via-gray-900/60 to-transparent">
          <span className="text-[10px] font-medium text-gray-400 tracking-wide uppercase">Skill Map</span>
          <button onClick={onToggleModalExpand}
            className="text-gray-500 hover:text-white transition-colors p-0.5 rounded">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {modalExpanded ? (
                <><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></>
              ) : (
                <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>
              )}
            </svg>
          </button>
        </div>
      )}

      {/* Map / List toggle */}
      {!chatOpen && phase !== "brain" && !setupNodeId && (
        <div className="absolute bottom-5 right-5 z-20 flex items-center bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-lg p-0.5 gap-0.5">
          {(["map", "list"] as const).map((mode) => (
            <button key={mode} onClick={() => setViewMode(mode)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${viewMode === mode ? "bg-slate-700 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}>
              {mode === "map" ? "Map" : "List"}
            </button>
          ))}
        </div>
      )}

      {/* List view */}
      {!chatOpen && viewMode === "list" && phase !== "brain" ? (
        <SkillListView nodes={nodes} selectedId={selectedId} onNodeClick={handleNodeClick} />
      ) : (
      <>
      {/* Parallax background */}
      <div className="absolute inset-0 overflow-hidden">
        <div ref={bgStarsRef} className="absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage: "radial-gradient(circle, #cbd5e1 1px, transparent 1px), radial-gradient(circle, #94a3b8 0.5px, transparent 0.5px)",
            backgroundSize: "53px 53px, 31px 31px" }} />
        <div ref={bgGridRef} className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: "linear-gradient(rgba(148,163,184,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.4) 1px, transparent 1px)",
            backgroundSize: "80px 80px" }} />
        <div className="absolute inset-0"
          style={{ background: "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 0%, rgba(2,6,23,0.4) 60%, rgba(2,6,23,0.85) 100%)" }} />
      </div>

      {/* SVG canvas */}
      <svg className={`absolute inset-0 w-full h-full ${chatOpen ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
        onWheel={chatOpen ? undefined : handleWheel} onMouseDown={chatOpen ? undefined : handleMouseDown} onMouseMove={chatOpen ? undefined : handleMouseMove}
        onMouseUp={chatOpen ? undefined : handleMouseUp} onMouseLeave={chatOpen ? undefined : handleMouseUp}>
        <defs>
          <radialGradient id="brain-gradient" cx="0" cy="0" r="280" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#cbd5e1" stopOpacity="0.1" /><stop offset="50%" stopColor="#64748b" stopOpacity="0.04" /><stop offset="100%" stopColor="#64748b" stopOpacity="0" />
          </radialGradient>
          {Object.entries(BRANCH_ANGLES).map(([id]) => {
            const bc = BRANCH_COLORS[id];
            if (!bc) return null;
            return (
              <radialGradient key={id} id={`cone-grad-${id}`} cx="0" cy="0" r="550" gradientUnits="userSpaceOnUse">
                <stop offset="15%" stopColor={bc.primary} stopOpacity="0.12" />
                <stop offset="55%" stopColor={bc.primary} stopOpacity="0.06" />
                <stop offset="90%" stopColor={bc.primary} stopOpacity="0" />
              </radialGradient>
            );
          })}
        </defs>
        <g ref={svgGroupRef} transform={`translate(${containerSize.w / 2},${containerSize.h / 2}) scale(1)`}>
          <circle cx={0} cy={0} r={280} fill="url(#brain-gradient)" opacity={0.6} />

          {/* Background sector cones */}
          {phase !== "brain" && (
            <g style={{ filter: "blur(8px)" }}>
              {Object.entries(BRANCH_ANGLES).map(([branchId, angle]) => {
                const bc = BRANCH_COLORS[branchId];
                if (!bc) return null;
                const ha = 0.73;
                const innerR = 135;
                const outerR = 550;
                const x1i = Math.cos(angle - ha) * innerR;
                const y1i = Math.sin(angle - ha) * innerR;
                const x1o = Math.cos(angle - ha) * outerR;
                const y1o = Math.sin(angle - ha) * outerR;
                const x2o = Math.cos(angle + ha) * outerR;
                const y2o = Math.sin(angle + ha) * outerR;
                const x2i = Math.cos(angle + ha) * innerR;
                const y2i = Math.sin(angle + ha) * innerR;
                return (
                  <path key={branchId}
                    d={`M ${x1i} ${y1i} L ${x1o} ${y1o} A ${outerR} ${outerR} 0 0 1 ${x2o} ${y2o} L ${x2i} ${y2i} A ${innerR} ${innerR} 0 0 0 ${x1i} ${y1i} Z`}
                    fill={`url(#cone-grad-${branchId})`} />
                );
              })}
            </g>
          )}

          {/* Level rings */}
          {phase !== "brain" && (
            <g>
              <circle cx={0} cy={0} r={220} fill="none" stroke="#94a3b8" strokeWidth={1} opacity={0.22} strokeDasharray="6 8" />
              <circle cx={0} cy={0} r={340} fill="none" stroke="#94a3b8" strokeWidth={0.8} opacity={0.16} strokeDasharray="5 10" />
              <circle cx={0} cy={0} r={430} fill="none" stroke="#94a3b8" strokeWidth={0.6} opacity={0.11} strokeDasharray="4 12" />
            </g>
          )}

          {visibleConnections.map((conn) => {
            const from = displayNodeMap.get(conn.from), to = displayNodeMap.get(conn.to);
            if (!from || !to) return null;
            const c = getNodeColor(to);
            const locked = to.status === "locked";
            const isBranch = to.type === "branch";
            const isIntegrationEdge = from.type === "integration";
            const d = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
            return (
              <g key={`${conn.from}-${conn.to}`}>
                {!locked && <path d={d} fill="none" stroke={c.stroke} strokeWidth={isBranch ? 4 : 3} opacity={0.06} className="transition-[d] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]" />}
                <path d={d} fill="none"
                  stroke={c.stroke}
                  strokeWidth={isBranch ? 1 : isIntegrationEdge ? 0.3 : 0.7}
                  strokeDasharray={locked ? "3 4" : "none"}
                  opacity={locked ? 0.1 : isIntegrationEdge ? 0.08 : 0.2}
                  className="transition-[d] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]" />
              </g>
            );
          })}

          {visibleNodes.map((node) => {
            const isInChain = node.id === selectedId || (selected !== null && (node.id === selected.parentId || node.id === selected.branch || node.id === selected.requiresIntegration));
            const isLeaf = node.type !== "brain" && node.type !== "branch";
            return (
              <SkillTreeNode key={node.id} node={node}
                isSelected={node.id === selectedId} isInChain={isInChain}
                isClickable={node.id === "brain" || node.type === "integration" || node.status !== "locked" || phase === "complete"}
                isExpanded={isLeaf ? expandedIds.has(node.id) : undefined}
                isActiveTool={activeTools.has(node.id)}
                isNew={newNodeIds.has(node.id)}
                isCommandActive={node.id === "brain" ? (!chatOpen && (commandFocused || commandText.length > 0)) : undefined}
                isDragging={isDraggingNode}
                phase={phase} onNodeClick={handleNodeClickById}
                onDragStart={handleNodeDragStart} />
            );
          })}

          {/* Floating memories node */}
          {phase !== "brain" && (() => {
            const brainActive = !chatOpen && (commandFocused || commandText.length > 0);
            const scale = brainActive ? 1 : 0.6;
            const angle = (-3 * Math.PI) / 4;
            const dist = 185 * scale;
            const mx = Math.cos(angle) * dist;
            const my = Math.sin(angle) * dist;
            const r = 16;
            return (
              <g style={{
                transform: `translate(${mx}px, ${my}px)`,
                transition: "transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
              }}
                className="cursor-pointer" onClick={(e) => { e.stopPropagation(); setMemoriesOpen((o) => !o); }}>
                <circle r={r + 6} fill="transparent" stroke="#a78bfa" strokeWidth={0.5} opacity={0.2}>
                  <animate attributeName="r" values={`${r + 4};${r + 10};${r + 4}`} dur="3s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.2;0.08;0.2" dur="3s" repeatCount="indefinite" />
                </circle>
                <circle r={r} fill="#0f172a" stroke="#a78bfa" strokeWidth={1.5} />
                <g transform="scale(0.52)" className="pointer-events-none">
                  <path d="M-6 -8 H2 L6 -4 V8 H-6 Z" fill="none" stroke="#c4b5fd" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="M2 -8 V-4 H6" fill="none" stroke="#c4b5fd" strokeWidth="1.4" strokeLinejoin="round" />
                  <line x1="-3" y1="-1" x2="3" y2="-1" stroke="#c4b5fd" strokeWidth="1" opacity="0.5" />
                  <line x1="-3" y1="2" x2="3" y2="2" stroke="#c4b5fd" strokeWidth="1" opacity="0.5" />
                  <line x1="-3" y1="5" x2="1" y2="5" stroke="#c4b5fd" strokeWidth="1" opacity="0.5" />
                </g>
              </g>
            );
          })()}

          {/* CommandInput inside brain circle — only when actively typing */}
          {phase !== "brain" && !chatOpen && (commandFocused || commandText.length > 0) && (
            <CommandInput ref={commandRef} text={commandText} focused={commandFocused}
              onTextChange={setCommandText} onFocus={() => setCommandFocused(true)}
              onBlur={() => { if (!commandText) { setCommandFocused(false); goHome(); } }}
              onEscape={() => { commandRef.current?.blur(); setCommandFocused(false); setCommandText(""); goHome(); containerRef.current?.focus(); }}
              onSubmit={handleCommandSubmit} />
          )}
        </g>
      </svg>

      </>
      )}

      {!chatOpen && (<>
      {setupNodeId && (() => {
        const setupNode = nodeMap.get(setupNodeId);
        if (!setupNode?.setupTasks?.length) return null;
        return (
          <div className="absolute inset-0 z-30 bg-gray-950/95 backdrop-blur-sm">
            <SetupPanel
              nodeId={setupNode.id}
              nodeLabel={setupNode.label}
              nodeBranch={setupNode.branch}
              tasks={setupNode.setupTasks.map((t) => ({ ...t, completed: completedTasks.has(t.id) }))}
              onTaskComplete={handleSetupTaskComplete}
              onAllComplete={handleSetupComplete}
            />
          </div>
        );
      })()}

      {setupSessionKey && <AgentConsole sessionKey={setupSessionKey} title="Writing workspace files..." onComplete={() => setSetupSessionKey(null)} />}
      <Toast message={toast.message} onDismiss={toast.dismiss} />

      {memoriesOpen && !setupNodeId && (
        <MemoriesPanel onClose={() => setMemoriesOpen(false)} />
      )}

      {selected && !memoriesOpen && !setupNodeId && !(phase === "brain" && selected.id !== "brain") && (
        <DetailPanel node={selected} nodes={nodes} nodeMap={nodeMap}
          onClose={() => setSelectedId(null)} onSelectNode={setSelectedId} onReload={onReload} />
      )}

      {phase !== "brain" && (
        <WelcomeGuide
          autoOpen={guideAutoOpen}
          onNavigate={(id) => {
            const n = nodeMap.get(id);
            if (n) { setSelectedId(id); panToNode(n); }
          }}
        />
      )}
      {viewMode === "map" && <KeyboardHints />}
      {viewMode === "map" && <ZoomControls
        onZoomIn={() => { cam.current.zoom = Math.min(scaled(3), cam.current.zoom + scaled(0.2)); applyCam(true); }}
        onZoomOut={() => { cam.current.zoom = Math.max(scaled(0.3), cam.current.zoom - scaled(0.2)); applyCam(true); }}
        onReset={() => animateTo(scaled(1.5), { x: 0, y: 0 })} />}
      </>)}

    </div>
    </div>
  );
}
