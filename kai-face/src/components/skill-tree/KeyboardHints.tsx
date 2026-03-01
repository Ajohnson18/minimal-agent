const HINTS = [
  { keys: ["←", "→", "↑", "↓"], label: "navigate" },
  { keys: ["Enter"], label: "select" },
  { keys: ["Esc"], label: "back" },
];

export default function KeyboardHints() {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 z-10">
      {HINTS.map(({ keys, label }) => (
        <div key={label} className="flex items-center gap-1.5 text-[10px] text-gray-600">
          <div className="flex gap-0.5">
            {keys.map((k) => (
              <kbd key={k} className="rounded bg-gray-800/80 border border-gray-700/50 px-1 h-5 flex items-center justify-center text-[8px] text-gray-500">{k}</kbd>
            ))}
          </div>
          <span>{label}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 text-[10px] text-gray-600"><span>scroll to zoom</span></div>
    </div>
  );
}
