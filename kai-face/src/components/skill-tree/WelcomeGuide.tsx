import { useState, useEffect } from "react";

const STORAGE_KEY = "kai:guide-visited";

const GUIDE_ITEMS = [
  { keys: ["←", "→", "↑", "↓"], text: "Navigate between nodes" },
  { keys: ["Enter"], text: "Open a branch" },
  { keys: ["Esc"], text: "Go back / deselect" },
  { keys: ["Scroll"], text: "Zoom in & out" },
  { keys: ["Drag"], text: "Pan around the map" },
  { keys: ["Type"], text: "Open command bar" },
];

const BRANCHES = [
  { id: "engineering", label: "E", color: "#f97316", border: "#fb923c" },
  { id: "design", label: "D", color: "#a855f7", border: "#c084fc" },
  { id: "product", label: "P", color: "#06b6d4", border: "#22d3ee" },
  { id: "general", label: "G", color: "#10b981", border: "#34d399" },
];

function loadVisited(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")); } catch { return new Set(); }
}

function saveVisited(visited: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...visited]));
}

interface Props {
  autoOpen?: boolean;
  onNavigate?: (branchId: string) => void;
}

export default function WelcomeGuide({ autoOpen, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(loadVisited);

  useEffect(() => {
    if (autoOpen) {
      const t = setTimeout(() => setOpen(true), 800);
      return () => clearTimeout(t);
    }
  }, [autoOpen]);

  function handleBranchClick(branchId: string) {
    const next = new Set(visited);
    next.add(branchId);
    setVisited(next);
    saveVisited(next);
    onNavigate?.(branchId);
  }

  return (
    <div className="absolute top-4 left-4 z-30 flex items-center gap-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`w-14 h-14 rounded-full border-2 flex items-center justify-center text-xl font-serif italic transition-[background-color,border-color,color] duration-200 cursor-pointer ${
          open
            ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
            : "bg-gray-800/80 border-gray-700/50 text-gray-500 hover:text-gray-300 hover:border-gray-600"
        }`}
      >
        i
      </button>
      {open && (
        <div className="absolute top-[72px] left-0 mt-1 w-[340px] rounded-xl border border-gray-700/50 bg-gray-900/90 backdrop-blur-md shadow-2xl animate-in fade-in zoom-in-95 origin-top-left">
          <div className="px-6 pt-6 pb-3">
            <p className="text-base font-medium text-gray-200">Your dashboard</p>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Explore each branch to configure skills, integrations, and tools. Click a branch to expand it.
            </p>
          </div>

          <div className="px-6 pb-4 pt-1 flex flex-col gap-2.5">
            {GUIDE_ITEMS.map(({ keys, text }) => (
              <div key={text} className="flex items-center gap-3 text-sm">
                <div className="flex gap-0.5 shrink-0 min-w-[70px] justify-end">
                  {keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded bg-gray-800 border border-gray-700/60 px-2 py-0.5 text-xs text-gray-400 font-mono"
                    >
                      {k}
                    </kbd>
                  ))}
                </div>
                <span className="text-gray-500">{text}</span>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-800 px-6 py-4">
            <p className="text-xs text-gray-500 mb-3">Visit each branch</p>
            <div className="flex items-center gap-3">
              {BRANCHES.map(({ id, label, color, border }) => {
                const done = visited.has(id);
                return (
                  <button
                    key={id}
                    onClick={() => handleBranchClick(id)}
                    className="flex flex-col items-center gap-1.5 group cursor-pointer"
                  >
                    <div
                      className="w-10 h-10 rounded-full border-2 flex items-center justify-center text-sm font-bold transition-[transform,border-color,background-color,color] duration-200 group-hover:scale-110"
                      style={{
                        borderColor: done ? border : "#334155",
                        background: done ? `${color}20` : "transparent",
                        color: done ? border : "#64748b",
                      }}
                    >
                      {done ? "✓" : label}
                    </div>
                    <span className="text-[11px] capitalize" style={{ color: done ? border : "#64748b" }}>
                      {id}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
