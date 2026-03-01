import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { ChatMessage, ChatSession } from "../../hooks/useChat";
import MarkdownContent from "./MarkdownContent";
import ToolCallIndicator, { friendlyLabel } from "./ToolCallIndicator";
import ThinkingIndicator from "./ThinkingIndicator";

const AVATAR_STYLE: React.CSSProperties = {
  background: "radial-gradient(circle, rgba(59,130,246,0.15) 0%, rgba(30,64,175,0.06) 100%)",
  border: "1px solid rgba(59,130,246,0.12)",
};
const USER_BUBBLE_STYLE: React.CSSProperties = {
  background: "linear-gradient(135deg, #2563eb 0%, #1e40af 100%)",
  boxShadow: "0 2px 16px rgba(37,99,235,0.12)",
};
const ASSISTANT_BUBBLE_STYLE: React.CSSProperties = {
  background: "linear-gradient(135deg, rgba(30,41,59,0.7) 0%, rgba(30,41,59,0.5) 100%)",
  border: "1px solid rgba(71,85,105,0.12)",
};

interface Props {
  sessions: ChatSession[];
  activeSessionId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  initialOpen?: boolean;
  onSend: (text: string) => void;
  onAbort?: () => void;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onSaveAsPower?: () => void;
  savingPower?: boolean;
}

type DockState = "collapsed" | "expanded" | "maximized";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function ChatDock({
  sessions, activeSessionId, messages, isStreaming,
  initialOpen,
  onSend, onAbort, onNewSession, onSwitchSession, onDeleteSession,
  onSaveAsPower, savingPower,
}: Props) {
  const [state, setState] = useState<DockState>(initialOpen ? "expanded" : "collapsed");
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [sessionDropdown, setSessionDropdown] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  const isOpen = state !== "collapsed";
  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? "New Chat";

  const statusLabel = useMemo(() => {
    if (!isStreaming) return null;
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.streaming);
    if (!last) return "Working...";
    const toolCalls = (last as { toolCalls?: Array<{ status: string; toolName: string }> }).toolCalls;
    const runningTool = toolCalls ? [...toolCalls].reverse().find((tc) => tc.status === "running") : undefined;
    if (runningTool) return friendlyLabel(runningTool.toolName) + "...";
    if ((last as { thinking?: boolean }).thinking) return "Reasoning...";
    if (last.content) return "Composing...";
    return "Working...";
  }, [isStreaming, messages]);

  const scrollRafRef = useRef(0);
  useEffect(() => {
    if (!isOpen) return;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [messages.length, isOpen]);

  useEffect(() => {
    if (messages.length > 0 && state === "collapsed") {
      setState("expanded");
    }
  }, [messages.length]);

  useEffect(() => {
    if (initialOpen && state === "collapsed") setState("expanded");
  }, [initialOpen]);

  const [pendingQueue, setPendingQueue] = useState<string | null>(null);

  useEffect(() => {
    if (!isStreaming && pendingQueue) {
      onSend(pendingQueue);
      setPendingQueue(null);
    }
  }, [isStreaming, pendingQueue, onSend]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (isStreaming) {
      setPendingQueue(trimmed);
      setInput("");
      return;
    }
    onSend(trimmed);
    setInput("");
    if (state === "collapsed") setState("expanded");
  }, [input, isStreaming, onSend, state]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        setState("collapsed");
        inputRef.current?.blur();
        return;
      }
      if (e.key === "/" && !isOpen && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const expandedHeight = state === "maximized" ? "calc(100vh - 64px)" : state === "expanded" ? "50vh" : "0px";

  return (
    <div ref={dockRef} className="fixed inset-x-0 bottom-0 z-40 flex flex-col pointer-events-none" style={{ maxHeight: "100vh" }}>
      {/* Chat thread (expanded/maximized) */}
      {isOpen && (
        <div
          className="pointer-events-auto flex flex-col border-t border-gray-800/30 transition-[height] duration-300 ease-out overflow-hidden"
          style={{ height: expandedHeight, background: "linear-gradient(180deg, #0a0f1e 0%, #020617 100%)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-2.5 shrink-0 border-b border-gray-800/20">
            <div className="flex items-center gap-3">
              <div className="relative">
                <button
                  onClick={() => setSessionDropdown((o) => !o)}
                  className="flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white transition-colors"
                >
                  {activeTitle}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {sessionDropdown && (
                  <div className="absolute top-full left-0 mt-1 w-56 bg-gray-900 border border-gray-700/40 rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-50">
                    <div className="p-1.5">
                      <button
                        onClick={() => { onNewSession(); setSessionDropdown(false); }}
                        className="w-full text-left px-3 py-2 text-xs text-blue-400 hover:bg-gray-800/50 rounded-lg transition-colors font-medium"
                      >
                        + New Chat
                      </button>
                    </div>
                    <div className="h-px bg-gray-800/40" />
                    <div className="max-h-48 overflow-y-auto p-1.5 scrollbar-thin">
                      {sessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => { onSwitchSession(s.id); setSessionDropdown(false); }}
                          className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center justify-between ${
                            s.id === activeSessionId ? "bg-blue-500/10 text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"
                          }`}
                        >
                          <span className="truncate flex-1">{s.title}</span>
                          <span className="text-[11px] text-gray-500 shrink-0 ml-2">{timeAgo(s.createdAt)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {statusLabel && <span className="text-xs text-blue-400/70 animate-pulse">{statusLabel}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              {onSaveAsPower && messages.length >= 2 && (
                <button
                  onClick={onSaveAsPower}
                  disabled={isStreaming || savingPower}
                  className="h-7 rounded-lg px-2.5 flex items-center gap-1.5 text-xs font-medium text-purple-400/80 hover:text-purple-300 hover:bg-purple-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Save this conversation as a reusable Power"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  {savingPower ? "Saving..." : "Save as Power"}
                </button>
              )}
              <button
                onClick={() => setState(state === "maximized" ? "expanded" : "maximized")}
                className="h-7 rounded-lg px-2.5 flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-800/40 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  {state === "maximized" ? (
                    <>
                      <polyline points="4 14 10 14 10 20" />
                      <polyline points="20 10 14 10 14 4" />
                      <line x1="14" y1="10" x2="21" y2="3" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </>
                  ) : (
                    <>
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </>
                  )}
                </svg>
                {state === "maximized" ? "Shrink" : "Full screen"}
              </button>
              <button
                onClick={() => setState("collapsed")}
                className="h-7 rounded-lg px-2.5 flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-800/40 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                Minimize
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-gray-600">Start a conversation...</p>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto w-full px-6 py-6 space-y-5">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <div
                        className="h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-1"
                        style={AVATAR_STYLE}
                      >
                        <span className="text-[8px] font-bold text-blue-400/80">K</span>
                      </div>
                    )}

                    {msg.role === "user" ? (
                      <div
                        className="max-w-[75%] rounded-2xl rounded-br-sm px-4 py-2.5"
                        style={USER_BUBBLE_STYLE}
                      >
                        <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    ) : (
                      <div
                        className="max-w-[75%] rounded-2xl rounded-tl-sm px-4 py-3"
                        style={ASSISTANT_BUBBLE_STYLE}
                      >
                        {msg.thinking && !msg.content && !(msg.toolCalls?.length) && (
                          <ThinkingIndicator startedAt={msg.timestamp} />
                        )}

                        {(msg.toolCalls?.length ?? 0) > 0 && (
                          <div className="space-y-1 mb-2">
                            {msg.toolCalls!.map((tc) => (
                              <ToolCallIndicator key={tc.id} entry={tc} />
                            ))}
                          </div>
                        )}

                        {msg.content && (
                          <MarkdownContent content={msg.content} />
                        )}

                        {msg.streaming && msg.content && (
                          <span className="inline-block w-[3px] h-3.5 bg-blue-400/60 animate-pulse rounded-full ml-0.5 align-text-bottom" />
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input bar (always visible) */}
      <div
        className="pointer-events-auto shrink-0 border-t border-gray-800/30 px-4 py-3"
        style={{ background: "rgba(10,15,30,0.97)" }}
      >
        <div className="max-w-3xl mx-auto">
          <div
            className={`flex items-end gap-2 rounded-2xl px-4 py-2.5 transition-shadow duration-300 ${
              inputFocused ? "ring-1 ring-blue-500/25 shadow-[0_0_30px_rgba(59,130,246,0.06)]" : "ring-1 ring-gray-700/30"
            }`}
            style={{ background: "rgba(15,23,42,0.7)" }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={pendingQueue ? "Queued — will send when done..." : isStreaming ? "Type to queue next message..." : "Message KAI..."}
              rows={1}
              className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none resize-none py-1 leading-relaxed"
              style={{ maxHeight: "120px", caretColor: "#3b82f6" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
              }}
            />
            {isStreaming && onAbort ? (
              <button
                onClick={onAbort}
                className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 bg-red-600/80 hover:bg-red-500 text-white shadow-lg shadow-red-600/20"
                title="Stop generating"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!input.trim() || !!pendingQueue}
                className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 ${
                  input.trim() && !pendingQueue
                    ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20"
                    : "bg-transparent text-gray-700 scale-95"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" />
                  <path d="M12 5l7 7-7 7" />
                </svg>
              </button>
            )}
            {!isOpen && (
              <button
                onClick={() => setState("expanded")}
                className="shrink-0 h-8 rounded-lg px-3 flex items-center gap-1.5 bg-blue-600/10 text-blue-400 hover:bg-blue-600/20 ring-1 ring-blue-500/20 transition-colors text-xs font-medium ml-1"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="6 15 12 9 18 15" />
                </svg>
                Open Chat
              </button>
            )}
          </div>
          {!isOpen && (
            <div className="flex items-center justify-center mt-1.5">
              <span className="text-[11px] text-gray-600">
                Press <kbd className="px-1 py-0.5 rounded bg-gray-800/50 text-gray-500 font-mono text-[10px]">/</kbd> to focus
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
