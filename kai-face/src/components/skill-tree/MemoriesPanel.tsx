import { useEffect } from "react";
import { useMemories, type Memory } from "../../hooks/useMemories";

interface Props {
  onClose: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  conversation: "Conversation",
  note: "Note",
  fact: "Fact",
};

function importanceBadge(importance: number) {
  if (importance >= 0.8) return { label: "High", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  if (importance >= 0.5) return { label: "Med", cls: "bg-slate-500/15 text-slate-400 border-slate-600/30" };
  return { label: "Low", cls: "bg-slate-500/10 text-slate-500 border-slate-700/30" };
}

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function MemoryRow({ memory, onDelete }: { memory: Memory; onDelete: () => void }) {
  const badge = importanceBadge(memory.importance);
  return (
    <div className="group rounded-lg bg-slate-800/40 border border-slate-700/30 px-3.5 py-3 hover:border-slate-600/50 transition-colors">
      <div className="flex items-start gap-2">
        <p className="text-sm text-slate-300 flex-1 leading-relaxed">{memory.content}</p>
        <button onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all text-xs shrink-0 mt-0.5"
          title="Delete memory">✕</button>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.label}</span>
        <span className="text-[10px] text-slate-600">{SOURCE_LABEL[memory.source] ?? memory.source}</span>
        <span className="text-[10px] text-slate-600">·</span>
        <span className="text-[10px] text-slate-600">{relativeTime(memory.createdAt)}</span>
      </div>
    </div>
  );
}

export default function MemoriesPanel({ onClose }: Props) {
  const { memories, loading, fetch, remove } = useMemories();

  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="absolute right-4 top-4 w-[min(400px,32vw)] min-w-[280px] rounded-xl border border-gray-700 bg-gray-900/95 backdrop-blur-sm shadow-2xl z-10 flex flex-col max-h-[80vh]">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Memories</h3>
            <span className="text-[11px] text-slate-500">
              {loading ? "Loading..." : `${memories.length} stored`}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-2 scrollbar-thin scrollbar-thumb-slate-700">
        {!loading && memories.length === 0 && (
          <div className="text-center py-10">
            <p className="text-sm text-slate-500">No memories yet</p>
            <p className="text-xs text-slate-600 mt-1">Memories are extracted from your conversations</p>
          </div>
        )}
        {memories.map((m) => (
          <MemoryRow key={m.id} memory={m} onDelete={() => remove(m.id)} />
        ))}
      </div>
    </div>
  );
}
