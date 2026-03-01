import { useState, useEffect, useRef, useCallback } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { useChat } from "../hooks/useChat";
import { usePowers, type PowerInfo } from "../hooks/usePowers";
import { usePowerRuns, type PowerRun } from "../hooks/usePowerRuns";
import { useSkillTree } from "../hooks/useSkillTree";
import { rpc, subscribe, type GatewayEvent } from "../lib/gateway";
import PowerLibrary from "../components/powers/PowerLibrary";
import QuickActions, { usePinnedPowers } from "../components/powers/QuickActions";
import RecentRuns from "../components/powers/RecentRuns";
import ActiveRun from "../components/powers/ActiveRun";
import RunResultModal from "../components/powers/RunResultModal";
import ChatDock from "../components/chat/ChatDock";
import PowerDetailDrawer from "../components/powers/PowerDetailDrawer";
import SkillTree from "../components/skill-tree/SkillTree";
import DashboardMetrics from "../components/powers/DashboardMetrics";
import DraggablePanel from "../components/ui/DraggablePanel";
import { useDashboardMetrics } from "../hooks/useDashboardMetrics";

type SkillMapView = "modal" | "full";
type PanelId = "quick-actions" | "metrics" | "recent-runs" | "active-run" | "library";

const DEFAULT_PANEL_ORDER: PanelId[] = ["quick-actions", "metrics", "recent-runs", "active-run", "library"];

const PANEL_TITLES: Record<PanelId, string> = {
  "quick-actions": "Quick Actions",
  "metrics": "Dashboard Metrics",
  "recent-runs": "Recent Runs",
  "active-run": "Active Run",
  "library": "Power Library",
};

const PANEL_SPANS: Record<PanelId, string> = {
  "quick-actions": "lg:col-span-4",
  "metrics": "lg:col-span-4",
  "recent-runs": "lg:col-span-2",
  "active-run": "lg:col-span-2",
  "library": "lg:col-span-4",
};

const LAYOUT_KEY = "kai:panel-layout";

interface PanelLayout {
  order: PanelId[];
  minimized: PanelId[];
  expanded: PanelId[];
}

function loadPanelLayout(): PanelLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (saved?.order) return saved;
  } catch {}
  return { order: DEFAULT_PANEL_ORDER, minimized: [], expanded: [] };
}

export default function DashboardPage() {
  const chat = useChat();
  const { powers } = usePowers();
  const { pinnedIds, pin, unpin, isPinned } = usePinnedPowers();
  const [selectedPower, setSelectedPower] = useState<PowerInfo | null>(null);
  const [resultRun, setResultRun] = useState<PowerRun | null>(null);
  const [skillView, setSkillView] = useState<SkillMapView>("modal");
  const powerRuns = usePowerRuns();
  const dashboardMetrics = useDashboardMetrics();
  const prevStreamingRef = useRef(false);
  const pollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (chat.isStreaming) {
      prevStreamingRef.current = true;
    } else if (prevStreamingRef.current) {
      prevStreamingRef.current = false;
      pollTimersRef.current.forEach(clearTimeout);
      pollTimersRef.current = [
        setTimeout(() => { powerRuns.refetch(); dashboardMetrics.refetch(); }, 2000),
        setTimeout(() => { powerRuns.refetch(); dashboardMetrics.refetch(); }, 5000),
        setTimeout(() => powerRuns.refetch(), 10000),
      ];
    }
    return () => pollTimersRef.current.forEach(clearTimeout);
  }, [chat.isStreaming]);

  useEffect(() => {
    const unsub = subscribe((evt: GatewayEvent) => {
      if (evt.event === "chat" && (evt.payload.state === "final" || evt.payload.state === "error")) {
        setTimeout(() => { powerRuns.refetch(); dashboardMetrics.refetch(); }, 1500);
        setTimeout(() => { powerRuns.refetch(); dashboardMetrics.refetch(); }, 4000);
      }
    });
    return unsub;
  }, []);

  const [savingPower, setSavingPower] = useState(false);

  const handleSaveAsPower = useCallback(async () => {
    setSavingPower(true);
    try {
      chat.send("Based on our conversation, create a reusable power using the manage_power tool. Analyze what we did and generalize it into a well-structured power with a thorough prompt.");
    } catch (err) {
      console.error("Save as power failed:", err);
    } finally {
      setSavingPower(false);
    }
  }, [chat.activeSession.sessionKey, powerRuns]);

  const [skillModalExpanded, setSkillModalExpanded] = useState(false);
  const [skillMinimized, setSkillMinimized] = useState(false);
  const [activeToolIds, setActiveToolIds] = useState<Set<string>>(new Set());
  const [panelLayout, setPanelLayout] = useState<PanelLayout>(loadPanelLayout);
  const [dragOverPanelId, setDragOverPanelId] = useState<PanelId | null>(null);
  const dragSourcePanelRef = useRef<PanelId | null>(null);
  const [skillModalPos, setSkillModalPos] = useState<{ bottom: number; right: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kai:skill-modal-pos") || "null");
      if (saved && typeof saved.bottom === "number" && typeof saved.right === "number") return saved;
    } catch {}
    return { bottom: 76, right: 20 };
  });
  const skillDrag = useRef<{ startX: number; startY: number; startBottom: number; startRight: number } | null>(null);
  const skillContainerRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const skillTree = useSkillTree();

  function handleSkillDragStart(e: React.MouseEvent) {
    if (isSkillFull) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startBottom = skillModalPos.bottom;
    const startRight = skillModalPos.right;
    let dragging = false;
    let curBottom = startBottom;
    let curRight = startRight;
    let raf = 0;
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 4) return;
      dragging = true;
      curBottom = Math.max(0, startBottom - dy);
      curRight = Math.max(0, startRight - dx);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const el = skillContainerRef.current;
          if (el) { el.style.bottom = `${curBottom}px`; el.style.right = `${curRight}px`; }
        });
      }
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (raf) cancelAnimationFrame(raf);
      if (dragging) {
        const pos = { bottom: curBottom, right: curRight };
        setSkillModalPos(pos);
        localStorage.setItem("kai:skill-modal-pos", JSON.stringify(pos));
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const isSkillFull = skillView === "full";

  useEffect(() => {
    const unsub = subscribe((evt: GatewayEvent) => {
      if (evt.event === "agent" && (evt.payload as { stream?: string }).stream === "tool" && ((evt.payload.data as Record<string, unknown> | undefined)?.phase === "call")) {
        const toolName = ((evt.payload.data as Record<string, unknown>)?.toolName ?? "") as string;
        const ids = [`tool:${toolName}`, toolName];
        setActiveToolIds((prev) => new Set([...prev, ...ids]));
        setTimeout(() => {
          setActiveToolIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.delete(id));
            return next;
          });
        }, 2500);
      }
    });
    return unsub;
  }, []);

  const searchParams = useSearch({ strict: false }) as Record<string, string | undefined>;
  const pendingMsg = searchParams.msg;
  const sentRef = useRef(false);
  const [chatInitialOpen, setChatInitialOpen] = useState(!!pendingMsg);

  useEffect(() => {
    if (pendingMsg && !sentRef.current) {
      sentRef.current = true;
      chat.send(pendingMsg);
      navigate({ to: "/", search: {}, replace: true });
    }
  }, [pendingMsg]);

  const [isPowerRun, setIsPowerRun] = useState(false);

  const handleRunPower = useCallback(async (power: PowerInfo) => {
    setIsPowerRun(true);
    const sid = chat.newSession();
    chat.executePower(power.id, power.name, sid);
  }, [chat.newSession, chat.executePower]);

  const handleSelectPower = useCallback((power: PowerInfo) => {
    setSelectedPower(power);
  }, []);

  const handleEditPower = useCallback((power: PowerInfo, instructions: string) => {
    const sid = chat.newSession();
    chat.send(`Edit the "${power.name}" power (id: ${power.id}): ${instructions}`, sid);
  }, [chat.newSession, chat.send]);

  const handleDeletePower = useCallback(async (power: PowerInfo) => {
    try {
      await rpc("powers.delete", { powerId: power.id });
      setSelectedPower(null);
    } catch {}
  }, []);

  function updatePanelLayout(updater: (prev: PanelLayout) => PanelLayout) {
    setPanelLayout((prev) => {
      const next = updater(prev);
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      return next;
    });
  }

  function togglePanelMinimized(id: PanelId) {
    updatePanelLayout((prev) => ({
      ...prev,
      minimized: prev.minimized.includes(id) ? prev.minimized.filter((x) => x !== id) : [...prev.minimized, id],
    }));
  }

  function togglePanelExpanded(id: PanelId) {
    updatePanelLayout((prev) => ({
      ...prev,
      expanded: prev.expanded.includes(id) ? prev.expanded.filter((x) => x !== id) : [...prev.expanded, id],
    }));
  }

  function handlePanelDragStart(id: PanelId) {
    dragSourcePanelRef.current = id;
  }

  function handlePanelDragEnter(id: PanelId) {
    setDragOverPanelId(id);
  }

  function handlePanelDragEnd() {
    const source = dragSourcePanelRef.current;
    const target = dragOverPanelId;
    if (source && target && source !== target) {
      updatePanelLayout((prev) => {
        const order = [...prev.order];
        const fromIdx = order.indexOf(source);
        const toIdx = order.indexOf(target);
        if (fromIdx !== -1 && toIdx !== -1) {
          order.splice(fromIdx, 1);
          order.splice(toIdx, 0, source);
        }
        return { ...prev, order };
      });
    }
    dragSourcePanelRef.current = null;
    setDragOverPanelId(null);
  }

  function toggleSkillView() {
    setSkillView((v) => (v === "modal" ? "full" : "modal"));
  }

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden" style={{ background: "linear-gradient(145deg, #020617 0%, #0a0f1e 35%, #06081a 65%, #020617 100%)" }}>
      {/* Dotted background (matches skill tree) */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-[0.22]"
          style={{ backgroundImage: "radial-gradient(circle, #cbd5e1 1px, transparent 1px), radial-gradient(circle, #94a3b8 0.5px, transparent 0.5px)", backgroundSize: "53px 53px, 31px 31px" }} />
        <div className="absolute inset-0 opacity-[0.06]"
          style={{ backgroundImage: "linear-gradient(rgba(148,163,184,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.4) 1px, transparent 1px)", backgroundSize: "80px 80px" }} />
        <div className="absolute inset-0"
          style={{ background: "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 0%, rgba(2,6,23,0.4) 60%, rgba(2,6,23,0.85) 100%)" }} />
      </div>

      {/* Floating nav */}
      <div className="absolute inset-x-0 top-4 z-[60] flex justify-center pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-1 px-1.5 py-1 rounded-full bg-gray-900/60 backdrop-blur-xl border border-white/[0.06] shadow-lg shadow-black/20">
          <button
            onClick={() => setSkillView("modal")}
            className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all duration-200 ${
              !isSkillFull ? "text-white bg-white/10 shadow-sm" : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
            }`}
          >
            Command Center
          </button>
          <button
            onClick={() => setSkillView("full")}
            className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all duration-200 ${
              isSkillFull ? "text-white bg-white/10 shadow-sm" : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
            }`}
          >
            Skill Map
          </button>
        </div>
      </div>

      {/* Dashboard content — unmounted when skill map is full */}
      {!isSkillFull && (
      <div className="flex-1 overflow-y-auto pb-24 scrollbar-thin">

        <div className="max-w-6xl mx-auto px-6 pt-16 pb-8">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-white mb-1">Command Center</h1>
            <p className="text-sm text-gray-500">Run powers, monitor executions, and manage your toolkit.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {panelLayout.order
              .filter((id) => id !== "metrics" || dashboardMetrics.metrics.length > 0 || dashboardMetrics.loading)
              .map((id) => {
                const isExpanded = panelLayout.expanded.includes(id);
                const isMinimized = panelLayout.minimized.includes(id);
                const span = isExpanded ? "lg:col-span-4" : PANEL_SPANS[id];
                return (
                  <DraggablePanel
                    key={id}
                    id={id}
                    title={PANEL_TITLES[id]}
                    minimized={isMinimized}
                    expanded={isExpanded}
                    onToggleMinimize={() => togglePanelMinimized(id)}
                    onToggleExpand={() => togglePanelExpanded(id)}
                    onDragStart={() => handlePanelDragStart(id)}
                    onDragEnter={() => handlePanelDragEnter(id)}
                    onDragEnd={handlePanelDragEnd}
                    isDragOver={dragOverPanelId === id}
                    className={`${span} ${id === "library" && !isMinimized ? "min-h-[400px]" : ""}`}
                  >
                    {id === "quick-actions" && (
                      <QuickActions
                        powers={powers}
                        pinnedIds={pinnedIds}
                        onRun={handleRunPower}
                        onPin={pin}
                        onUnpin={unpin}
                        onAddClick={() => navigate({ to: "/powers/new" })}
                      />
                    )}
                    {id === "metrics" && (
                      <DashboardMetrics
                        metrics={dashboardMetrics.metrics}
                        loading={dashboardMetrics.loading}
                        powers={powers}
                        onRefresh={handleRunPower}
                        onDelete={dashboardMetrics.deleteMetric}
                      />
                    )}
                    {id === "recent-runs" && (
                      <RecentRuns runs={powerRuns.runs} loading={powerRuns.loading} onClickRun={setResultRun} />
                    )}
                    {id === "active-run" && (
                      <ActiveRun
                        isStreaming={chat.isStreaming}
                        messages={chat.messages}
                        activeTools={activeToolIds}
                        isPowerRun={isPowerRun}
                        onLingerDone={() => setIsPowerRun(false)}
                      />
                    )}
                    {id === "library" && (
                      <div ref={libraryRef}>
                        <PowerLibrary onRunPower={handleRunPower} onSelectPower={handleSelectPower} />
                      </div>
                    )}
                  </DraggablePanel>
                );
              })}
          </div>
        </div>
      </div>
      )}

      {/* Power Detail Drawer */}
      {selectedPower && !isSkillFull && (
        <PowerDetailDrawer
          power={selectedPower}
          isPinned={isPinned(selectedPower.id)}
          onClose={() => setSelectedPower(null)}
          onRun={handleRunPower}
          onPin={() => pin(selectedPower.id)}
          onUnpin={() => unpin(selectedPower.id)}
          onEdit={handleEditPower}
          onDelete={handleDeletePower}
        />
      )}

      {/* Run Result Modal */}
      {resultRun && (
        <RunResultModal
          run={resultRun}
          onClose={() => setResultRun(null)}
          onViewChat={() => {
            setResultRun(null);
            setChatInitialOpen(true);
          }}
        />
      )}

      {/* Skill Tree — animated between floating modal, full screen, and minimized */}
      {!skillTree.isLoading && !skillTree.isError && (
        skillMinimized && !isSkillFull ? (
          <div
            ref={skillContainerRef}
            className="fixed z-50 cursor-pointer transition-all duration-300 ease-out"
            style={{
              bottom: skillModalPos.bottom,
              right: skillModalPos.right,
              borderRadius: 20,
              boxShadow: "0 8px 24px -4px rgba(0,0,0,0.5)",
              border: "1px solid rgba(71,85,105,0.3)",
              background: "linear-gradient(145deg, #0a0f1e 0%, #06081a 100%)",
            }}
            onClick={() => setSkillMinimized(false)}
          >
            <div className="flex items-center gap-2 px-3 py-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500/60 animate-pulse" />
              <span className="text-[10px] font-medium text-gray-400 whitespace-nowrap">Skill Map</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-600">
                <polyline points="6 15 12 9 18 15" />
              </svg>
            </div>
          </div>
        ) : (
          <div
            ref={skillContainerRef}
            className={`fixed z-50 overflow-hidden ${isSkillFull ? "" : "transition-[width,height,border-radius] duration-300 ease-out"}`}
            style={isSkillFull ? {
              bottom: 0,
              right: 0,
              width: "100vw",
              height: "100vh",
              borderRadius: 0,
              transition: "all 500ms cubic-bezier(0.4,0,0.2,1)",
            } : {
              bottom: skillModalPos.bottom,
              right: skillModalPos.right,
              width: skillModalExpanded ? 578 : 340,
              height: skillModalExpanded ? 374 : 220,
              borderRadius: 16,
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.6)",
              border: "1px solid rgba(71,85,105,0.3)",
            }}
          >
            {/* Drag handle (modal mode only) — leaves right side clear for buttons */}
            {!isSkillFull && (
              <div
                className="absolute left-0 top-0 h-7 z-20 cursor-grab active:cursor-grabbing"
                style={{ right: 64 }}
                onMouseDown={handleSkillDragStart}
              />
            )}
            {/* Minimize button (modal mode only) */}
            {!isSkillFull && (
              <button
                onClick={() => setSkillMinimized(true)}
                className="absolute top-1.5 right-8 z-20 p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                title="Minimize"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
            <SkillTree
              nodes={skillTree.nodes}
              phase={skillTree.phase}
              newNodeIds={skillTree.newNodeIds}
              onNodesChange={skillTree.setNodes}
              onPhaseChange={skillTree.setPhase}
              onReload={skillTree.reload}
              isModal={!isSkillFull}
              modalExpanded={skillModalExpanded}
              onToggleModalExpand={() => setSkillModalExpanded((o) => !o)}
              activeToolIds={activeToolIds}
              onCommandSubmit={(text) => {
                setSkillView("modal");
                chat.send(text);
                setChatInitialOpen(true);
              }}
            />
          </div>
        )
      )}

      {/* Chat Dock — unmounted when skill map is full */}
      {!isSkillFull && (
        <ChatDock
          sessions={chat.sessions}
          activeSessionId={chat.activeSessionId}
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          initialOpen={chatInitialOpen}
          onSend={chat.send}
          onAbort={chat.abort}
          onNewSession={chat.newSession}
          onSwitchSession={chat.switchSession}
          onDeleteSession={chat.deleteSession}
          onSaveAsPower={chat.messages.length >= 2 ? handleSaveAsPower : undefined}
          savingPower={savingPower}
        />
      )}
    </div>
  );
}
