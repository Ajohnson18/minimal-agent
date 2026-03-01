import type { PowerRun } from "../../hooks/usePowerRuns";
import PowerResult from "./PowerResult";
import { StatusDot, timeAgo } from "./shared";

interface Props {
  run: PowerRun;
  onClose: () => void;
  onViewChat: () => void;
}

export default function RunResultModal({ run, onClose, onViewChat }: Props) {
  const duration =
    run.completedAt && run.startedAt
      ? Math.round((run.completedAt - run.startedAt) / 1000)
      : null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[90vw] max-h-[70vh] flex flex-col rounded-2xl border border-gray-700/30 shadow-2xl shadow-black/50 overflow-hidden"
        style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #020617 100%)" }}>

        <div className="flex items-center justify-between px-6 py-4 shrink-0 border-b border-gray-800/30">
          <div className="flex items-center gap-3 min-w-0">
            <StatusDot status={run.status} />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white truncate">{run.powerName || run.powerId}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-600">{timeAgo(run.startedAt)}</span>
                {duration !== null && (
                  <>
                    <span className="text-[10px] text-gray-700">·</span>
                    <span className="text-[10px] text-gray-600">{duration}s</span>
                  </>
                )}
                <span className="text-[10px] text-gray-700">·</span>
                <span className={`text-[10px] font-medium ${
                  run.status === "completed" ? "text-emerald-400" : run.status === "error" ? "text-red-400" : "text-blue-400"
                }`}>
                  {run.status}
                </span>
                {run.result?.type && run.result.type !== "text" && (
                  <>
                    <span className="text-[10px] text-gray-700">·</span>
                    <span className="text-[9px] text-gray-600 uppercase tracking-wider">{run.result.type}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-lg flex items-center justify-center text-gray-600 hover:text-white hover:bg-gray-800/50 transition-colors shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
          {run.error ? (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
              <p className="text-xs text-red-400">{run.error}</p>
            </div>
          ) : (
            <PowerResult result={run.result} />
          )}
        </div>

        <div className="shrink-0 px-6 py-3 border-t border-gray-800/30 flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-gray-800/30 transition-colors">
            Close
          </button>
          <button onClick={onViewChat} className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600/10 text-blue-400 hover:bg-blue-600/20 ring-1 ring-blue-500/20 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            View Full Chat
          </button>
        </div>
      </div>
    </>
  );
}
