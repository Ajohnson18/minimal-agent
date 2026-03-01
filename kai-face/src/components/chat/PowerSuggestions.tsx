import { useState, useMemo } from "react";
import type { PowerInfo } from "../../hooks/usePowers";

interface Props {
  powers: PowerInfo[];
  loading: boolean;
  onExecute: (power: PowerInfo) => void;
}

const CATEGORY_STYLES: Record<string, {
  gradient: string;
  glow: string;
  border: string;
  iconBg: string;
  text: string;
  shimmer: string;
}> = {
  security: {
    gradient: "from-red-500/8 via-red-600/4 to-transparent",
    glow: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.15)",
    iconBg: "rgba(239,68,68,0.12)",
    text: "text-red-400",
    shimmer: "rgba(239,68,68,0.06)",
  },
  quality: {
    gradient: "from-amber-500/8 via-amber-600/4 to-transparent",
    glow: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.15)",
    iconBg: "rgba(245,158,11,0.12)",
    text: "text-amber-400",
    shimmer: "rgba(245,158,11,0.06)",
  },
  ops: {
    gradient: "from-emerald-500/8 via-emerald-600/4 to-transparent",
    glow: "rgba(16,185,129,0.08)",
    border: "rgba(16,185,129,0.15)",
    iconBg: "rgba(16,185,129,0.12)",
    text: "text-emerald-400",
    shimmer: "rgba(16,185,129,0.06)",
  },
  analysis: {
    gradient: "from-violet-500/8 via-violet-600/4 to-transparent",
    glow: "rgba(139,92,246,0.08)",
    border: "rgba(139,92,246,0.15)",
    iconBg: "rgba(139,92,246,0.12)",
    text: "text-violet-400",
    shimmer: "rgba(139,92,246,0.06)",
  },
};

function PowerCard({ power, index, onExecute }: {
  power: PowerInfo;
  index: number;
  onExecute: (power: PowerInfo) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const style = CATEGORY_STYLES[power.category] || CATEGORY_STYLES.analysis;
  const disabled = !power.available;

  return (
    <button
      onClick={() => !disabled && onExecute(power)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      className={`
        relative group w-full text-left rounded-xl p-3.5
        animate-power-fade-up
        transition-[border-color,background,box-shadow] duration-300 ease-out
        ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
      `}
      style={{
        animationDelay: `${index * 100 + 200}ms`,
        border: `1px solid ${hovered && !disabled ? style.border : "rgba(71,85,105,0.15)"}`,
        background: hovered && !disabled
          ? `linear-gradient(135deg, ${style.glow} 0%, transparent 60%)`
          : "rgba(15,23,42,0.4)",
        boxShadow: hovered && !disabled
          ? `0 0 24px ${style.glow}, 0 4px 16px rgba(0,0,0,0.2)`
          : "0 1px 4px rgba(0,0,0,0.1)",
      }}
    >
      {/* Shimmer overlay on hover */}
      {hovered && !disabled && (
        <div
          className="absolute inset-0 rounded-xl animate-power-shimmer pointer-events-none"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${style.shimmer} 50%, transparent 100%)`,
            backgroundSize: "200% 100%",
          }}
        />
      )}

      {/* Glow dot */}
      <div
        className="absolute -top-px -right-px h-2 w-2 rounded-full animate-power-glow"
        style={{
          background: style.border,
          boxShadow: `0 0 8px ${style.glow}`,
          animationDelay: `${index * 400}ms`,
        }}
      />

      <div className="relative flex items-start gap-3">
        {/* Icon */}
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-300"
          style={{
            background: style.iconBg,
            transform: hovered && !disabled ? "scale(1.1)" : "scale(1)",
          }}
        >
          <span className="text-base">{power.icon}</span>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`text-[11px] font-semibold tracking-wide transition-colors duration-200 ${
              hovered && !disabled ? "text-white" : "text-gray-300"
            }`}>
              {power.name}
            </p>
            <span className={`text-[8px] uppercase tracking-widest font-medium ${style.text} opacity-60`}>
              {power.category}
            </span>
          </div>
          <p className="text-[10px] text-gray-500 mt-1 leading-relaxed line-clamp-2">
            {power.description}
          </p>

          {/* Skills & tools on hover */}
          {hovered && !disabled && (power.skills.length > 0 || power.tools.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {power.skills.map((s, i) => (
                <span
                  key={`s-${i}`}
                  className="text-[8px] px-1.5 py-0.5 rounded-md bg-blue-500/[0.06] text-blue-400/70 border border-blue-500/[0.1] animate-power-fade-up"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  {s}
                </span>
              ))}
              {power.tools.slice(0, 4).map((t, i) => (
                <span
                  key={`t-${i}`}
                  className="text-[8px] px-1.5 py-0.5 rounded-md bg-white/[0.04] text-gray-500 border border-white/[0.06] animate-power-fade-up"
                  style={{ animationDelay: `${(power.skills.length + i) * 60}ms` }}
                >
                  {t}
                </span>
              ))}
              {power.tools.length > 4 && (
                <span className="text-[8px] px-1.5 py-0.5 text-gray-600">
                  +{power.tools.length - 4} more
                </span>
              )}
            </div>
          )}

          {/* Output description on hover */}
          {hovered && !disabled && power.output && (
            <p className="text-[8px] text-gray-600 mt-1.5 italic animate-power-fade-up" style={{ animationDelay: "120ms" }}>
              Output: {power.output}
            </p>
          )}

          {disabled && power.missingIntegrations.length > 0 && (
            <p className="text-[9px] text-amber-500/60 mt-1.5 flex items-center gap-1">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Requires {power.missingIntegrations.join(", ")}
            </p>
          )}
        </div>

        {/* Run arrow */}
        {!disabled && (
          <div className={`
            h-6 w-6 rounded-md flex items-center justify-center shrink-0 mt-0.5
            transition-[opacity,transform] duration-300
            ${hovered ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-1"}
          `}
            style={{ background: style.iconBg }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={style.text}>
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

export default function PowerSuggestions({ powers, loading, onExecute }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <div className="h-3 w-3 rounded-full border-2 border-blue-500/20 border-t-blue-400/60 animate-spin" />
      </div>
    );
  }

  const available = useMemo(() => powers.filter((p) => p.available), [powers]);
  const locked = useMemo(() => powers.filter((p) => !p.available), [powers]);

  if (powers.length === 0) return null;

  return (
    <div className="w-full max-w-[320px] space-y-2 mt-6">
      <p
        className="text-[9px] font-semibold text-gray-600 uppercase tracking-[0.15em] text-center mb-3 animate-power-fade-up"
        style={{ animationDelay: "100ms" }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="inline-block mr-1.5 -mt-px text-blue-500/50">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        Powers
      </p>

      {available.map((power, i) => (
        <PowerCard key={power.id} power={power} index={i} onExecute={onExecute} />
      ))}
      {locked.map((power, i) => (
        <PowerCard key={power.id} power={power} index={available.length + i} onExecute={onExecute} />
      ))}
    </div>
  );
}
