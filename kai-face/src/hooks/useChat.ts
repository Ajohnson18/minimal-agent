import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { rpc, subscribe, ensureConnected, type GatewayEvent } from "../lib/gateway";
import { apiPost } from "../api/client";

export interface ToolCallEntry {
  id: string;
  toolName: string;
  args?: unknown;
  resultPreview?: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  completedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  streaming?: boolean;
  thinking?: boolean;
  toolCalls?: ToolCallEntry[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  sessionKey: string | null;
  isStreaming: boolean;
  createdAt: number;
}

export interface UseChatOptions {
  onToolCall?: (toolName: string) => void;
  onComplete?: () => void;
}

function createSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    messages: [],
    sessionKey: null,
    isStreaming: false,
    createdAt: Date.now(),
  };
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New Chat";
  const text = first.content.trim();
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

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

export function useChat(options?: UseChatOptions) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [createSession()]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0].id);
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());

  const pendingRunsRef = useRef<Map<string, { msgId: string; sid: string }>>(new Map());
  const unmatchedSendRef = useRef<Map<string, { msgId: string; sid: string }>>(new Map());
  const unsubMapRef = useRef<Map<string, boolean>>(new Map());
  const globalUnsubRef = useRef<(() => void) | null>(null);
  const onToolCallRef = useRef(options?.onToolCall);
  onToolCallRef.current = options?.onToolCall;
  const onCompleteRef = useRef(options?.onComplete);
  onCompleteRef.current = options?.onComplete;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const backgroundRunsRef = useRef<Map<string, { msgId: string; sid: string }>>(new Map());
  const chunkBufferRef = useRef<Map<string, { sid: string; text: string }>>(new Map());
  const chunkRafRef = useRef<number | null>(null);

  function flushChunkBuffer() {
    chunkRafRef.current = null;
    const buf = chunkBufferRef.current;
    if (buf.size === 0) return;
    const entries = Array.from(buf.entries());
    buf.clear();
    setSessions((prev) => {
      let next = prev;
      for (const [msgId, { sid, text }] of entries) {
        next = next.map((s) => {
          if (s.id !== sid) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msgId ? { ...m, thinking: false, content: m.content + text } : m
            ),
          };
        });
      }
      return next;
    });
  }

  function bufferChunk(sid: string, msgId: string, text: string) {
    const existing = chunkBufferRef.current.get(msgId);
    if (existing) {
      existing.text += text;
    } else {
      chunkBufferRef.current.set(msgId, { sid, text });
    }
    if (chunkRafRef.current === null) {
      chunkRafRef.current = requestAnimationFrame(flushChunkBuffer);
    }
  }

  useEffect(() => () => {
    globalUnsubRef.current?.();
    if (chunkRafRef.current !== null) cancelAnimationFrame(chunkRafRef.current);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId],
  );

  function updateSession(sessionId: string, updater: (s: ChatSession) => ChatSession) {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));
  }

  function ensureBackgroundRun(runId: string, evt: GatewayEvent): { msgId: string; sid: string } {
    const existing = backgroundRunsRef.current.get(runId);
    if (existing) return existing;

    const sessionKey = (evt.payload as { sessionKey?: string }).sessionKey;
    const match = sessionKey
      ? sessionsRef.current.find((s) => s.sessionKey === sessionKey)
      : null;
    const sid = match?.id ?? activeSessionIdRef.current;
    const msgId = crypto.randomUUID();

    backgroundRunsRef.current.set(runId, { msgId, sid });
    updateSession(sid, (s) => ({
      ...s,
      isStreaming: true,
      messages: [...s.messages, {
        id: msgId,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
        streaming: true,
        thinking: true,
      }],
    }));

    return { msgId, sid };
  }

  function trackToolCallOnSkillTree(toolName: string, args?: unknown) {
    const ids = [`tool:${toolName}`, toolName];
    if (toolName === "read") {
      const path = (args as { path?: string })?.path ?? "";
      const skillMatch = path.match(/\/skills\/([^/]+)\/SKILL\.md$/i);
      if (skillMatch) ids.push(`skill:${skillMatch[1]}`);
    }
    setActiveTools((prev) => new Set([...prev, ...ids]));
    const panTarget = ids.find((id) => id.startsWith("skill:")) ?? toolName;
    onToolCallRef.current?.(panTarget);
    setTimeout(() => {
      setActiveTools((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, 2000);
  }

  function updateMsg(sid: string, msgId: string, updater: (m: ChatMessage) => ChatMessage) {
    updateSession(sid, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === msgId ? updater(m) : m)),
    }));
  }

  function handleChatEvent(sid: string, msgId: string, evt: GatewayEvent) {
    const state = evt.payload.state as string;

    switch (state) {
      case "delta": {
        const text = extractTextFromRichMessage(evt.payload.message);
        if (text) bufferChunk(sid, msgId, text);
        break;
      }
      case "final": {
        if (chunkRafRef.current !== null) {
          cancelAnimationFrame(chunkRafRef.current);
          flushChunkBuffer();
        }
        const finalText = extractTextFromRichMessage(evt.payload.message);
        updateMsg(sid, msgId, (m) => {
          const calls = (m.toolCalls ?? []).map((tc) =>
            tc.status === "running" ? { ...tc, status: "completed" as const, completedAt: Date.now() } : tc
          );
          return {
            ...m,
            content: finalText || m.content,
            streaming: false,
            thinking: false,
            toolCalls: calls,
          };
        });
        updateSession(sid, (s) => ({ ...s, isStreaming: false }));
        break;
      }
      case "error": {
        const errorMessage = (evt.payload.errorMessage as string) || "Unknown error";
        updateMsg(sid, msgId, (m) => ({
          ...m,
          content: `Error: ${errorMessage}`,
          streaming: false,
          thinking: false,
        }));
        updateSession(sid, (s) => ({ ...s, isStreaming: false }));
        break;
      }
      case "aborted": {
        updateMsg(sid, msgId, (m) => ({
          ...m,
          content: m.content || "Aborted",
          streaming: false,
          thinking: false,
        }));
        updateSession(sid, (s) => ({ ...s, isStreaming: false }));
        break;
      }
    }
  }

  function handleAgentSideChannel(sid: string, msgId: string, evt: GatewayEvent) {
    const stream = evt.payload.stream as string;
    const data = (evt.payload.data ?? {}) as Record<string, unknown>;

    switch (stream) {
      case "thinking":
        updateMsg(sid, msgId, (m) => ({ ...m, thinking: true }));
        break;
      case "tool": {
        const phase = data.phase as string;
        const toolName = data.toolName as string;
        if (phase === "call") {
          const entry: ToolCallEntry = {
            id: crypto.randomUUID(),
            toolName,
            args: data.args,
            status: "running",
            startedAt: Date.now(),
          };
          updateMsg(sid, msgId, (m) => ({
            ...m,
            thinking: false,
            toolCalls: [...(m.toolCalls ?? []), entry],
          }));
          trackToolCallOnSkillTree(toolName, data.args);
        } else if (phase === "result") {
          const raw = data.result;
          const preview = typeof raw === "string" ? raw.slice(0, 120) : undefined;
          const now = Date.now();
          updateMsg(sid, msgId, (m) => {
            const calls = [...(m.toolCalls ?? [])];
            for (let i = calls.length - 1; i >= 0; i--) {
              if (calls[i].toolName === toolName && calls[i].status === "running") {
                calls[i] = { ...calls[i], status: "completed", completedAt: now, resultPreview: preview };
                break;
              }
            }
            return { ...m, toolCalls: calls };
          });
        }
        break;
      }
    }
  }

  function handleEvent(evt: GatewayEvent) {
    const payloadRunId = (evt.payload as { runId?: string }).runId;
    if (!payloadRunId) return;

    let tracked = pendingRunsRef.current.get(payloadRunId);

    if (!tracked) {
      const evtSessionKey = (evt.payload as { sessionKey?: string }).sessionKey;
      if (evtSessionKey && unmatchedSendRef.current.has(evtSessionKey)) {
        tracked = unmatchedSendRef.current.get(evtSessionKey)!;
        pendingRunsRef.current.set(payloadRunId, tracked);
        unmatchedSendRef.current.delete(evtSessionKey);
      } else if (unmatchedSendRef.current.size === 1) {
        for (const [key, val] of unmatchedSendRef.current) {
          tracked = val;
          pendingRunsRef.current.set(payloadRunId, tracked);
          unmatchedSendRef.current.delete(key);
          break;
        }
      }
    }

    const isTerminal = evt.event === "chat" &&
      (evt.payload.state === "final" || evt.payload.state === "error" || evt.payload.state === "aborted");

    if (tracked) {
      if (evt.event === "chat") {
        handleChatEvent(tracked.sid, tracked.msgId, evt);
      } else if (evt.event === "agent") {
        handleAgentSideChannel(tracked.sid, tracked.msgId, evt);
      }
      if (isTerminal) {
        pendingRunsRef.current.delete(payloadRunId);
        if (evt.payload.state === "final") onCompleteRef.current?.();
      }
      return;
    }

    if (isTerminal) {
      const bg = backgroundRunsRef.current.get(payloadRunId);
      if (!bg) return;
      handleChatEvent(bg.sid, bg.msgId, evt);
      backgroundRunsRef.current.delete(payloadRunId);
      if (evt.payload.state === "final") onCompleteRef.current?.();
    } else {
      const bg = ensureBackgroundRun(payloadRunId, evt);
      if (evt.event === "chat") {
        handleChatEvent(bg.sid, bg.msgId, evt);
      } else if (evt.event === "agent") {
        handleAgentSideChannel(bg.sid, bg.msgId, evt);
      }
    }
  }

  const loadHistory = useCallback(async (sessionId: string, sessionKey: string) => {
    try {
      const result = await rpc<{
        messages: Array<{
          id?: string;
          role: string;
          timestamp: number;
          content: Array<{ type: string; text?: string }>;
        }>;
      }>("chat.history", { sessionKey });

      const chatMessages: ChatMessage[] = result.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id ?? crypto.randomUUID(),
          role: m.role as "user" | "assistant",
          content: m.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join(""),
          timestamp: m.timestamp,
        }));

      updateSession(sessionId, (s) => ({
        ...s,
        messages: chatMessages,
        title: deriveTitle(chatMessages),
      }));
    } catch {
      // History load is best-effort
    }
  }, []);

  const send = useCallback(async (text: string, targetSessionId?: string) => {
    const sid = targetSessionId ?? activeSessionId;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() };
    const assistantId = crypto.randomUUID();

    updateSession(sid, (s) => {
      const msgs = [
        ...s.messages,
        userMsg,
        { id: assistantId, role: "assistant" as const, content: "", timestamp: Date.now(), streaming: true, thinking: true },
      ];
      return { ...s, isStreaming: true, messages: msgs, title: s.messages.length === 0 ? deriveTitle([...s.messages, userMsg]) : s.title };
    });

    try {
      ensureConnected();
      let sessionKey: string | null = null;

      setSessions((prev) => {
        const s = prev.find((s) => s.id === sid);
        sessionKey = s?.sessionKey ?? null;
        return prev;
      });

      await new Promise((r) => setTimeout(r, 0));

      setSessions((prev) => {
        const s = prev.find((s) => s.id === sid);
        sessionKey = s?.sessionKey ?? null;
        return prev;
      });

      if (!sessionKey) {
        const result = await apiPost<{ session: { sessionKey: string } }>("/sessions", { title: "Chat" });
        sessionKey = result.session.sessionKey;
        updateSession(sid, (s) => ({ ...s, sessionKey }));
      }

      if (!unsubMapRef.current.has(sid)) {
        await rpc("subscribe", {
          events: ["chat", "agent"],
          sessionKey,
        });
        unsubMapRef.current.set(sid, true);
        if (!globalUnsubRef.current) {
          globalUnsubRef.current = subscribe(handleEvent);
        }
      }

      unmatchedSendRef.current.set(sessionKey!, { msgId: assistantId, sid });
      const idempotencyKey = crypto.randomUUID();
      const result = await rpc<{ runId: string; status: string }>("chat.send", {
        sessionKey,
        message: text,
        idempotencyKey,
      });
      unmatchedSendRef.current.delete(sessionKey!);
      pendingRunsRef.current.set(result.runId, { msgId: assistantId, sid });
    } catch (err) {
      updateSession(sid, (s) => ({
        ...s,
        isStreaming: false,
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, content: `Failed to send: ${err}`, streaming: false, thinking: false } : m
        ),
      }));
    }
  }, [activeSessionId]);

  const executePower = useCallback(async (powerId: string, powerName: string, targetSessionId?: string) => {
    const sid = targetSessionId ?? activeSessionId;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: `Running power: ${powerName}`, timestamp: Date.now() };
    const assistantId = crypto.randomUUID();

    updateSession(sid, (s) => {
      const msgs = [
        ...s.messages,
        userMsg,
        { id: assistantId, role: "assistant" as const, content: "", timestamp: Date.now(), streaming: true, thinking: true },
      ];
      return { ...s, isStreaming: true, messages: msgs, title: s.messages.length === 0 ? powerName : s.title };
    });

    try {
      ensureConnected();
      let sessionKey: string | null = null;

      setSessions((prev) => {
        const s = prev.find((s) => s.id === sid);
        sessionKey = s?.sessionKey ?? null;
        return prev;
      });

      await new Promise((r) => setTimeout(r, 0));

      setSessions((prev) => {
        const s = prev.find((s) => s.id === sid);
        sessionKey = s?.sessionKey ?? null;
        return prev;
      });

      if (!sessionKey) {
        const result = await apiPost<{ session: { sessionKey: string } }>("/sessions", { title: powerName });
        sessionKey = result.session.sessionKey;
        updateSession(sid, (s) => ({ ...s, sessionKey }));
      }

      if (!unsubMapRef.current.has(sid)) {
        await rpc("subscribe", {
          events: ["chat", "agent"],
          sessionKey,
        });
        unsubMapRef.current.set(sid, true);
        if (!globalUnsubRef.current) {
          globalUnsubRef.current = subscribe(handleEvent);
        }
      }

      unmatchedSendRef.current.set(sessionKey!, { msgId: assistantId, sid });
      const result = await rpc<{ runId: string; status: string }>("powers.execute", {
        powerId,
        sessionKey,
      });
      unmatchedSendRef.current.delete(sessionKey!);
      pendingRunsRef.current.set(result.runId, { msgId: assistantId, sid });
    } catch (err) {
      updateSession(sid, (s) => ({
        ...s,
        isStreaming: false,
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, content: `Failed to execute power: ${err}`, streaming: false, thinking: false } : m
        ),
      }));
    }
  }, [activeSessionId]);

  const abort = useCallback(async () => {
    const session = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (!session?.sessionKey) return;
    try {
      await rpc("chat.abort", { sessionKey: session.sessionKey });
    } catch {
      // Best-effort
    }
  }, []);

  const newSession = useCallback(() => {
    const s = createSession();
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
    return s.id;
  }, []);

  const switchSession = useCallback((id: string) => {
    setActiveSessionId(id);
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session?.sessionKey && session.messages.length === 0) {
      loadHistory(id, session.sessionKey);
    }
  }, [loadHistory]);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSessionId) {
        setActiveSessionId(filtered[0].id);
      }
      return filtered;
    });
  }, [activeSessionId]);

  const messages = useMemo(() => activeSession.messages, [activeSession.messages]);
  const isStreaming = activeSession.isStreaming;

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeTools,
    messages,
    isStreaming,
    send,
    executePower,
    abort,
    newSession,
    switchSession,
    deleteSession,
    loadHistory,
  };
}
