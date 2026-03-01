import { memo, useState, useCallback, useRef, useEffect } from "react";
import type { DashboardArtifact } from "../../hooks/useDashboardMetrics";
import type { PowerInfo } from "../../hooks/usePowers";
import { timeAgo } from "./shared";
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";

type CardSize = "sm" | "md" | "lg";

interface CardLayout {
  order: string[];
  sizes: Record<string, CardSize>;
}

const STORAGE_KEY = "kai:artifact-layout";

function loadLayout(): CardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { order: [], sizes: {} };
}

function saveLayout(layout: CardLayout) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch {}
}

const SIZE_COLS: Record<CardSize, string> = {
  sm: "",
  md: "sm:col-span-2",
  lg: "sm:col-span-2 lg:col-span-4",
};

const NEXT_SIZE: Record<CardSize, CardSize> = { sm: "md", md: "lg", lg: "sm" };

interface Props {
  metrics: DashboardArtifact[];
  loading: boolean;
  powers: PowerInfo[];
  onRefresh: (power: PowerInfo) => void;
  onDelete: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Content renderers
// ---------------------------------------------------------------------------

function NumberContent({ data }: { data: { value?: string; unit?: string } }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xl font-semibold text-white tabular-nums">{data.value ?? "—"}</span>
      {data.unit && <span className="text-xs text-gray-500">{data.unit}</span>}
    </div>
  );
}

function TextContent({ data }: { data: { content?: string } }) {
  return <div className="text-sm text-gray-400 line-clamp-4 whitespace-pre-wrap leading-relaxed">{data.content ?? ""}</div>;
}

function TableContent({ data, expanded }: { data: { columns?: string[]; rows?: string[][] }; expanded: boolean }) {
  const cols = data.columns ?? [];
  const rows = data.rows ?? [];
  if (cols.length === 0 && rows.length === 0) return <span className="text-xs text-gray-500">Empty table</span>;
  const limit = expanded ? rows.length : 8;

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs">
        {cols.length > 0 && (
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} className="text-left text-gray-400 font-medium px-2 py-1.5 border-b border-white/[0.04]">{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.slice(0, limit).map((row, ri) => (
            <tr key={ri} className="hover:bg-white/[0.02]">
              {row.map((cell, ci) => (
                <td key={ci} className="text-gray-400 px-2 py-1.5 border-b border-white/[0.02] truncate max-w-[200px]">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!expanded && rows.length > limit && (
        <div className="text-[11px] text-gray-500 mt-1.5 px-1">+{rows.length - limit} more rows</div>
      )}
    </div>
  );
}

function ImageContent({ data }: { data: { url?: string; alt?: string } }) {
  if (!data.url) return <span className="text-xs text-gray-500">No image</span>;
  return <img src={data.url} alt={data.alt ?? ""} className="rounded max-h-48 w-full object-contain" />;
}

function LinksContent({ data, expanded }: { data: { items?: Array<{ url: string; label: string; description?: string }> }; expanded: boolean }) {
  const items = data.items ?? [];
  if (items.length === 0) return <span className="text-xs text-gray-500">No links</span>;
  const limit = expanded ? items.length : 5;

  return (
    <div className="space-y-1.5">
      {items.slice(0, limit).map((link, i) => (
        <div key={i} className="flex flex-col">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate">{link.label}</a>
          {link.description && <span className="text-[11px] text-gray-500 truncate">{link.description}</span>}
        </div>
      ))}
      {!expanded && items.length > limit && (
        <div className="text-[11px] text-gray-500">+{items.length - limit} more</div>
      )}
    </div>
  );
}

function ReportContent({ data }: { data: { summary?: string; sections?: Array<{ heading: string; content: string; severity?: string }> } }) {
  const sevColor = (s?: string) =>
    s === "critical" ? "text-red-400" : s === "warning" ? "text-amber-400" : "text-gray-400";

  return (
    <div className="space-y-1.5">
      {data.summary && <div className="text-xs text-gray-300 leading-relaxed">{data.summary}</div>}
      {(data.sections ?? []).slice(0, 4).map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className={`text-xs font-medium ${sevColor(s.severity)}`}>{s.heading}</span>
        </div>
      ))}
      {(data.sections ?? []).length > 4 && (
        <div className="text-[11px] text-gray-500">+{(data.sections ?? []).length - 4} more sections</div>
      )}
    </div>
  );
}

const CHART_PALETTE = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#6366f1"];

interface ChartData {
  chartType?: string;
  labels?: string[];
  series?: Array<{ name: string; values: number[]; color?: string }>;
}

function ChartContent({ data, size }: { data: ChartData; size: CardSize }) {
  const chartType = data.chartType ?? "bar";
  const labels = data.labels ?? [];
  const series = data.series ?? [];
  if (labels.length === 0 || series.length === 0) return <span className="text-xs text-gray-600">No chart data</span>;

  const height = size === "lg" ? 280 : size === "md" ? 200 : 140;
  const rows = labels.map((label, i) => {
    const row: Record<string, string | number> = { name: label };
    for (const s of series) row[s.name] = s.values[i] ?? 0;
    return row;
  });

  const axisStyle = { fontSize: 9, fill: "#6b7280" };
  const gridStroke = "rgba(255,255,255,0.04)";

  if (chartType === "pie") {
    const pieData = labels.map((label, i) => ({ name: label, value: series[0]?.values[i] ?? 0 }));
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={height / 3} label={(props) => `${props.name ?? ""} ${((props.percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
            {pieData.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows}>
          <CartesianGrid stroke={gridStroke} />
          <XAxis dataKey="name" tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 11 }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
          {series.map((s, i) => (
            <Line key={s.name} type="monotone" dataKey={s.name} stroke={s.color || CHART_PALETTE[i % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "area") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows}>
          <CartesianGrid stroke={gridStroke} />
          <XAxis dataKey="name" tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 11 }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
          {series.map((s, i) => {
            const color = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
            return <Area key={s.name} type="monotone" dataKey={s.name} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />;
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // bar and stacked-bar
  const stacked = chartType === "stacked-bar";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows}>
        <CartesianGrid stroke={gridStroke} />
        <XAxis dataKey="name" tick={axisStyle} />
        <YAxis tick={axisStyle} />
        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 11 }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {series.map((s, i) => (
          <Bar key={s.name} dataKey={s.name} fill={s.color || CHART_PALETTE[i % CHART_PALETTE.length]} stackId={stacked ? "stack" : undefined} radius={stacked ? undefined : [2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function ArtifactBody({ artifact, size }: { artifact: DashboardArtifact; size: CardSize }) {
  const d = artifact.data as Record<string, unknown>;
  const expanded = size === "lg";
  switch (artifact.artifactType) {
    case "number": return <NumberContent data={d as { value?: string; unit?: string }} />;
    case "text": return <TextContent data={d as { content?: string }} />;
    case "table": return <TableContent data={d as { columns?: string[]; rows?: string[][] }} expanded={expanded} />;
    case "image": return <ImageContent data={d as { url?: string; alt?: string }} />;
    case "links": return <LinksContent data={d as { items?: Array<{ url: string; label: string; description?: string }> }} expanded={expanded} />;
    case "report": return <ReportContent data={d as { summary?: string; sections?: Array<{ heading: string; content: string; severity?: string }> }} />;
    case "chart": return <ChartContent data={d as ChartData} size={size} />;
    default: return <span className="text-xs text-gray-600">{JSON.stringify(d)}</span>;
  }
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const ArtifactCard = memo(function ArtifactCard({
  artifact, power, size, onRefresh, onDelete, onResize,
  onDragStart, onDragEnter, onDragEnd, isDragOver,
}: {
  artifact: DashboardArtifact;
  power: PowerInfo | undefined;
  size: CardSize;
  onRefresh: () => void;
  onDelete: () => void;
  onResize: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  isDragOver: boolean;
}) {
  return (
    <div
      className={`group relative flex flex-col gap-2 rounded-lg border px-4 py-3.5 transition-all ${SIZE_COLS[size]} ${
        isDragOver
          ? "border-blue-500/20 bg-blue-500/[0.03]"
          : "border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]"
      }`}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", artifact.id); onDragStart(); }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => { e.preventDefault(); onDragEnter(); }}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 cursor-grab active:cursor-grabbing">
          <svg width="8" height="12" viewBox="0 0 8 12" className="text-gray-800 group-hover:text-gray-600 shrink-0 transition-colors">
            <circle cx="2" cy="2" r="1" fill="currentColor" />
            <circle cx="6" cy="2" r="1" fill="currentColor" />
            <circle cx="2" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="2" cy="10" r="1" fill="currentColor" />
            <circle cx="6" cy="10" r="1" fill="currentColor" />
          </svg>
          {artifact.icon && <span className="text-sm shrink-0">{artifact.icon}</span>}
          <span className="text-xs text-gray-400 truncate font-medium">{artifact.label}</span>
          <span className="text-[10px] text-gray-600 px-1.5 py-0.5 rounded bg-white/[0.04]">{artifact.artifactType}</span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onResize} title={`Size: ${size}`} className="p-1 rounded hover:bg-white/10 text-gray-600 hover:text-gray-300 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {size === "sm" && <><polyline points="15 3 21 3 21 9" /><line x1="21" y1="3" x2="14" y2="10" /></>}
              {size === "md" && <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>}
              {size === "lg" && <><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></>}
            </svg>
          </button>
          {power && (
            <button onClick={onRefresh} title={`Re-run ${artifact.powerName}`} className="p-1 rounded hover:bg-white/10 text-gray-600 hover:text-gray-300 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          )}
          <button onClick={onDelete} title="Remove" className="p-1 rounded hover:bg-white/10 text-gray-600 hover:text-red-400 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <ArtifactBody artifact={artifact} size={size} />

      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-[11px] text-gray-600 truncate">{artifact.powerName}</span>
        <span className="text-[11px] text-gray-700">·</span>
        <span className="text-[11px] text-gray-600">{timeAgo(artifact.updatedAt)}</span>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export default function DashboardMetrics({ metrics, loading, powers, onRefresh, onDelete }: Props) {
  const [layout, setLayout] = useState<CardLayout>(loadLayout);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);

  const updateLayout = useCallback((fn: (prev: CardLayout) => CardLayout) => {
    setLayout((prev) => {
      const next = fn(prev);
      saveLayout(next);
      return next;
    });
  }, []);

  // Keep order in sync with actual metrics (new ones appended, deleted ones removed)
  useEffect(() => {
    const ids = new Set(metrics.map((m) => m.id));
    setLayout((prev) => {
      const existing = prev.order.filter((id) => ids.has(id));
      const newIds = metrics.map((m) => m.id).filter((id) => !prev.order.includes(id));
      const next = { ...prev, order: [...existing, ...newIds] };
      saveLayout(next);
      return next;
    });
  }, [metrics]);

  const sortedMetrics = (() => {
    const map = new Map(metrics.map((m) => [m.id, m]));
    const ordered: DashboardArtifact[] = [];
    for (const id of layout.order) {
      const m = map.get(id);
      if (m) ordered.push(m);
    }
    for (const m of metrics) {
      if (!layout.order.includes(m.id)) ordered.push(m);
    }
    return ordered;
  })();

  const handleDragStart = (id: string) => { dragSourceRef.current = id; };
  const handleDragEnter = (id: string) => { setDragOverId(id); };
  const handleDragEnd = () => {
    const src = dragSourceRef.current;
    const dst = dragOverId;
    dragSourceRef.current = null;
    setDragOverId(null);
    if (!src || !dst || src === dst) return;
    updateLayout((prev) => {
      const order = [...prev.order];
      const srcIdx = order.indexOf(src);
      const dstIdx = order.indexOf(dst);
      if (srcIdx === -1 || dstIdx === -1) return prev;
      order.splice(srcIdx, 1);
      order.splice(dstIdx, 0, src);
      return { ...prev, order };
    });
  };

  const cycleSize = (id: string) => {
    updateLayout((prev) => ({
      ...prev,
      sizes: { ...prev.sizes, [id]: NEXT_SIZE[prev.sizes[id] || "sm"] },
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
      </div>
    );
  }

  if (metrics.length === 0) return null;

  const powerMap = new Map(powers.map((p) => [p.id, p]));

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {sortedMetrics.map((m) => {
        const power = powerMap.get(m.powerId);
        const defaultSize = m.artifactType === "chart" || m.artifactType === "table" ? "md" : "sm";
        const size = layout.sizes[m.id] || defaultSize;
        return (
          <ArtifactCard
            key={m.id}
            artifact={m}
            power={power}
            size={size}
            onRefresh={() => power && onRefresh(power)}
            onDelete={() => onDelete(m.id)}
            onResize={() => cycleSize(m.id)}
            onDragStart={() => handleDragStart(m.id)}
            onDragEnter={() => handleDragEnter(m.id)}
            onDragEnd={handleDragEnd}
            isDragOver={dragOverId === m.id}
          />
        );
      })}
    </div>
  );
}
