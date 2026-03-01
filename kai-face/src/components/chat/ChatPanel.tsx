import { useState, useRef, useEffect, memo, useCallback } from "react";
import type { ChatMessage, ChatSession } from "../../hooks/useChat";
import { usePowers, useCommunityPowers, type PowerInfo, type CommunityPowerInfo } from "../../hooks/usePowers";
import MarkdownContent from "./MarkdownContent";
import SecretInput from "../ui/SecretInput";

interface Props {
  sessions: ChatSession[];
  activeSessionId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (text: string) => void;
  onExecutePower?: (powerId: string, powerName: string) => void;
  onClose: () => void;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const CAT_ACCENT: Record<string, string> = {
  security: "#ef4444",
  quality: "#f59e0b",
  ops: "#10b981",
  analysis: "#8b5cf6",
  general: "#3b82f6",
};

function catAccent(c: string) { return CAT_ACCENT[c] || CAT_ACCENT.general; }

function CategoryIcon({ category, size = 16 }: { category: string; size?: number }) {
  const cls = "shrink-0";
  switch (category) {
    case "security": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
    case "quality": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
      </svg>
    );
    case "ops": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
    case "analysis": return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    );
    default: return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    );
  }
}

function DepChip({ name, met }: { name: string; met: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-medium ${
      met ? "bg-emerald-500/8 text-emerald-400/90 ring-1 ring-emerald-500/15" : "bg-amber-500/8 text-amber-500/80 ring-1 ring-amber-500/15"
    }`}>
      {met ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
      )}
      {name}
    </span>
  );
}

// ── Large power tile for the empty-chat landing ─────────────
const PowerTile = memo(function PowerTile({ power, onExecute }: { power: PowerInfo; onExecute: (p: PowerInfo) => void }) {
  const accent = catAccent(power.category);
  const disabled = !power.available;

  return (
    <button
      onClick={() => !disabled && onExecute(power)}
      disabled={disabled}
      className={`group w-full text-left rounded-2xl p-5 transition-all duration-300 ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:translate-y-[-2px]"
      }`}
      style={{
        background: "rgba(15,23,42,0.5)",
        border: `1px solid rgba(71,85,105,0.15)`,
        boxShadow: disabled ? "none" : `0 0 0 0 transparent`,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.borderColor = `${accent}40`;
          e.currentTarget.style.boxShadow = `0 4px 30px ${accent}10, 0 0 0 1px ${accent}15`;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(71,85,105,0.15)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
          style={{ background: `${accent}12`, border: `1px solid ${accent}20`, color: accent }}>
          <CategoryIcon category={power.category} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-200 group-hover:text-white transition-colors">
              {power.name}
            </h3>
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50" style={{ color: accent }}>
              {power.category}
            </span>
            {!disabled && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="ml-auto text-gray-700 group-hover:text-gray-400 transition-colors shrink-0">
                <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
              </svg>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed line-clamp-2">
            {power.description}
          </p>
          {power.dependsOn.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {power.dependsOn.map((dep) => (
                <DepChip key={dep} name={dep} met={!power.missingIntegrations.includes(dep)} />
              ))}
            </div>
          )}
          {power.steps.length > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-[10px] text-gray-600">
              <span>{power.steps.length} steps</span>
              <span className="text-gray-700">/</span>
              <span className="truncate">{power.steps[0]}</span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
});

// ── Sidebar power row ───────────────────────────────────────
const SidebarPowerRow = memo(function SidebarPowerRow({ power, onExecute }: { power: PowerInfo; onExecute: (p: PowerInfo) => void }) {
  const accent = catAccent(power.category);
  const disabled = !power.available;

  return (
    <button
      onClick={() => !disabled && onExecute(power)}
      disabled={disabled}
      className={`group w-full text-left px-3 py-3 rounded-xl transition-colors duration-200 ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:bg-gray-800/40"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${accent}10`, border: `1px solid ${accent}18`, color: accent }}>
          <CategoryIcon category={power.category} size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-gray-300 group-hover:text-white transition-colors truncate">
            {power.name}
          </p>
          <p className="text-[10px] text-gray-600 truncate mt-0.5">{power.description}</p>
        </div>
        {disabled && power.missingIntegrations.length > 0 && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-500/50 shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )}
        {!disabled && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-gray-700 group-hover:text-gray-400 transition-colors shrink-0">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        )}
      </div>
    </button>
  );
});

// ── Community row ───────────────────────────────────────────
const CommunityRow = memo(function CommunityRow({ power, onInstall, installing }: { power: CommunityPowerInfo; onInstall: (id: string) => void; installing: string | null }) {
  const accent = catAccent(power.category);
  const busy = installing === power.id;

  return (
    <div className="px-3 py-3 rounded-xl hover:bg-gray-800/30 transition-colors">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${accent}10`, border: `1px solid ${accent}18`, color: accent }}>
          <CategoryIcon category={power.category} size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-gray-300 truncate">{power.name}</p>
          <p className="text-[10px] text-gray-600 truncate mt-0.5">{power.description}</p>
          {power.dependsOn.length > 0 && (
            <p className="text-[9px] text-gray-700 mt-1">Requires: {power.dependsOn.join(", ")}</p>
          )}
        </div>
        {power.installed ? (
          <span className="text-[9px] text-emerald-500/70 font-medium shrink-0">Added</span>
        ) : (
          <button onClick={() => onInstall(power.id)} disabled={busy}
            className="text-[9px] px-2.5 py-1 rounded-md bg-gray-800/60 text-gray-400 hover:text-white hover:bg-gray-700/60 ring-1 ring-gray-700/40 transition-colors shrink-0 font-medium disabled:opacity-50">
            {busy ? "..." : "Add"}
          </button>
        )}
      </div>
    </div>
  );
});

// ── Create Power Form ───────────────────────────────────────
function CreatePowerForm({ onSubmit, onCancel }: {
  onSubmit: (data: { name: string; description: string; icon: string; category: string; dependsOn: string[]; steps: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [deps, setDeps] = useState("");
  const [steps, setSteps] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      icon: "",
      category,
      dependsOn: deps.split(",").map((s) => s.trim()).filter(Boolean),
      steps: steps.split("\n").map((s) => s.trim()).filter(Boolean),
    });
  }

  const fieldCls = "w-full bg-gray-900/50 text-xs text-gray-200 rounded-lg px-3 py-2.5 ring-1 ring-gray-700/30 focus:ring-blue-500/30 outline-none placeholder-gray-600 transition-shadow";

  return (
    <form onSubmit={handleSubmit} className="px-3 py-4 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400">New Power</span>
        <button type="button" onClick={onCancel} className="text-gray-600 hover:text-gray-300 transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Power name" className={fieldCls} autoFocus />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this power do?" rows={2} className={fieldCls} />

      <select value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
        <option value="general">General</option>
        <option value="security">Security</option>
        <option value="quality">Quality</option>
        <option value="ops">Ops</option>
        <option value="analysis">Analysis</option>
      </select>

      <input value={deps} onChange={(e) => setDeps(e.target.value)} placeholder="Depends on: github, slack" className={fieldCls} />
      <textarea value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"Steps (one per line)"} rows={3} className={fieldCls} />

      <button type="submit" disabled={!name.trim() || !description.trim()}
        className="w-full h-9 rounded-lg text-xs font-semibold text-gray-300 bg-gray-800/50 hover:bg-gray-700/60 ring-1 ring-gray-700/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
        Create
      </button>
    </form>
  );
}

const CREDENTIAL_REQUEST_RE = /\[CREDENTIAL_REQUEST:([^\]]+)\]/g;

function AssistantContent({ content, onSend }: { content: string; onSend: (text: string) => void }) {
  const parts = content.split(CREDENTIAL_REQUEST_RE);
  if (parts.length <= 1) {
    return <MarkdownContent content={content} />;
  }
  const elements: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = parts[i].replace(/\s*A secure input form has been shown to the user\.[^\n]*/g, "").trim();
      if (text) elements.push(<MarkdownContent key={i} content={text} />);
    } else {
      const credKey = parts[i].trim();
      elements.push(
        <div key={`cred-${i}`} className="my-3">
          <SecretInput
            credentialKey={credKey}
            onSaved={(key) => onSend(`I've saved my ${key.toUpperCase()} credential.`)}
          />
        </div>
      );
    }
  }
  return <>{elements}</>;
}

// ── Main ────────────────────────────────────────────────────
export default function ChatPanel({
  sessions, activeSessionId, messages, isStreaming,
  onSend, onExecutePower, onClose, onNewSession, onSwitchSession, onDeleteSession,
}: Props) {
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"powers" | "community" | "chats">("powers");
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { powers, loading: powersLoading, createPower, installPower } = usePowers();
  const { powers: communityPowers, loading: communityLoading, refetch: refetchCommunity } = useCommunityPowers();

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, [activeSessionId]);

  function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setInput("");
  }

  const handleExecutePower = useCallback((power: PowerInfo) => {
    if (onExecutePower) {
      onExecutePower(power.id, power.name);
    } else {
      onSend(`Run the "${power.name}" power: ${power.description}`);
    }
  }, [onSend, onExecutePower]);

  const handleCreatePower = useCallback(async (data: { name: string; description: string; icon: string; category: string; dependsOn: string[]; steps: string[] }) => {
    try { await createPower(data); setCreating(false); } catch (err) { console.error("Failed to create power:", err); }
  }, [createPower]);

  const handleInstall = useCallback(async (powerId: string) => {
    setInstalling(powerId);
    try { await installPower(powerId); refetchCommunity(); } catch (err) { console.error("Failed to install:", err); } finally { setInstalling(null); }
  }, [installPower, refetchCommunity]);

  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? "Chat";
  const showLandingPowers = messages.length === 0 && powers.length > 0;

  return (
    <div className="flex h-full w-full" style={{ background: "linear-gradient(180deg, #0a0f1e 0%, #020617 50%, #06081a 100%)" }}>

      {/* Left sidebar */}
      <div className="h-full w-[260px] shrink-0 flex flex-col bg-gray-950/60 border-r border-gray-800/30">

        {/* Tab bar */}
        <div className="flex items-center px-2 pt-3 pb-2 shrink-0 gap-px">
          {([
            { id: "powers" as const, label: "Powers" },
            { id: "community" as const, label: "Browse" },
            { id: "chats" as const, label: "Chats" },
          ]).map((t) => (
            <button key={t.id} onClick={() => setSidebarTab(t.id)}
              className={`flex-1 py-1.5 text-[10px] font-semibold rounded-md transition-colors ${
                sidebarTab === t.id ? "text-white bg-gray-800/50" : "text-gray-600 hover:text-gray-400"
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="h-px bg-gray-800/30 mx-3" />

        {/* Powers */}
        {sidebarTab === "powers" && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {creating ? (
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                <CreatePowerForm onSubmit={handleCreatePower} onCancel={() => setCreating(false)} />
              </div>
            ) : (
              <>
                <div className="px-3 py-2 shrink-0">
                  <button onClick={() => setCreating(true)}
                    className="w-full h-8 rounded-lg flex items-center justify-center gap-2 text-gray-500 hover:text-gray-300 bg-gray-800/30 hover:bg-gray-800/50 ring-1 ring-gray-800/40 transition-colors text-[10px] font-medium">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New Power
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto pb-3 space-y-0.5 scrollbar-thin">
                  {powersLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
                    </div>
                  ) : powers.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                      <p className="text-[11px] text-gray-600 mb-2">No powers yet</p>
                      <button onClick={() => setSidebarTab("community")} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                        Browse community
                      </button>
                    </div>
                  ) : (
                    powers.map((p) => <SidebarPowerRow key={p.id} power={p} onExecute={handleExecutePower} />)
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Community */}
        {sidebarTab === "community" && (
          <div className="flex-1 overflow-y-auto pb-3 space-y-0.5 scrollbar-thin">
            {communityLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-700 border-t-gray-500 animate-spin" />
              </div>
            ) : (
              communityPowers.map((p) => <CommunityRow key={p.id} power={p} onInstall={handleInstall} installing={installing} />)
            )}
          </div>
        )}

        {/* Chats */}
        {sidebarTab === "chats" && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-2 shrink-0">
              <button onClick={onNewSession}
                className="w-full h-8 rounded-lg flex items-center justify-center gap-2 text-blue-400 bg-blue-600/10 hover:bg-blue-600/15 ring-1 ring-blue-500/20 transition-colors text-[10px] font-semibold">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 scrollbar-thin">
              {sessions.map((s) => {
                const active = s.id === activeSessionId;
                return (
                  <div key={s.id}
                    className={`group relative flex items-start gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                      active ? "bg-blue-500/8 ring-1 ring-blue-500/15" : "hover:bg-gray-800/40"
                    }`}
                    onClick={() => onSwitchSession(s.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className={`text-[11px] truncate ${active ? "text-white font-medium" : "text-gray-400"}`}>{s.title}</p>
                      <p className="text-[10px] text-gray-700 mt-0.5">{s.messages.length} msg · {timeAgo(s.createdAt)}</p>
                    </div>
                    {sessions.length > 1 && (
                      <button onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}
                        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 h-5 w-5 rounded flex items-center justify-center text-gray-700 hover:text-red-400 transition-[opacity,color] duration-200">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 shrink-0 border-b border-gray-800/20">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-gray-300 truncate">{activeTitle}</h2>
            {isStreaming && <span className="text-xs text-blue-400/60 animate-pulse">thinking...</span>}
          </div>
          <button onClick={onClose} title="Back to skill map"
            className="h-8 rounded-lg px-3 flex items-center gap-2 text-gray-500 hover:text-white bg-gray-800/30 hover:bg-gray-800/50 ring-1 ring-gray-800/40 transition-colors text-xs font-medium">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            Skill Map
          </button>
        </div>

        {/* Messages / Landing */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="max-w-2xl mx-auto w-full px-6 py-10">
              <div className="mb-10 text-center">
                <h1 className="text-xl font-semibold text-white mb-1.5">What can I help with?</h1>
                <p className="text-sm text-gray-600">Ask anything, or run a power below.</p>
              </div>

              {showLandingPowers && (
                <div className="space-y-3">
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest px-1">Powers</p>
                  {powers.map((p) => <PowerTile key={p.id} power={p} onExecute={handleExecutePower} />)}
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-6">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  {msg.role === "assistant" && (
                    <div className="h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-1"
                      style={{ background: "radial-gradient(circle, rgba(59,130,246,0.15) 0%, rgba(30,64,175,0.06) 100%)", border: "1px solid rgba(59,130,246,0.12)" }}>
                      <span className="text-[8px] font-bold text-blue-400/80">K</span>
                    </div>
                  )}
                  <div className={`max-w-[75%] ${msg.role === "user" ? "rounded-2xl rounded-br-sm px-4 py-2.5" : "rounded-2xl rounded-tl-sm px-4 py-3"}`}
                    style={msg.role === "user" ? {
                      background: "linear-gradient(135deg, #2563eb 0%, #1e40af 100%)",
                      boxShadow: "0 2px 16px rgba(37,99,235,0.12)",
                    } : {
                      background: "linear-gradient(135deg, rgba(30,41,59,0.7) 0%, rgba(30,41,59,0.5) 100%)",
                      border: "1px solid rgba(71,85,105,0.12)",
                    }}>
                    {msg.streaming && !msg.content ? (
                      <div className="flex items-center gap-1.5 py-1.5 px-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-blue-400/50 animate-bounce" style={{ animationDelay: "0ms", animationDuration: "1.2s" }} />
                        <div className="h-1.5 w-1.5 rounded-full bg-blue-400/50 animate-bounce" style={{ animationDelay: "200ms", animationDuration: "1.2s" }} />
                        <div className="h-1.5 w-1.5 rounded-full bg-blue-400/50 animate-bounce" style={{ animationDelay: "400ms", animationDuration: "1.2s" }} />
                      </div>
                    ) : msg.role === "assistant" ? (
                      <AssistantContent content={msg.content} onSend={onSend} />
                    ) : (
                      <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                    )}
                    {msg.streaming && msg.content && (
                      <span className="inline-block w-[3px] h-3.5 bg-blue-400/60 animate-pulse rounded-full ml-0.5 align-text-bottom" />
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-4 pb-6 pt-2 shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className={`flex items-end gap-2 rounded-2xl px-4 py-3 transition-shadow duration-300 ${
              inputFocused ? "ring-1 ring-blue-500/20 shadow-[0_0_30px_rgba(59,130,246,0.04)]" : "ring-1 ring-gray-800/40"
            }`} style={{ background: "rgba(15,23,42,0.85)" }}>
              <textarea ref={inputRef} value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
                placeholder={isStreaming ? "KAI is thinking..." : "Message KAI..."}
                disabled={isStreaming} rows={1}
                className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none resize-none py-1.5 leading-relaxed disabled:opacity-40"
                style={{ maxHeight: "160px", caretColor: "#3b82f6" }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
              />
              <button onClick={handleSubmit} disabled={isStreaming || !input.trim()}
                className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 ${
                  input.trim() && !isStreaming ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20" : "bg-transparent text-gray-700 scale-95"
                }`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
