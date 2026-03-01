/**
 * Process Registry
 *
 * In-memory tracking of exec sessions (running + finished).
 * Features: pending buffer caps, binary sanitization, scope isolation, SessionStdin.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_PENDING_MAX_CHARS = 30_000;
const SWEEPER_INTERVAL_MS = 60_000;

export type ProcessStatus = "running" | "completed" | "failed" | "killed";

export type SessionStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
};

export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  child?: ChildProcessWithoutNullStreams;
  stdin?: SessionStdin;
  pid?: number;
  startedAt: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars: number;
  totalOutputChars: number;
  pendingStdout: string[];
  pendingStderr: string[];
  pendingStdoutChars: number;
  pendingStderrChars: number;
  nextSeq: number;
  lastSeq: number;
  lastStdoutSeq: number;
  lastStderrSeq: number;
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exited: boolean;
  truncated: boolean;
  backgrounded: boolean;
  onExitCallback?: (session: FinishedSession) => void;
}

export interface FinishedSession {
  id: string;
  command: string;
  scopeKey?: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  status: ProcessStatus;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  totalOutputChars: number;
  lastSeq: number;
  lastStdoutSeq: number;
  lastStderrSeq: number;
}

import { getConfig } from '../../lib/config-loader.js';
const MAX_RUNNING_SESSIONS = getConfig().tools.exec.maxRunning;
const MAX_FINISHED_SESSIONS = getConfig().tools.exec.maxFinished;

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();
let sweeperInterval: ReturnType<typeof setInterval> | null = null;

function startSweeper() {
  if (sweeperInterval) return;
  const ttl = getConfig().tools.exec.jobTtlMs;
  sweeperInterval = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, s] of finishedSessions) {
      if (s.endedAt < cutoff) finishedSessions.delete(id);
    }
    if (runningSessions.size === 0 && finishedSessions.size === 0 && sweeperInterval) {
      clearInterval(sweeperInterval);
      sweeperInterval = null;
    }
  }, SWEEPER_INTERVAL_MS);
  sweeperInterval.unref();
}

function tailStr(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Strip non-printable characters from output (binary sanitization).
 */
export function sanitizeBinaryOutput(text: string): string {
  // Keep printable ASCII, common whitespace, and unicode
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Cap pending buffer by dropping oldest chunks.
 */
function capPendingBuffer(
  pending: string[],
  chars: number,
  max: number
): { pending: string[]; chars: number } {
  if (chars <= max) return { pending, chars };
  let total = chars;
  while (total > max && pending.length > 0) {
    const dropped = pending.shift()!;
    total -= dropped.length;
  }
  return { pending, chars: total };
}

export function addSession(session: ProcessSession): void {
  // Bound running sessions — evict oldest if over limit
  if (runningSessions.size >= MAX_RUNNING_SESSIONS) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of runningSessions) {
      if (s.startedAt < oldestTime) { oldest = id; oldestTime = s.startedAt; }
    }
    if (oldest) runningSessions.delete(oldest);
  }
  runningSessions.set(session.id, session);
  startSweeper();
}

export function getSession(id: string): ProcessSession | undefined {
  return runningSessions.get(id);
}

export function getFinishedSession(id: string): FinishedSession | undefined {
  return finishedSessions.get(id);
}

export function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  rawChunk: string
): void {
  const chunk = sanitizeBinaryOutput(rawChunk);
  session.totalOutputChars += chunk.length;
  session.nextSeq += 1;
  session.lastSeq = session.nextSeq;
  if (stream === "stdout") {
    session.lastStdoutSeq = session.nextSeq;
  } else {
    session.lastStderrSeq = session.nextSeq;
  }

  if (stream === "stdout") {
    session.pendingStdout.push(chunk);
    session.pendingStdoutChars += chunk.length;
    const capped = capPendingBuffer(session.pendingStdout, session.pendingStdoutChars, session.pendingMaxOutputChars);
    session.pendingStdout = capped.pending;
    session.pendingStdoutChars = capped.chars;
  } else {
    session.pendingStderr.push(chunk);
    session.pendingStderrChars += chunk.length;
    const capped = capPendingBuffer(session.pendingStderr, session.pendingStderrChars, session.pendingMaxOutputChars);
    session.pendingStderr = capped.pending;
    session.pendingStderrChars = capped.chars;
  }

  session.aggregated += chunk;
  if (session.aggregated.length > session.maxOutputChars) {
    session.aggregated = tailStr(session.aggregated, session.maxOutputChars);
    session.truncated = true;
  }
  session.tail = tailStr(session.aggregated, 2000);
}

export function drainSession(session: ProcessSession): {
  stdout: string;
  stderr: string;
} {
  const stdout = session.pendingStdout.join("");
  const stderr = session.pendingStderr.join("");
  session.pendingStdout = [];
  session.pendingStderr = [];
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  return { stdout, stderr };
}

export function markExited(
  session: ProcessSession,
  code: number | null,
  signal: NodeJS.Signals | number | null,
  status: ProcessStatus
): void {
  session.exitCode = code;
  session.exitSignal = signal;
  session.exited = true;
  moveToFinished(session, status);
}

export function markBackgrounded(session: ProcessSession): void {
  session.backgrounded = true;
}

function moveToFinished(session: ProcessSession, status: ProcessStatus): void {
  runningSessions.delete(session.id);
  if (session.backgrounded) {
    const finished: FinishedSession = {
      id: session.id,
      command: session.command,
      scopeKey: session.scopeKey,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      cwd: session.cwd,
      status,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      aggregated: session.aggregated,
      tail: session.tail,
      truncated: session.truncated,
      totalOutputChars: session.totalOutputChars,
      lastSeq: session.lastSeq,
      lastStdoutSeq: session.lastStdoutSeq,
      lastStderrSeq: session.lastStderrSeq,
    };
    // Bound finished sessions — evict oldest if over limit
    if (finishedSessions.size >= MAX_FINISHED_SESSIONS) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [id, s] of finishedSessions) {
        if (s.endedAt < oldestTime) { oldest = id; oldestTime = s.endedAt; }
      }
      if (oldest) finishedSessions.delete(oldest);
    }
    finishedSessions.set(session.id, finished);
    // Fire exit notification callback
    if (session.onExitCallback) {
      try { session.onExitCallback(finished); } catch { /* ignore */ }
    }
  }
}

export function killSession(id: string): boolean {
  const session = runningSessions.get(id);
  if (!session || session.exited) return false;
  try {
    session.child?.kill("SIGTERM");
  } catch {
    // ignore
  }
  // Escalate to SIGKILL after 3s grace period if process hasn't exited.
  // The child's close event handles markExited naturally; this is just a safety net.
  setTimeout(() => {
    if (!session.exited) {
      try { session.child?.kill("SIGKILL"); } catch { /* ignore */ }
      markExited(session, null, "SIGKILL", "killed");
    }
  }, 3000).unref();
  return true;
}

export function clearFinished(id: string): boolean {
  return finishedSessions.delete(id);
}

export function deleteSession(id: string): boolean {
  if (runningSessions.has(id)) {
    killSession(id);
    return true;
  }
  return finishedSessions.delete(id);
}

export function listSessions(scopeKey?: string): {
  running: Array<{
    id: string;
    command: string;
    pid?: number;
    startedAt: number;
    backgrounded: boolean;
  }>;
  finished: Array<{
    id: string;
    command: string;
    status: ProcessStatus;
    exitCode?: number | null;
    startedAt: number;
    endedAt: number;
  }>;
} {
  const matchScope = (s: { scopeKey?: string }) =>
    !scopeKey || s.scopeKey === scopeKey;

  const running = Array.from(runningSessions.values())
    .filter(matchScope)
    .map((s) => ({
      id: s.id,
      command: s.command,
      pid: s.pid,
      startedAt: s.startedAt,
      backgrounded: s.backgrounded,
    }));
  const finished = Array.from(finishedSessions.values())
    .filter(matchScope)
    .map((s) => ({
      id: s.id,
      command: s.command,
      status: s.status,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
  return {
    running: running.sort((a, b) => a.startedAt - b.startedAt),
    finished: finished.sort((a, b) => a.startedAt - b.startedAt),
  };
}

export function createEmptySession(
  id: string,
  command: string,
  cwd?: string,
  scopeKey?: string
): ProcessSession {
  const maxOutput = getConfig().tools.exec.maxOutputChars;
  return {
    id,
    command,
    scopeKey,
    startedAt: Date.now(),
    cwd,
    maxOutputChars: maxOutput,
    pendingMaxOutputChars: DEFAULT_PENDING_MAX_CHARS,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    nextSeq: 0,
    lastSeq: 0,
    lastStdoutSeq: 0,
    lastStderrSeq: 0,
    aggregated: "",
    tail: "",
    exited: false,
    truncated: false,
    backgrounded: false,
  };
}

/**
 * Test-only reset for global process-registry state.
 */
export function resetProcessRegistryForTests(): void {
  runningSessions.clear();
  finishedSessions.clear();
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}

/**
 * Encode key sequences for interactive terminal sessions.
 */
export function encodeKeySequence(keys: string[]): string {
  const keyMap: Record<string, string> = {
    "Ctrl-C": "\x03",
    "Ctrl-D": "\x04",
    "Ctrl-Z": "\x1A",
    "Ctrl-\\": "\x1C",
    "Enter": "\r",
    "Tab": "\t",
    "Escape": "\x1B",
    "Backspace": "\x7F",
    "Up": "\x1B[A",
    "Down": "\x1B[B",
    "Right": "\x1B[C",
    "Left": "\x1B[D",
    "Home": "\x1B[H",
    "End": "\x1B[F",
    "Delete": "\x1B[3~",
    "PageUp": "\x1B[5~",
    "PageDown": "\x1B[6~",
  };

  return keys
    .map((k) => {
      const mapped = keyMap[k];
      if (mapped) return mapped;
      // Ctrl-<letter> pattern
      const ctrlMatch = k.match(/^Ctrl-([a-zA-Z])$/);
      if (ctrlMatch) {
        return String.fromCharCode(ctrlMatch[1].toUpperCase().charCodeAt(0) - 64);
      }
      return k; // literal
    })
    .join("");
}

/**
 * Encode text for paste with optional bracketed paste mode.
 */
export function encodePaste(text: string, bracketed = true): string {
  if (bracketed) {
    return `\x1B[200~${text}\x1B[201~`;
  }
  return text;
}
