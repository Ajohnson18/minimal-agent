import { useState, useEffect, useCallback } from "react";
import type { PowerInfo } from "../../hooks/usePowers";
import { rpc } from "../../lib/gateway";
import { CategoryIcon, catAccent, DepChip, timeAgo } from "./shared";
import MarkdownContent from "../chat/MarkdownContent";

interface PowerVersion {
  id: string;
  prompt: string;
  changeNote: string;
  createdAt: number;
}

interface PowerDetail {
  prompt: string;
  locked: boolean;
  versions: PowerVersion[];
}

type Tab = "overview" | "document" | "history";

interface Props {
  power: PowerInfo;
  isPinned: boolean;
  onClose: () => void;
  onRun: (power: PowerInfo) => void;
  onPin: () => void;
  onUnpin: () => void;
  onEdit?: (power: PowerInfo, instructions: string) => void;
  onDelete?: (power: PowerInfo) => void;
}

export default function PowerDetailDrawer({ power, isPinned, onClose, onRun, onPin, onUnpin, onEdit, onDelete }: Props) {
  const accent = catAccent(power.category);
  const disabled = !power.available;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editInstructions, setEditInstructions] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<PowerDetail | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PowerVersion | null>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const resp = await rpc<{ power: PowerInfo & { prompt: string; locked: boolean }; versions: PowerVersion[] }>(
        "powers.getDetail",
        { powerId: power.id },
      );
      setDetail({ prompt: resp.power.prompt, locked: resp.power.locked, versions: resp.versions });
    } catch {}
  }, [power.id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleEdit = () => {
    if (editInstructions.trim() && onEdit) {
      onEdit(power, editInstructions.trim());
      setEditMode(false);
      setEditInstructions("");
      onClose();
    }
  };

  const handleDelete = () => {
    if (onDelete) {
      onDelete(power);
      onClose();
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "document", label: "Document" },
    ...(detail && detail.versions.length > 0 ? [{ id: "history" as Tab, label: `History (${detail.versions.length})` }] : []),
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="fixed top-0 right-0 bottom-0 z-50 w-[520px] max-w-[90vw] flex flex-col border-l border-gray-800/30"
        style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #020617 100%)" }}>

        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4 shrink-0">
          <div className="flex items-start gap-4">
            <div
              className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: `${accent}12`, border: `1px solid ${accent}25`, color: accent }}
            >
              <CategoryIcon category={power.category} size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">{power.name}</h2>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: accent }}>{power.category}</span>
                <span className="text-[11px] text-gray-600">·</span>
                <span className="text-[11px] text-gray-500 capitalize">{power.source}</span>
                {detail?.locked && (
                  <>
                    <span className="text-[11px] text-gray-600">·</span>
                    <span className="text-[10px] text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded font-medium">locked</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="h-7 w-7 rounded-lg flex items-center justify-center text-gray-600 hover:text-white hover:bg-gray-800/50 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pb-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setSelectedVersion(null); }}
              className={`text-xs font-medium px-3.5 py-1.5 rounded-lg transition-colors ${
                tab === t.id
                  ? "bg-white/[0.08] text-white"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="h-px bg-gray-800/30 mx-6" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 scrollbar-thin">
          {tab === "overview" && (
            <>
              <div>
                <p className="text-sm text-gray-400 leading-relaxed">{power.description}</p>
              </div>

              {power.dependsOn.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Dependencies</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {power.dependsOn.map((dep) => (
                      <DepChip key={dep} name={dep} met={!power.missingIntegrations.includes(dep)} />
                    ))}
                  </div>
                </div>
              )}

              {power.steps.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Steps</h3>
                  <div className="space-y-2.5">
                    {power.steps.map((step, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="shrink-0 h-5 w-5 rounded-full bg-gray-800/60 flex items-center justify-center text-[11px] font-semibold text-gray-500 mt-0.5">
                          {i + 1}
                        </span>
                        <p className="text-sm text-gray-400 leading-relaxed pt-0.5">{step}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {power.artifacts && power.artifacts.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Dashboard Artifacts</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {power.artifacts.map((a) => (
                      <span key={a.key} className="text-xs px-2.5 py-1 rounded-md bg-purple-500/8 text-purple-400/80 ring-1 ring-purple-500/15 font-medium">
                        {a.label} ({a.type})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {(power.skills.length > 0 || power.tools.length > 0) && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Capabilities</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {power.skills.map((s) => (
                      <span key={s} className="text-xs px-2.5 py-1 rounded-md bg-blue-500/8 text-blue-400/80 ring-1 ring-blue-500/15 font-medium">{s}</span>
                    ))}
                    {power.tools.map((t) => (
                      <span key={t} className="text-xs px-2.5 py-1 rounded-md bg-gray-500/8 text-gray-400/80 ring-1 ring-gray-500/15 font-medium">{t}</span>
                    ))}
                  </div>
                </div>
              )}

              {editMode && (
                <div className="border border-blue-500/20 rounded-lg p-3 bg-blue-500/5">
                  <h3 className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-2">Edit Instructions</h3>
                  <textarea
                    value={editInstructions}
                    onChange={(e) => setEditInstructions(e.target.value)}
                    placeholder='Describe the changes, e.g. "Also scan Docker images for vulnerabilities"'
                    className="w-full h-20 text-xs bg-gray-900/50 border border-gray-700/30 rounded-lg px-3 py-2 text-gray-300 placeholder:text-gray-700 focus:outline-none focus:border-blue-500/40 resize-none"
                  />
                  <div className="flex gap-2 mt-2">
                    <button onClick={handleEdit} disabled={!editInstructions.trim()} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      Send to KAI
                    </button>
                    <button onClick={() => { setEditMode(false); setEditInstructions(""); }} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-800/50 text-gray-400 hover:text-white transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "document" && (
            <div>
              {detail?.prompt ? (
                <div className="rounded-lg bg-gray-900/40 p-4 border border-white/[0.04] overflow-x-auto">
                  <MarkdownContent content={detail.prompt} />
                </div>
              ) : (
                <div className="flex items-center justify-center py-12">
                  <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
                </div>
              )}
            </div>
          )}

          {tab === "history" && detail && (
            <div className="space-y-3">
              {selectedVersion ? (
                <div>
                  <button
                    onClick={() => setSelectedVersion(null)}
                    className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300 mb-3 transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back to versions
                  </button>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-gray-500">{timeAgo(selectedVersion.createdAt)}</span>
                    {selectedVersion.changeNote && (
                      <>
                        <span className="text-xs text-gray-600">·</span>
                        <span className="text-xs text-gray-500">{selectedVersion.changeNote}</span>
                      </>
                    )}
                  </div>
                  <div className="rounded-lg bg-gray-900/40 p-4 border border-white/[0.04] overflow-x-auto">
                    <MarkdownContent content={selectedVersion.prompt} />
                  </div>
                </div>
              ) : (
                <>
                  {detail.versions.map((v, i) => (
                    <button
                      key={v.id}
                      onClick={() => setSelectedVersion(v)}
                      className="w-full text-left flex items-center gap-3 rounded-lg border border-white/[0.04] bg-white/[0.02] px-4 py-3 hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="shrink-0 h-7 w-7 rounded-full bg-gray-800/60 flex items-center justify-center">
                        <span className="text-[10px] font-semibold text-gray-500">v{detail.versions.length - i}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-300 font-medium">
                            {v.changeNote || "Version saved"}
                          </span>
                          {i === 0 && (
                            <span className="text-[10px] bg-blue-500/15 text-blue-400/80 px-1.5 py-0.5 rounded font-medium">latest</span>
                          )}
                        </div>
                        <span className="text-[11px] text-gray-500">{timeAgo(v.createdAt)}</span>
                      </div>
                      <div className="text-[11px] text-gray-600 shrink-0">
                        {(v.prompt.length / 1000).toFixed(1)}k chars
                      </div>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-700 shrink-0">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-gray-800/30 flex items-center gap-3">
          <button
              onClick={() => { onRun(power); onClose(); }}
            disabled={disabled}
            className={`flex-1 h-10 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
              disabled
                ? "bg-gray-800/40 text-gray-600 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Run
          </button>
          {onEdit && (
            <button
              onClick={() => { setTab("overview"); setEditMode(!editMode); }}
              className={`h-10 w-10 rounded-xl flex items-center justify-center transition-colors ${
                editMode
                  ? "bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20"
                  : "bg-gray-800/40 text-gray-600 hover:text-gray-300 ring-1 ring-gray-700/20"
              }`}
              title="Edit power via chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          <button
            onClick={isPinned ? onUnpin : onPin}
            className={`h-10 w-10 rounded-xl flex items-center justify-center transition-colors ${
              isPinned
                ? "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
                : "bg-gray-800/40 text-gray-600 hover:text-gray-300 ring-1 ring-gray-700/20"
            }`}
            title={isPinned ? "Unpin" : "Pin"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          {onDelete && (
            <button
              onClick={() => { if (confirmDelete) handleDelete(); else setConfirmDelete(true); }}
              onBlur={() => setConfirmDelete(false)}
              className={`h-10 w-10 rounded-xl flex items-center justify-center transition-colors ${
                confirmDelete
                  ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/30"
                  : "bg-gray-800/40 text-gray-600 hover:text-red-400 ring-1 ring-gray-700/20"
              }`}
              title={confirmDelete ? "Confirm delete" : "Delete"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </>
  );
}
