import { forwardRef, useLayoutEffect, useRef } from "react";

interface Props {
  text: string;
  focused: boolean;
  onTextChange: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onEscape: () => void;
  onSubmit: (text: string) => void;
}

function clampFontSize(text: string): number {
  const len = text.length;
  if (!text) return 16;
  if (len > 200) return 9;
  if (len > 140) return 10;
  if (len > 100) return 11;
  if (len > 60) return 12;
  if (len > 30) return 14;
  return 16;
}

const CommandInput = forwardRef<HTMLTextAreaElement, Props>(
  ({ text, focused, onTextChange, onFocus, onBlur, onEscape, onSubmit }, ref) => {
    const fontSize = clampFontSize(text);
    const hasText = text.trim().length > 0;
    const mirrorRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLTextAreaElement>(null);

    useLayoutEffect(() => {
      const ta = innerRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 90) + "px";
    }, [text, fontSize]);

    function handleSubmit() {
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed);
    }

    function setRefs(el: HTMLTextAreaElement | null) {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }

    return (
      <foreignObject x={-110} y={-20} width={220} height={130} style={{ overflow: "visible" }}>
        <div style={{
          width: "100%", height: "100%",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "flex-start",
          paddingTop: "4px",
        }}>
          <div style={{ width: "90%", position: "relative" }}>
            <div
              ref={mirrorRef}
              aria-hidden
              style={{
                position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word",
                width: "100%", fontSize: `${fontSize}px`, lineHeight: 1.35, fontFamily: "inherit", padding: "0 4px",
              }}
            >{text || " "}</div>
            <textarea
              ref={setRefs}
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              onFocus={onFocus}
              onBlur={onBlur}
              placeholder="Ask KAI..."
              rows={1}
              style={{
                width: "100%", background: "transparent", border: "none", outline: "none",
                resize: "none", textAlign: "center", color: "white", overflow: "hidden",
                fontSize: `${fontSize}px`, lineHeight: 1.35, caretColor: "#3b82f6",
                transition: "font-size 0.2s ease", fontFamily: "inherit",
                padding: "0 4px",
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") onEscape();
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
              }}
            />
          </div>
          <div style={{
            marginTop: "4px", display: "flex", alignItems: "center", gap: "4px",
            opacity: focused || hasText ? 0.5 : 0,
            transition: "opacity 0.3s ease",
          }}>
            <span style={{ fontSize: "8px", color: "#94a3b8", letterSpacing: "0.03em", userSelect: "none" }}>
              {hasText ? "enter to send" : "start typing..."}
            </span>
            {hasText && (
              <button
                onClick={handleSubmit}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, marginLeft: "2px",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </foreignObject>
    );
  }
);

CommandInput.displayName = "CommandInput";
export default CommandInput;
