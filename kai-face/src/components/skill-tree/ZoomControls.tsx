interface Props {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export default function ZoomControls({ onZoomIn, onZoomOut, onReset }: Props) {
  const btn = "rounded-lg bg-gray-800/80 border border-gray-700/50 w-8 h-8 text-gray-500 hover:text-white hover:bg-gray-700 transition-colors";
  return (
    <div className="absolute left-4 bottom-12 flex flex-col gap-1">
      <button onClick={onZoomIn} className={`${btn} text-sm font-bold`}>+</button>
      <button onClick={onZoomOut} className={`${btn} text-sm font-bold`}>−</button>
      <button onClick={onReset} className={`${btn} text-[10px]`}>⊙</button>
    </div>
  );
}
