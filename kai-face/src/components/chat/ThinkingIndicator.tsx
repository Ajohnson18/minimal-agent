import { useEffect, useRef } from "react";

export default function ThinkingIndicator({ startedAt }: { startedAt: number }) {
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    let raf: number;
    function tick() {
      const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      el!.textContent = s > 0 ? `${s}s` : "";
      raf = requestAnimationFrame(tick);
    }
    tick();
    return () => cancelAnimationFrame(raf);
  }, [startedAt]);

  return (
    <div className="flex items-center gap-2.5 py-2 px-1">
      <div className="flex items-center gap-1">
        <div
          className="h-1.5 w-1.5 rounded-full animate-pulse"
          style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s" }}
        />
        <div
          className="h-1.5 w-1.5 rounded-full animate-pulse"
          style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s", animationDelay: "0.2s" }}
        />
        <div
          className="h-1.5 w-1.5 rounded-full animate-pulse"
          style={{ background: "rgba(96,165,250,0.6)", animationDuration: "1.4s", animationDelay: "0.4s" }}
        />
      </div>
      <span className="text-[11px] text-blue-400/60 font-medium">Reasoning</span>
      <span ref={spanRef} className="text-[10px] text-gray-600 tabular-nums" />
    </div>
  );
}
