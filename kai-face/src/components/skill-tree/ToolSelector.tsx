import { useState, useMemo } from "react";
import { TOOL_CATALOG, TOOL_CATEGORIES } from "../../lib/tool-catalog";
import { getIntegrationLogoUrl } from "../../utils/integration-logos";

interface Props {
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  accentColor: string;
}

export default function ToolSelector({ selected, onChange, accentColor }: Props) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let items = TOOL_CATALOG;
    if (activeCategory) items = items.filter((t) => t.category === activeCategory);
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      );
    }
    return items;
  }, [search, activeCategory]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  return (
    <div className="w-full">
      <div className="relative mb-4">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tools..."
          className="w-full bg-gray-900/60 border border-gray-700/60 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-gray-500 transition-colors"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        )}
      </div>

      <div className="flex gap-1 mb-4 flex-wrap">
        <button
          onClick={() => setActiveCategory(null)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            !activeCategory ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"
          }`}
        >
          All
        </button>
        {TOOL_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(activeCategory === cat.id ? null : cat.id)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
            style={
              activeCategory === cat.id
                ? { backgroundColor: cat.color + "25", color: cat.color }
                : { color: "#6b7280" }
            }
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 max-h-[320px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-gray-700">
        {filtered.map((tool) => {
          const isSelected = selected.has(tool.id);
          const logoUrl = getIntegrationLogoUrl(tool.id);
          return (
            <button
              key={tool.id}
              onClick={() => toggle(tool.id)}
              className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all duration-150 ${
                isSelected
                  ? "bg-white/[0.05] border-gray-600"
                  : "bg-transparent border-gray-800/60 hover:border-gray-700 hover:bg-white/[0.02]"
              }`}
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-gray-800/80 overflow-hidden">
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="w-4 h-4" />
                ) : (
                  <span className="text-[11px] font-bold text-gray-400">{tool.name.slice(0, 2)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-white truncate block">{tool.name}</span>
                <p className="text-[11px] text-gray-500 truncate">{tool.description}</p>
              </div>
              <div
                className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors duration-150"
                style={
                  isSelected
                    ? { backgroundColor: accentColor, borderColor: accentColor }
                    : { borderColor: "#4b5563" }
                }
              >
                {isSelected && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-2 py-8 text-center text-sm text-gray-500">
            No tools match "{search}"
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-gray-600">
        {selected.size} selected &middot; You can always add more later
      </p>
    </div>
  );
}
