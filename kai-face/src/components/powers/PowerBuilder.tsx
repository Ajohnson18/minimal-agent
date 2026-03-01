import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { rpc } from "../../lib/gateway";
import { getSkillTree, type SkillTreeDbNode } from "../../api/setup";
import { CategoryIcon, catAccent } from "./shared";

type Step = "basics" | "capabilities" | "steps" | "review";
const STEPS: Step[] = ["basics", "capabilities", "steps", "review"];
const STEP_LABELS: Record<Step, string> = {
  basics: "Basics",
  capabilities: "Skills & Integrations",
  steps: "Steps & Output",
  review: "Review & Create",
};

const CATEGORY_OPTIONS = [
  { value: "general", label: "General" },
  { value: "security", label: "Security" },
  { value: "quality", label: "Quality" },
  { value: "ops", label: "Ops" },
  { value: "analysis", label: "Analysis" },
];

const OUTPUT_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "text", label: "Text", desc: "Plain markdown response" },
  { value: "report", label: "Report", desc: "Structured report with sections and scores" },
  { value: "code", label: "Code", desc: "Code files with diffs" },
  { value: "pr", label: "Pull Request", desc: "GitHub PR creation" },
  { value: "table", label: "Table", desc: "Tabular data with columns and rows" },
  { value: "links", label: "Links", desc: "Collection of annotated links" },
];

const BRANCH_LABELS: Record<string, string> = {
  engineering: "Engineering",
  design: "Design",
  product: "Product",
  general: "General",
};

function OutputIcon({ type, size = 14 }: { type: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "shrink-0" };
  switch (type) {
    case "report":
      return <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
    case "code":
      return <svg {...p}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
    case "pr":
      return <svg {...p}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 009 9" /></svg>;
    case "table":
      return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /></svg>;
    case "links":
      return <svg {...p}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>;
    default:
      return <svg {...p}><line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" /></svg>;
  }
}

export default function PowerBuilder() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<Step>("basics");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Basics
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");

  // Capabilities
  const [skillTreeNodes, setSkillTreeNodes] = useState<SkillTreeDbNode[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [selectedIntegrations, setSelectedIntegrations] = useState<Set<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [capSearch, setCapSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState<string | null>(null);

  // Steps & Output
  const [steps, setSteps] = useState<string[]>([""]);
  const [output, setOutput] = useState("text");

  useEffect(() => {
    getSkillTree()
      .then((data) => setSkillTreeNodes(data.nodes))
      .catch(() => setSkillTreeNodes([]))
      .finally(() => setLoadingNodes(false));
  }, []);

  const grouped = useMemo(() => {
    const q = capSearch.toLowerCase();
    const filtered = skillTreeNodes.filter((n) => {
      if (branchFilter && n.branch !== branchFilter) return false;
      if (q && !n.label.toLowerCase().includes(q) && !n.description.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      integrations: filtered.filter((n) => n.nodeType === "integration"),
      skills: filtered.filter((n) => n.nodeType === "skill"),
      tools: filtered.filter((n) => n.nodeType === "tool"),
    };
  }, [skillTreeNodes, capSearch, branchFilter]);

  const branches = useMemo(() => {
    const set = new Set<string>();
    skillTreeNodes.forEach((n) => { if (n.branch) set.add(n.branch); });
    return Array.from(set).sort();
  }, [skillTreeNodes]);

  const currentIdx = STEPS.indexOf(currentStep);
  const canNext = currentStep === "basics" ? !!(name.trim() && description.trim()) : true;

  function toggleSet(set: Set<string>, setFn: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setFn((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function addStep() { setSteps((s) => [...s, ""]); }
  function removeStep(i: number) { setSteps((s) => s.filter((_, idx) => idx !== i)); }
  function updateStep(i: number, val: string) { setSteps((s) => s.map((v, idx) => (idx === i ? val : v))); }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    setSteps((s) => { const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  }

  async function handleCreate() {
    setSaving(true);
    setError(null);
    try {
      await rpc("powers.create", {
        name: name.trim(),
        description: description.trim(),
        category,
        dependsOn: Array.from(selectedIntegrations),
        skills: Array.from(selectedSkills),
        tools: Array.from(selectedTools),
        steps: steps.map((s) => s.trim()).filter(Boolean),
        output,
      });
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create power");
    } finally {
      setSaving(false);
    }
  }

  const accent = catAccent(category);
  const fieldCls = "w-full bg-gray-900/50 text-sm text-gray-200 rounded-xl px-4 py-3 ring-1 ring-gray-700/20 focus:ring-blue-500/25 outline-none placeholder-gray-600 transition-shadow";

  return (
    <div className="h-full overflow-y-auto" style={{ background: "linear-gradient(145deg, #020617 0%, #0a0f1e 35%, #06081a 65%, #020617 100%)" }}>
      <div className="max-w-2xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-lg font-semibold text-white">Create Power</h1>
            <p className="text-sm text-gray-600 mt-0.5">Define a reusable automated workflow</p>
          </div>
          <button onClick={() => navigate({ to: "/" })} className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2 mb-10">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <button
                onClick={() => i <= currentIdx && setCurrentStep(s)}
                className={`flex items-center gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  i <= currentIdx ? "text-white" : "text-gray-700"
                }`}
              >
                <span className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  i < currentIdx ? "bg-blue-600 text-white" : i === currentIdx ? "bg-gray-700 text-white" : "bg-gray-800/60 text-gray-600"
                }`}>
                  {i < currentIdx ? "✓" : i + 1}
                </span>
                <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
              </button>
              {i < STEPS.length - 1 && <div className={`flex-1 h-px ${i < currentIdx ? "bg-blue-600/40" : "bg-gray-800/40"}`} />}
            </div>
          ))}
        </div>

        {/* ── Step 1: Basics ── */}
        {currentStep === "basics" && (
          <div className="space-y-5">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Security Audit" className={fieldCls} autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this power do?" rows={3} className={fieldCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">Category</label>
              <div className="flex gap-2 flex-wrap">
                {CATEGORY_OPTIONS.map((c) => {
                  const a = catAccent(c.value);
                  const selected = category === c.value;
                  return (
                    <button
                      key={c.value}
                      onClick={() => setCategory(c.value)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                        selected ? "ring-1 text-white" : "text-gray-500 hover:text-gray-300"
                      }`}
                      style={{
                        background: selected ? `${a}12` : "rgba(15,23,42,0.3)",
                        borderColor: selected ? `${a}30` : "transparent",
                        ...(selected ? { boxShadow: `0 0 12px ${a}10` } : {}),
                      }}
                    >
                      <CategoryIcon category={c.value} size={14} />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Skills & Integrations ── */}
        {currentStep === "capabilities" && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <input
                value={capSearch}
                onChange={(e) => setCapSearch(e.target.value)}
                placeholder="Search capabilities..."
                className={`${fieldCls} flex-1`}
              />
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => setBranchFilter(null)}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
                    !branchFilter ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-300"
                  }`}
                >
                  All
                </button>
                {branches.map((b) => (
                  <button
                    key={b}
                    onClick={() => setBranchFilter(branchFilter === b ? null : b)}
                    className={`px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
                      branchFilter === b ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-300"
                    }`}
                  >
                    {BRANCH_LABELS[b] || b}
                  </button>
                ))}
              </div>
            </div>

            {loadingNodes ? (
              <div className="text-center py-12 text-xs text-gray-600">Loading capabilities...</div>
            ) : (
              <>
                {/* Integrations */}
                {grouped.integrations.length > 0 && (
                  <CapSection
                    title="Integrations"
                    subtitle="External services this power depends on"
                    nodes={grouped.integrations}
                    selected={selectedIntegrations}
                    onToggle={(id) => toggleSet(selectedIntegrations, setSelectedIntegrations, id)}
                    accentColor="#10b981"
                  />
                )}

                {/* Skills */}
                {grouped.skills.length > 0 && (
                  <CapSection
                    title="Skills"
                    subtitle="Higher-level workflows the agent can use"
                    nodes={grouped.skills}
                    selected={selectedSkills}
                    onToggle={(id) => toggleSet(selectedSkills, setSelectedSkills, id)}
                    accentColor="#8b5cf6"
                  />
                )}

                {/* Tools */}
                {grouped.tools.length > 0 && (
                  <CapSection
                    title="Tools"
                    subtitle="Built-in agent capabilities"
                    nodes={grouped.tools}
                    selected={selectedTools}
                    onToggle={(id) => toggleSet(selectedTools, setSelectedTools, id)}
                    accentColor="#3b82f6"
                  />
                )}

                {grouped.integrations.length === 0 && grouped.skills.length === 0 && grouped.tools.length === 0 && (
                  <div className="text-center py-12 text-xs text-gray-600">No capabilities match your search</div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 3: Steps & Output ── */}
        {currentStep === "steps" && (
          <div className="space-y-8">
            {/* Steps editor */}
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-gray-300 mb-1">Execution Steps</h3>
                <p className="text-[10px] text-gray-600">Define the steps this power will execute in order.</p>
              </div>
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-3 group">
                  <span className="shrink-0 h-8 w-8 rounded-lg bg-gray-800/60 flex items-center justify-center text-xs font-semibold text-gray-500 mt-0.5">
                    {i + 1}
                  </span>
                  <textarea
                    value={step}
                    onChange={(e) => updateStep(i, e.target.value)}
                    placeholder={`Step ${i + 1}...`}
                    rows={2}
                    className={`${fieldCls} flex-1`}
                  />
                  <div className="flex flex-col gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="h-6 w-6 rounded flex items-center justify-center text-gray-700 hover:text-gray-400 disabled:opacity-30 transition-colors">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15" /></svg>
                    </button>
                    <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="h-6 w-6 rounded flex items-center justify-center text-gray-700 hover:text-gray-400 disabled:opacity-30 transition-colors">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>
                    {steps.length > 1 && (
                      <button onClick={() => removeStep(i)} className="h-6 w-6 rounded flex items-center justify-center text-gray-700 hover:text-red-400 transition-colors">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={addStep} className="flex items-center gap-2 text-xs text-gray-600 hover:text-gray-300 transition-colors py-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add step
              </button>
            </div>

            {/* Output type */}
            <div>
              <h3 className="text-xs font-semibold text-gray-300 mb-1">Expected Output</h3>
              <p className="text-[10px] text-gray-600 mb-3">What kind of result should this power produce?</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {OUTPUT_OPTIONS.map((o) => {
                  const selected = output === o.value;
                  return (
                    <button
                      key={o.value}
                      onClick={() => setOutput(o.value)}
                      className={`flex flex-col items-start gap-1.5 px-3.5 py-3 rounded-xl text-left transition-all ${
                        selected
                          ? "ring-1 ring-blue-500/30 bg-blue-500/8 text-white"
                          : "bg-gray-900/40 text-gray-500 hover:text-gray-300 hover:bg-gray-800/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <OutputIcon type={o.value} size={14} />
                        <span className="text-xs font-medium">{o.label}</span>
                      </div>
                      <span className="text-[10px] leading-relaxed opacity-70">{o.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 4: Review ── */}
        {currentStep === "review" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-gray-800/30 p-5" style={{ background: "rgba(15,23,42,0.4)" }}>
              <div className="flex items-start gap-4 mb-4">
                <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${accent}12`, border: `1px solid ${accent}25`, color: accent }}>
                  <CategoryIcon category={category} size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">{name}</h3>
                  <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: accent }}>{category}</span>
                </div>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed mb-5">{description}</p>

              {/* Integrations */}
              {selectedIntegrations.size > 0 && (
                <ReviewChips
                  label="Integrations"
                  items={Array.from(selectedIntegrations)}
                  nodes={skillTreeNodes}
                  color="#10b981"
                />
              )}

              {/* Skills */}
              {selectedSkills.size > 0 && (
                <ReviewChips
                  label="Skills"
                  items={Array.from(selectedSkills)}
                  nodes={skillTreeNodes}
                  color="#8b5cf6"
                />
              )}

              {/* Tools */}
              {selectedTools.size > 0 && (
                <ReviewChips
                  label="Tools"
                  items={Array.from(selectedTools)}
                  nodes={skillTreeNodes}
                  color="#3b82f6"
                />
              )}

              {/* Steps */}
              {steps.filter(Boolean).length > 0 && (
                <div className="mt-4">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Steps</p>
                  <div className="space-y-2">
                    {steps.filter(Boolean).map((s, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-[10px] text-gray-600 font-mono mt-0.5">{i + 1}.</span>
                        <p className="text-xs text-gray-400">{s}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Output */}
              <div className="mt-4">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Output</p>
                <div className="flex items-center gap-2">
                  <OutputIcon type={output} size={14} />
                  <span className="text-xs text-gray-300 font-medium capitalize">{output}</span>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3">
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-10 pt-6 border-t border-gray-800/20">
          <button
            onClick={() => currentIdx > 0 ? setCurrentStep(STEPS[currentIdx - 1]) : navigate({ to: "/" })}
            className="px-4 py-2.5 rounded-xl text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-gray-800/30 transition-colors"
          >
            {currentIdx > 0 ? "Back" : "Cancel"}
          </button>
          {currentStep === "review" ? (
            <button
              onClick={handleCreate}
              disabled={saving || !name.trim() || !description.trim()}
              className="px-6 py-2.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Creating..." : "Create Power"}
            </button>
          ) : (
            <button
              onClick={() => setCurrentStep(STEPS[currentIdx + 1])}
              disabled={!canNext}
              className="px-6 py-2.5 rounded-xl text-xs font-semibold bg-gray-800/60 hover:bg-gray-700/60 text-white ring-1 ring-gray-700/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Capability Section ── */

function CapSection({
  title,
  subtitle,
  nodes,
  selected,
  onToggle,
  accentColor,
}: {
  title: string;
  subtitle: string;
  nodes: SkillTreeDbNode[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  accentColor: string;
}) {
  return (
    <div>
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-gray-300">{title}</h3>
        <p className="text-[10px] text-gray-600">{subtitle}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {nodes.map((n) => {
          const isSelected = selected.has(n.id);
          const isLocked = n.status === "locked";
          return (
            <button
              key={n.id}
              onClick={() => onToggle(n.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                isSelected
                  ? "ring-1 text-white"
                  : isLocked
                    ? "text-gray-600 opacity-60"
                    : "text-gray-400 hover:text-gray-200"
              }`}
              style={{
                background: isSelected ? `${accentColor}12` : "rgba(15,23,42,0.4)",
                ...(isSelected ? { borderColor: `${accentColor}30`, boxShadow: `0 0 10px ${accentColor}08`, "--tw-ring-color": `${accentColor}30` } as React.CSSProperties : {}),
              }}
              title={n.description}
            >
              {isSelected ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : isLocked ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              ) : (
                <span className="h-3 w-3 rounded-full border border-gray-600" />
              )}
              {n.label}
              {isLocked && <span className="text-[9px] text-gray-700 ml-1">locked</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Review Chips ── */

function ReviewChips({
  label,
  items,
  nodes,
  color,
}: {
  label: string;
  items: string[];
  nodes: SkillTreeDbNode[];
  color: string;
}) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="mt-4">
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((id) => {
          const node = nodeMap.get(id);
          return (
            <span
              key={id}
              className="text-[10px] px-2 py-0.5 rounded-md font-medium ring-1"
              style={{
                background: `${color}08`,
                color: `${color}cc`,
                "--tw-ring-color": `${color}20`,
              } as React.CSSProperties}
            >
              {node?.label || id}
            </span>
          );
        })}
      </div>
    </div>
  );
}
