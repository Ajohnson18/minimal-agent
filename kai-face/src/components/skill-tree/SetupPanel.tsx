import { useState, useRef, useEffect } from "react";
import { apiPatch, apiPut } from "../../api/client";
import type { SetupTask } from "../../lib/skill-tree-data";
import SecretInput from "../ui/SecretInput";
import ToolSelector from "./ToolSelector";

interface TaskWithState extends SetupTask {
  completed: boolean;
}

interface Props {
  nodeId: string;
  nodeLabel: string;
  nodeBranch?: string;
  tasks: TaskWithState[];
  onTaskComplete: (taskId: string) => void;
  onAllComplete: () => void;
}

const BRANCH_COLORS: Record<string, string> = {
  engineering: "#f97316",
  design: "#a855f7",
  product: "#06b6d4",
};

export default function SetupPanel({ nodeId, nodeLabel, nodeBranch, tasks, onTaskComplete, onAllComplete }: Props) {
  const initialDone = () => new Set(tasks.filter((t) => t.completed).map((t) => t.id));
  const firstIncomplete = tasks.findIndex((t) => !t.completed);

  const [phase, setPhase] = useState<"intro" | "questions" | "done">(
    tasks.every((t) => t.completed) ? "done" : "intro"
  );
  const [currentIdx, setCurrentIdx] = useState(firstIncomplete >= 0 ? firstIncomplete : 0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [completedSet, setCompletedSet] = useState<Set<string>>(initialDone);
  const [saving, setSaving] = useState(false);
  const [credSaved, setCredSaved] = useState(false);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentTask = tasks[currentIdx];
  const isCredential = !!currentTask?.detectKey && !currentTask.detectKey.startsWith("onboard:");
  const isToolSelector = currentTask?.detectKey === "onboard:team_tools";
  const isOptional = currentTask?.required === false;
  const requiredTasks = tasks.filter((t) => t.required !== false);
  const totalDone = completedSet.size;
  const accentColor = nodeBranch ? (BRANCH_COLORS[nodeBranch] ?? "#3b82f6") : "#3b82f6";

  useEffect(() => {
    if (phase === "questions" && inputRef.current && !isCredential) {
      inputRef.current.focus();
    }
  }, [phase, currentIdx, isCredential]);

  useEffect(() => {
    if (phase === "done") {
      const t = setTimeout(onAllComplete, 1200);
      return () => clearTimeout(t);
    }
  }, [phase]);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAdvance();
    }
    if (e.key === "ArrowUp" || e.key === "Backspace" && !answers[currentTask?.id]) {
      e.preventDefault();
      goBack();
    }
  }

  function goBack() {
    if (phase === "questions" && currentIdx > 0) setCurrentIdx((i) => i - 1);
    else if (phase === "questions" && currentIdx === 0) setPhase("intro");
  }

  async function handleAdvance(skip = false) {
    if (phase === "intro") { setPhase("questions"); return; }
    if (!currentTask || saving) return;
    const answer = skip
      ? ""
      : isToolSelector
        ? JSON.stringify([...selectedTools])
        : (answers[currentTask.id] || "").trim();
    const isRequired = currentTask.required !== false;

    if (!answer && isRequired && !isCredential && !isToolSelector) return;

    setSaving(true);
    try {
      if (answer && currentTask.detectKey?.startsWith("onboard:")) {
        const questionKey = currentTask.detectKey.replace("onboard:", "");
        await apiPut(`/setup/questions/${questionKey}`, { answer }).catch(() => {});
      }

      let updated = tasks;
      if (answer || isCredential) {
        // Mark completed only if answered
        updated = tasks.map((t) =>
          t.id === currentTask.id ? { ...t, completed: true } : t
        );
        await apiPatch(`/setup/skill-tree/${nodeId}`, { setupTasks: updated });
        setCompletedSet((prev) => new Set([...prev, currentTask.id]));
        onTaskComplete(currentTask.id);
      }

      const nextIdx = tasks.findIndex((t, i) => i > currentIdx && !t.completed && !completedSet.has(t.id));

      if (nextIdx >= 0) {
        setCurrentIdx(nextIdx);
        setCredSaved(false);
      } else {
        // Only go to done if all required tasks are answered
        const allRequiredDone = requiredTasks.every(
          (t) => t.completed || completedSet.has(t.id) || (answer && t.id === currentTask.id)
        );
        if (allRequiredDone) {
          setPhase("done");
        }
        // else: stay on last required task that still needs answering
        const firstUnmet = tasks.findIndex(
          (t) => t.required !== false && !t.completed && !completedSet.has(t.id) && t.id !== currentTask.id
        );
        if (!allRequiredDone && firstUnmet >= 0) setCurrentIdx(firstUnmet);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleCredentialSaved() {
    setCredSaved(true);
  }

  // After credential saved, auto-advance
  useEffect(() => {
    if (credSaved) handleAdvance();
  }, [credSaved]);

  const progress = tasks.length > 0 ? (totalDone / tasks.length) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col h-full bg-gray-950 select-none"
      tabIndex={-1}
    >
      {/* Progress bar */}
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gray-800 z-10">
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${progress}%`, backgroundColor: accentColor }}
        />
      </div>

      {/* Main card area */}
      <div className="flex-1 flex items-center justify-center px-8">
        {phase === "intro" && (
          <div className="text-center max-w-lg" onKeyDown={(e) => e.key === "Enter" && setPhase("questions")} tabIndex={0}>
            <div
              className="inline-flex h-14 w-14 items-center justify-center rounded-2xl mb-6 text-2xl font-bold text-white"
              style={{ backgroundColor: accentColor + "33", border: `2px solid ${accentColor}` }}
            >
              {nodeLabel[0]}
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Unlock {nodeLabel}</h1>
            <p className="text-gray-400 text-base mb-2">
              {tasks.length} thing{tasks.length !== 1 ? "s" : ""} to set up. I'll ask one at a time — no forms, no walls of text.
            </p>
            <p className="text-gray-500 text-sm mb-8">
              For anything sensitive I'll open a secure input. Nothing you share here goes anywhere except your own instance.
            </p>
            <button
              onClick={() => setPhase("questions")}
              className="rounded-xl px-6 py-3 text-sm font-semibold text-white transition-[opacity,transform] hover:opacity-90 active:scale-95"
              style={{ backgroundColor: accentColor }}
            >
              Let's do it →
            </button>
            <p className="text-xs text-gray-600 mt-4">press Enter to start</p>
          </div>
        )}

        {phase === "questions" && currentTask && (
          <div className={`w-full ${isToolSelector ? "max-w-2xl" : "max-w-lg"}`}>
            {/* Question number */}
            <div className="flex items-center gap-2 mb-4">
              <span className="text-sm font-medium" style={{ color: accentColor }}>
                {currentIdx + 1}
              </span>
              <span className="text-gray-600 text-sm">/ {tasks.length}</span>
              <span className="ml-1 text-gray-600 text-sm">→</span>
            </div>

            {isOptional && (
              <span className="inline-block text-xs text-gray-500 mb-2">optional</span>
            )}

            <h2 className="text-2xl font-semibold text-white mb-6 leading-snug">
              {currentTask.label}
            </h2>

            {isToolSelector ? (
              <div>
                <p className="text-sm text-gray-500 mb-4">
                  Pick the tools your team works with — this shapes what shows up on the map.
                </p>
                <ToolSelector
                  selected={selectedTools}
                  onChange={setSelectedTools}
                  accentColor={accentColor}
                />
                <div className="flex items-center gap-4 mt-5">
                  <button
                    onClick={() => handleAdvance()}
                    disabled={saving}
                    className="rounded-lg px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                    style={{ backgroundColor: accentColor }}
                  >
                    {saving ? "Saving..." : "Continue →"}
                  </button>
                  <button
                    onClick={currentIdx === 0 ? () => setPhase("intro") : goBack}
                    className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    ← Back
                  </button>
                </div>
              </div>
            ) : isCredential ? (
              <div>
                <p className="text-sm text-gray-500 mb-3">This goes straight to your secure vault — I won't see it.</p>
                <SecretInput
                  credentialKey={currentTask.detectKey!}
                  onSaved={handleCredentialSaved}
                />
              </div>
            ) : (
              <div className="relative">
                <input
                  ref={inputRef}
                  value={answers[currentTask.id] || ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [currentTask.id]: e.target.value }))}
                  onKeyDown={handleKey}
                  placeholder="Your answer..."
                  className="w-full bg-transparent border-b-2 border-gray-700 focus:border-white pb-2 text-lg text-white placeholder-gray-600 outline-none transition-colors"
                  style={{ caretColor: accentColor }}
                />
              </div>
            )}

            {!isCredential && !isToolSelector && (
              <div className="flex items-center gap-4 mt-5 text-xs text-gray-600">
                <span>Press <kbd className="font-mono bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5">Enter ↵</kbd> to continue</span>
                <button
                  onClick={currentIdx === 0 ? () => setPhase("intro") : goBack}
                  className="hover:text-gray-400 transition-colors"
                >
                  ← Back
                </button>
                {isOptional && (
                  <button
                    onClick={() => handleAdvance(true)}
                    className="ml-auto hover:text-gray-400 transition-colors"
                  >
                    Skip →
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="text-center">
            <div className="text-5xl mb-4">✓</div>
            <h2 className="text-2xl font-bold text-white mb-2">That's {nodeLabel} sorted.</h2>
            <p className="text-gray-400 text-sm">Unlocking your capabilities now...</p>
          </div>
        )}
      </div>

      {/* Task list footer */}
      {phase === "questions" && (
        <div className="border-t border-gray-800 px-8 py-3 flex items-center gap-4 overflow-x-auto">
          {tasks.map((t, i) => {
            const done = completedSet.has(t.id);
            const isCur = i === currentIdx;
            return (
              <button
                key={t.id}
                onClick={() => setCurrentIdx(i)}
                className="flex items-center gap-1.5 shrink-0 text-xs transition-colors"
                style={{ color: isCur ? accentColor : done ? "#22c55e" : "#4b5563" }}
              >
                <div
                  className="h-4 w-4 rounded flex items-center justify-center shrink-0"
                  style={{
                    border: `1.5px solid ${isCur ? accentColor : done ? "#22c55e" : "#374151"}`,
                    background: done ? "#22c55e20" : "transparent",
                  }}
                >
                  {done && (
                    <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
