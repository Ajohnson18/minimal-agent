import { type ReactNode } from "react";

interface Props {
  id: string;
  title: string;
  children: ReactNode;
  minimized: boolean;
  expanded: boolean;
  onToggleMinimize: () => void;
  onToggleExpand: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  isDragOver?: boolean;
  className?: string;
}

export default function DraggablePanel({
  id, title, children, minimized, expanded,
  onToggleMinimize, onToggleExpand,
  onDragStart, onDragEnter, onDragEnd,
  isDragOver, className = "",
}: Props) {
  return (
    <div
      data-panel-id={id}
      className={`rounded-xl border overflow-hidden transition-all duration-200 ${
        isDragOver
          ? "border-blue-500/20 ring-1 ring-blue-500/10 bg-blue-500/[0.02]"
          : "border-white/[0.04] bg-gray-950/60"
      } ${className}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => { e.preventDefault(); onDragEnter(); }}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-center gap-2.5 px-4 py-2.5 cursor-grab active:cursor-grabbing select-none group">
        <svg width="10" height="14" viewBox="0 0 10 14" className="text-gray-700 group-hover:text-gray-500 shrink-0 transition-colors">
          <circle cx="2.5" cy="2" r="1" fill="currentColor" />
          <circle cx="7.5" cy="2" r="1" fill="currentColor" />
          <circle cx="2.5" cy="7" r="1" fill="currentColor" />
          <circle cx="7.5" cy="7" r="1" fill="currentColor" />
          <circle cx="2.5" cy="12" r="1" fill="currentColor" />
          <circle cx="7.5" cy="12" r="1" fill="currentColor" />
        </svg>
        <span className="text-xs font-semibold text-gray-400 tracking-wide flex-1 truncate">{title}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="p-1 rounded text-gray-700 hover:text-gray-300 hover:bg-white/5 transition-colors"
          title={expanded ? "Default size" : "Expand"}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {expanded ? (
              <><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></>
            ) : (
              <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>
            )}
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMinimize(); }}
          className="p-1 rounded text-gray-700 hover:text-gray-300 hover:bg-white/5 transition-colors"
          title={minimized ? "Restore" : "Minimize"}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {minimized ? (
              <polyline points="6 15 12 9 18 15" />
            ) : (
              <line x1="5" y1="12" x2="19" y2="12" />
            )}
          </svg>
        </button>
      </div>
      {!minimized && (
        <div className="px-5 pb-5 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}
