import { useState, memo, useMemo, useCallback } from "react";
import { rpc } from "../../lib/gateway";
import { usePowers, useCommunityPowers, type PowerInfo, type CommunityPowerInfo } from "../../hooks/usePowers";
import { CategoryIcon, catAccent, DepChip, CATEGORIES, type Category } from "./shared";

const PowerCard = memo(function PowerCard({ power, onRun, onSelect }: { power: PowerInfo; onRun: (p: PowerInfo) => void; onSelect: (p: PowerInfo) => void }) {
  const accent = catAccent(power.category);
  const disabled = !power.available;

  return (
    <div
      className={`group rounded-xl p-4 transition-all duration-200 cursor-pointer ${
        disabled ? "opacity-40" : "hover:bg-gray-800/40"
      }`}
      style={{ border: "1px solid rgba(71,85,105,0.12)" }}
      onClick={() => onSelect(power)}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.borderColor = `${accent}30`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(71,85,105,0.12)";
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${accent}12`, border: `1px solid ${accent}20`, color: accent }}
        >
          <CategoryIcon category={power.category} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-gray-200 group-hover:text-white transition-colors truncate">
              {power.name}
            </h3>
            <span className="text-[9px] font-medium uppercase tracking-wider opacity-50 shrink-0" style={{ color: accent }}>
              {power.category}
            </span>
          </div>
          <p className="text-[11px] text-gray-500 mt-1 line-clamp-2 leading-relaxed">{power.description}</p>
          {power.dependsOn.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {power.dependsOn.map((dep) => (
                <DepChip key={dep} name={dep} met={!power.missingIntegrations.includes(dep)} />
              ))}
            </div>
          )}
        </div>
        {!disabled && (
          <button
            onClick={(e) => { e.stopPropagation(); onRun(power); }}
            className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-gray-600 hover:text-white hover:bg-blue-600 transition-all opacity-0 group-hover:opacity-100"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

const CommunityCard = memo(function CommunityCard({ power, onInstall, installing }: { power: CommunityPowerInfo; onInstall: (id: string) => void; installing: string | null }) {
  const accent = catAccent(power.category);
  const busy = installing === power.id;

  return (
    <div className="rounded-xl p-4 hover:bg-gray-800/30 transition-colors" style={{ border: "1px solid rgba(71,85,105,0.08)" }}>
      <div className="flex items-start gap-3">
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${accent}10`, border: `1px solid ${accent}18`, color: accent }}
        >
          <CategoryIcon category={power.category} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-gray-300 truncate">{power.name}</p>
          <p className="text-[11px] text-gray-600 mt-1 line-clamp-2 leading-relaxed">{power.description}</p>
          {power.dependsOn.length > 0 && (
            <p className="text-[9px] text-gray-700 mt-1.5">Requires: {power.dependsOn.join(", ")}</p>
          )}
        </div>
        {power.installed ? (
          <span className="text-[9px] text-emerald-500/70 font-medium shrink-0 mt-1">Added</span>
        ) : (
          <button
            onClick={() => onInstall(power.id)}
            disabled={busy}
            className="shrink-0 text-[10px] px-3 py-1.5 rounded-lg bg-gray-800/60 text-gray-400 hover:text-white hover:bg-gray-700/60 ring-1 ring-gray-700/40 transition-colors font-medium disabled:opacity-50 mt-0.5"
          >
            {busy ? "..." : "Install"}
          </button>
        )}
      </div>
    </div>
  );
});

interface Props {
  onRunPower: (power: PowerInfo) => void;
  onSelectPower: (power: PowerInfo) => void;
}

export default function PowerLibrary({ onRunPower, onSelectPower }: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [tab, setTab] = useState<"mine" | "community">("mine");
  const [installing, setInstalling] = useState<string | null>(null);
  const { powers, loading, refetch: refetchPowers } = usePowers();
  const { powers: communityPowers, loading: communityLoading, refetch: refetchCommunity } = useCommunityPowers();

  const filtered = useMemo(() => powers.filter((p) => {
    if (category !== "all" && p.category !== category) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [powers, category, search]);

  const handleInstall = useCallback(async (powerId: string) => {
    setInstalling(powerId);
    try {
      await rpc("powers.install", { powerId });
      refetchCommunity();
      refetchPowers();
    } catch (err) {
      console.error("Failed to install:", err);
    } finally {
      setInstalling(null);
    }
  }, [refetchCommunity, refetchPowers]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-1 mb-3">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Power Library</h2>
        <div className="flex gap-px bg-gray-800/40 rounded-lg p-0.5">
          {(["mine", "community"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-[10px] font-semibold rounded-md transition-colors ${
                tab === t ? "text-white bg-gray-700/60" : "text-gray-600 hover:text-gray-400"
              }`}
            >
              {t === "mine" ? "My Powers" : "Community"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative mb-3">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search powers..."
          className="w-full bg-gray-900/50 text-xs text-gray-200 rounded-lg pl-9 pr-3 py-2.5 ring-1 ring-gray-700/20 focus:ring-blue-500/20 outline-none placeholder-gray-600 transition-shadow"
        />
      </div>

      {tab === "mine" && (
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors capitalize ${
                category === c
                  ? "text-white bg-gray-700/60 ring-1 ring-gray-600/30"
                  : "text-gray-600 hover:text-gray-400 hover:bg-gray-800/30"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-1.5 scrollbar-thin">
        {tab === "mine" ? (
          loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-4 w-4 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[11px] text-gray-600 mb-2">
                {search || category !== "all" ? "No matching powers" : "No powers yet"}
              </p>
              {!search && category === "all" && (
                <button onClick={() => setTab("community")} className="text-[10px] text-blue-400/70 hover:text-blue-400 transition-colors">
                  Browse community powers
                </button>
              )}
            </div>
          ) : (
            filtered.map((p) => <PowerCard key={p.id} power={p} onRun={onRunPower} onSelect={onSelectPower} />)
          )
        ) : communityLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-4 w-4 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
          </div>
        ) : (
          communityPowers.map((p) => <CommunityCard key={p.id} power={p} onInstall={handleInstall} installing={installing} />)
        )}
      </div>
    </div>
  );
}
