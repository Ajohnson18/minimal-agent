import { useState, useEffect, useRef, useCallback } from "react";
import { subscribe, rpc, ensureConnected } from "../../lib/gateway";
import type { GatewayEvent } from "../../lib/gateway";

interface Props {
  sessionKey: string;
  title?: string;
  onComplete?: () => void;
  onError?: (err: string) => void;
}

type Status = "running" | "done" | "error";

function extractTextFromRichMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { content?: unknown[] };
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((block): block is { type: string; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
    )
    .map((block) => block.text)
    .join("");
}

export default function AgentConsole({ sessionKey, title = "Running...", onComplete, onError }: Props) {
  const [chunks, setChunks] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [fading, setFading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    ensureConnected();

    rpc("subscribe", {
      events: ["chat", "agent"],
      sessionKey,
    }).catch(console.error);

    const unsub = subscribe((evt: GatewayEvent) => {
      if (!activeRef.current) return;

      if (evt.event === "chat") {
        const state = evt.payload.state as string;
        if (state === "delta") {
          const text = extractTextFromRichMessage(evt.payload.message);
          if (text) setChunks((prev) => [...prev, text]);
        }
        if (state === "final") {
          setStatus("done");
          setTimeout(() => setFading(true), 5000);
          setTimeout(() => { setDismissed(true); onComplete?.(); }, 6000);
          unsub();
        }
        if (state === "error") {
          setStatus("error");
          onError?.(String(evt.payload.errorMessage ?? "Unknown error"));
          unsub();
        }
      }
    });

    return () => {
      activeRef.current = false;
      unsub();
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!collapsed) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chunks, collapsed]);

  const dismiss = useCallback(() => {
    setFading(true);
    setTimeout(() => { setDismissed(true); onComplete?.(); }, 500);
  }, [onComplete]);

  if (dismissed) return null;

  const fullText = chunks.join("");

  return (
    <div
      className={`fixed bottom-4 right-4 w-80 rounded-xl border border-gray-700 bg-gray-900 shadow-2xl z-50 overflow-hidden transition-[opacity,transform] duration-500 ${
        fading ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          {status === "running" && <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />}
          {status === "done"    && <div className="h-2 w-2 rounded-full bg-green-400" />}
          {status === "error"   && <div className="h-2 w-2 rounded-full bg-red-400" />}
          <span className="text-xs font-medium text-gray-300">
            {status === "done" ? "Done" : status === "error" ? "Error" : title}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCollapsed((c) => !c)} className="text-gray-500 hover:text-gray-300 text-xs p-1">
            {collapsed ? "▲" : "▼"}
          </button>
          {status !== "running" && (
            <button onClick={dismiss} className="text-gray-500 hover:text-gray-300 text-xs p-1">×</button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="h-36 overflow-y-auto bg-gray-950 px-3 py-2">
          {fullText ? (
            <p className="text-[11px] text-gray-300 whitespace-pre-wrap leading-5 font-mono">{fullText}</p>
          ) : (
            <p className="text-[11px] text-gray-600 italic">
              {status === "running" ? "Waiting for agent..." : status === "done" ? "Completed." : "Failed."}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
