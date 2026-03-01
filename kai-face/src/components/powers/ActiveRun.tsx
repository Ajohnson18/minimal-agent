import { useState, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "../../hooks/useChat";
import ToolCallIndicator from "../chat/ToolCallIndicator";

interface Props {
  isStreaming: boolean;
  messages: ChatMessage[];
  activeTools: Set<string>;
  isPowerRun: boolean;
  onLingerDone: () => void;
}

export default function ActiveRun({ isStreaming, messages, activeTools, isPowerRun, onLingerDone }: Props) {
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i];
    return undefined;
  }, [messages]);
  const lastUser = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
    return undefined;
  }, [messages]);
  const [lingerState, setLingerState] = useState<"completed" | "error" | null>(null);
  const prevStreamingRef = useRef(false);

  const isActive = isPowerRun && (isStreaming || !!lastAssistant?.streaming);

  useEffect(() => {
    if (isActive) {
      prevStreamingRef.current = true;
      setLingerState(null);
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive && prevStreamingRef.current) {
      prevStreamingRef.current = false;
      const hasError = lastAssistant?.content?.startsWith("Error:") || lastAssistant?.content?.startsWith("Failed");
      setLingerState(hasError ? "error" : "completed");
      const timer = setTimeout(() => {
        setLingerState(null);
        onLingerDone();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [isActive]);

  if (!isActive && !lingerState) {
    return (
      <div>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Active Run</h2>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-700 mb-2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <p className="text-xs text-gray-600">No active runs</p>
        </div>
      </div>
    );
  }

  const toolCalls = lastAssistant?.toolCalls ?? [];
  const recentTools = toolCalls.slice(-5);
  const preview = lastAssistant?.content?.slice(-300) ?? "";
  const title = lastUser?.content?.slice(0, 60) ?? "Running...";
  const isThinking = lastAssistant?.thinking && !lastAssistant?.content && toolCalls.length === 0;

  const statusColor = lingerState === "error" ? "bg-red-400" : lingerState === "completed" ? "bg-emerald-400" : "bg-blue-400 animate-pulse";
  const statusText = lingerState === "error" ? "Error" : lingerState === "completed" ? "Completed" : "Running...";
  const borderColor = lingerState === "error" ? "border-red-500/15 bg-red-500/5" : lingerState === "completed" ? "border-emerald-500/15 bg-emerald-500/5" : "border-blue-500/15 bg-blue-500/5";

  return (
    <div>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Active Run</h2>
      <div className={`rounded-lg border ${borderColor} p-3.5`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-xs font-medium text-gray-300 truncate flex-1">{title}</span>
          <span className={`text-[11px] font-medium ${lingerState === "error" ? "text-red-400" : lingerState === "completed" ? "text-emerald-400" : "text-blue-400"}`}>
            {statusText}
          </span>
        </div>

        {isActive && isThinking && (
          <div className="flex items-center gap-2 py-1.5 mb-1">
            <div className="flex items-center gap-1">
              <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s" }} />
              <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s", animationDelay: "0.2s" }} />
              <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s", animationDelay: "0.4s" }} />
            </div>
            <span className="text-xs text-blue-400/60 font-medium">Reasoning</span>
          </div>
        )}

        {isActive && recentTools.length > 0 && (
          <div className="space-y-1 mb-2">
            {recentTools.map((tc) => (
              <ToolCallIndicator key={tc.id} entry={tc} />
            ))}
          </div>
        )}

        {preview && (
          <p className="text-xs text-gray-500 line-clamp-3 leading-relaxed">{preview}</p>
        )}
      </div>
    </div>
  );
}
