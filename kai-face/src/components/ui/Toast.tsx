interface Props {
  message: string;
  onDismiss: () => void;
}

export default function Toast({ message, onDismiss }: Props) {
  if (!message) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-lg rounded-xl border border-gray-700 bg-gray-900/95 backdrop-blur-sm px-5 py-3 shadow-2xl z-10">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-6 w-6 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-white">K</span>
        </div>
        <p className="text-sm text-gray-200">{message}</p>
        <button onClick={onDismiss} className="text-gray-500 hover:text-gray-300 shrink-0">×</button>
      </div>
    </div>
  );
}
