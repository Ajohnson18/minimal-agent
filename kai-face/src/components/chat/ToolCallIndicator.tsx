import { useEffect, useRef } from "react";
import type { ToolCallEntry } from "../../hooks/useChat";

const TOOL_LABELS: Record<string, string> = {
  web_search: "Searching the web",
  web_fetch: "Reading page",
  browser: "Browsing",
  exec: "Running command",
  read: "Reading file",
  write: "Writing file",
  python: "Running Python",
  sql: "Querying database",
  memory: "Checking memory",
  slack_message: "Sending message",
  slack_actions: "Slack action",
  spawn_subagent: "Running subtask",
  cron: "Scheduling task",
};

function friendlyLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const preview =
    (typeof obj.query === "string" && obj.query) ||
    (typeof obj.url === "string" && obj.url) ||
    (typeof obj.path === "string" && obj.path) ||
    (typeof obj.command === "string" && obj.command) ||
    (typeof obj.task === "string" && obj.task);
  if (!preview) return "";
  const text = String(preview).trim();
  return text.length > 50 ? text.slice(0, 47) + "..." : text;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    let raf: number;
    function tick() {
      const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      el!.textContent = `${s}s`;
      raf = requestAnimationFrame(tick);
    }
    tick();
    return () => cancelAnimationFrame(raf);
  }, [startedAt]);
  return <span ref={spanRef} className="text-[10px] text-gray-600 tabular-nums" />;
}

function formatDuration(startedAt: number, completedAt: number): string {
  const ms = completedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function ToolCallIndicator({ entry }: { entry: ToolCallEntry }) {
  const label = friendlyLabel(entry.toolName);
  const preview = argsPreview(entry.args);
  const isRunning = entry.status === "running";
  const isError = entry.status === "error";

  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded-lg text-[11px] leading-tight"
      style={{ background: "rgba(30,41,59,0.3)" }}>
      {isRunning ? (
        <svg className="h-3 w-3 shrink-0 animate-spin text-blue-400/70" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="10 22" />
        </svg>
      ) : isError ? (
        <svg className="h-3 w-3 shrink-0 text-red-400/70" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="5" x2="11" y2="11" /><line x1="11" y1="5" x2="5" y2="11" />
        </svg>
      ) : (
        <svg className="h-3 w-3 shrink-0 text-emerald-400/70" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3.5 8.5 6.5 11.5 12.5 5.5" />
        </svg>
      )}

      <span className={`font-medium ${isRunning ? "text-gray-300" : "text-gray-500"}`}>
        {label}
      </span>

      {preview && (
        <span className="text-gray-600 truncate max-w-[180px]">{preview}</span>
      )}

      <span className="ml-auto shrink-0">
        {isRunning ? (
          <ElapsedTimer startedAt={entry.startedAt} />
        ) : entry.completedAt ? (
          <span className="text-[10px] text-gray-600 tabular-nums">
            {formatDuration(entry.startedAt, entry.completedAt)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export { TOOL_LABELS, friendlyLabel };
