import type { PowerInfo } from "../../hooks/usePowers";

interface Props {
  powers: PowerInfo[];
  loading: boolean;
  onExecute: (power: PowerInfo) => void;
  onClose: () => void;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; ring: string }> = {
  security: { bg: "bg-red-500/10", text: "text-red-400", ring: "ring-red-500/20" },
  quality: { bg: "bg-amber-500/10", text: "text-amber-400", ring: "ring-amber-500/20" },
  ops: { bg: "bg-green-500/10", text: "text-green-400", ring: "ring-green-500/20" },
  analysis: { bg: "bg-purple-500/10", text: "text-purple-400", ring: "ring-purple-500/20" },
};

export default function PowersList({ powers, loading, onExecute, onClose }: Props) {
  if (loading) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 mx-1 rounded-xl overflow-hidden ring-1 ring-gray-700/40"
        style={{ background: "rgba(10,15,30,0.95)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center justify-center py-8">
          <div className="h-4 w-4 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin" />
        </div>
      </div>
    );
  }

  if (powers.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 mx-1 rounded-xl overflow-hidden ring-1 ring-gray-700/40 p-6 text-center"
        style={{ background: "rgba(10,15,30,0.95)", backdropFilter: "blur(16px)" }}>
        <p className="text-xs text-gray-500">No powers available yet</p>
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 mx-1 rounded-xl overflow-hidden ring-1 ring-gray-700/40"
      style={{ background: "rgba(10,15,30,0.95)", backdropFilter: "blur(16px)" }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800/40">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Powers</span>
        <button onClick={onClose}
          className="h-5 w-5 rounded flex items-center justify-center text-gray-600 hover:text-gray-300 transition-colors">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="max-h-[280px] overflow-y-auto py-1.5 px-1.5 space-y-1 scrollbar-thin">
        {powers.map((power) => {
          const colors = CATEGORY_COLORS[power.category] || CATEGORY_COLORS.analysis;
          const disabled = !power.available;

          return (
            <button
              key={power.id}
              onClick={() => !disabled && onExecute(power)}
              disabled={disabled}
              className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors duration-200 group ${
                disabled
                  ? "opacity-40 cursor-not-allowed"
                  : "hover:bg-gray-800/50 cursor-pointer"
              }`}
            >
              <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ring-1 ${colors.bg} ${colors.ring}`}>
                <span className="text-sm">{power.icon}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-gray-200 group-hover:text-white transition-colors truncate">
                    {power.name}
                  </p>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ring-1 ${colors.bg} ${colors.text} ${colors.ring}`}>
                    {power.category}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
                  {power.description}
                </p>
                {(power.skills.length > 0 || power.tools.length > 0) && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {power.skills.map((s, i) => (
                      <span key={`s-${i}`} className="text-[8px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400/70 ring-1 ring-blue-500/15">
                        {s}
                      </span>
                    ))}
                    {power.tools.slice(0, 3).map((t, i) => (
                      <span key={`t-${i}`} className="text-[8px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-500 ring-1 ring-gray-700/30">
                        {t}
                      </span>
                    ))}
                    {power.tools.length > 3 && (
                      <span className="text-[8px] px-1.5 py-0.5 text-gray-600">+{power.tools.length - 3}</span>
                    )}
                  </div>
                )}
                {power.output && (
                  <p className="text-[9px] text-gray-600 mt-1 italic">
                    Output: {power.output}
                  </p>
                )}
                {disabled && power.missingIntegrations.length > 0 && (
                  <p className="text-[10px] text-amber-500/70 mt-1 flex items-center gap-1">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Requires: {power.missingIntegrations.join(", ")}
                  </p>
                )}
              </div>
              {!disabled && (
                <div className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 mt-1 opacity-0 group-hover:opacity-100 bg-blue-600/20 text-blue-400 transition-opacity duration-200">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
