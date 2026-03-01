import { useState, useEffect, useCallback, useMemo } from "react";
import type { PowerInfo } from "../../hooks/usePowers";
import { CategoryIcon, catAccent } from "./shared";

const STORAGE_KEY = "kai:pinned-powers";

export function usePinnedPowers() {
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  const pin = useCallback((id: string) => {
    setPinnedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const unpin = useCallback((id: string) => {
    setPinnedIds((prev) => prev.filter((p) => p !== id));
  }, []);

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds]);

  return { pinnedIds, pin, unpin, isPinned };
}

interface Props {
  powers: PowerInfo[];
  pinnedIds: string[];
  onRun: (power: PowerInfo) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onAddClick: () => void;
}

export default function QuickActions({ powers, pinnedIds, onRun, onUnpin, onAddClick }: Props) {
  const pinned = useMemo(
    () => pinnedIds.map((id) => powers.find((p) => p.id === id)).filter(Boolean) as PowerInfo[],
    [pinnedIds, powers],
  );

  if (pinned.length === 0 && powers.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
      {pinned.map((power) => {
        const accent = catAccent(power.category);
        const disabled = !power.available;
        return (
          <button
            key={power.id}
            onClick={() => !disabled && onRun(power)}
            disabled={disabled}
            className={`group relative shrink-0 flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-all duration-200 ${
              disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:translate-y-[-1px]"
            }`}
            style={{
              background: "rgba(15,23,42,0.5)",
              border: `1px solid ${accent}20`,
            }}
            onMouseEnter={(e) => {
              if (!disabled) e.currentTarget.style.borderColor = `${accent}40`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = `${accent}20`;
            }}
          >
            <div
              className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: `${accent}15`, color: accent }}
            >
              <CategoryIcon category={power.category} size={14} />
            </div>
            <span className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors whitespace-nowrap">
              {power.name}
            </span>
            {!disabled && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className="text-gray-700 group-hover:text-gray-400 transition-colors shrink-0">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onUnpin(power.id); }}
              className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-gray-800 border border-gray-700/50 flex items-center justify-center text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </button>
        );
      })}

      <button
        onClick={onAddClick}
        className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-700/30 text-gray-600 hover:text-gray-400 hover:border-gray-600/40 transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span className="text-xs font-medium whitespace-nowrap">Add Power</span>
      </button>
    </div>
  );
}
