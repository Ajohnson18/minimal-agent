import { memo } from "react";
import type { PowerRun } from "../../hooks/usePowerRuns";
import { StatusDot, timeAgo } from "./shared";

interface Props {
  runs: PowerRun[];
  loading: boolean;
  onClickRun: (run: PowerRun) => void;
}

const RunRow = memo(function RunRow({ run, onClick }: { run: PowerRun; onClick: () => void }) {
  const duration =
    run.completedAt && run.startedAt
      ? Math.round((run.completedAt - run.startedAt) / 1000)
      : null;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-800/30 transition-colors text-left"
    >
      <StatusDot status={run.status} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-300 truncate">{run.powerName || run.powerId}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-gray-500">{timeAgo(run.startedAt)}</span>
          {duration !== null && (
            <>
              <span className="text-[11px] text-gray-600">·</span>
              <span className="text-[11px] text-gray-500">{duration}s</span>
            </>
          )}
          {run.result?.type && run.result.type !== "text" && (
            <>
              <span className="text-[11px] text-gray-600">·</span>
              <span className="text-[11px] text-gray-500 uppercase">{run.result.type}</span>
            </>
          )}
        </div>
      </div>
      <span
        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
          run.status === "completed"
            ? "text-emerald-400 bg-emerald-500/10"
            : run.status === "error"
              ? "text-red-400 bg-red-500/10"
              : run.status === "running"
                ? "text-blue-400 bg-blue-500/10"
                : "text-gray-500 bg-gray-500/10"
        }`}
      >
        {run.status}
      </span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-700 shrink-0">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
});

export default function RecentRuns({ runs, loading, onClickRun }: Props) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Recent Runs</h2>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-800 mb-3">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p className="text-xs text-gray-600">No runs yet</p>
          <p className="text-[11px] text-gray-600 mt-1">Execute a power to see history here</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} onClick={() => onClickRun(r)} />
          ))}
        </div>
      )}
    </div>
  );
}
