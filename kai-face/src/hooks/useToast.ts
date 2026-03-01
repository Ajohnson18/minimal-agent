import { useState, useRef } from "react";

export function useToast(defaultMs = 10000) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function show(msg: string, ms = defaultMs) {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    timer.current = setTimeout(() => setMessage(""), ms);
  }

  function dismiss() {
    if (timer.current) clearTimeout(timer.current);
    setMessage("");
  }

  return { message, show, dismiss };
}
