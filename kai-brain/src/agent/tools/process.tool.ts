/**
 * Process Tool
 *
 * Manages background exec sessions.
 * Actions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  listSessions,
  getSession,
  getFinishedSession,
  drainSession,
  killSession,
  clearFinished,
  encodeKeySequence,
  encodePaste,
} from "./process-registry.js";

const ProcessSchema = Type.Object({
  action: Type.String({
    description:
      'Action: "list", "poll", "log", "write", "send-keys", "submit", "paste", "kill", "clear", "remove"',
  }),
  sessionId: Type.Optional(
    Type.String({ description: "Session ID (required for all actions except list)" })
  ),
  data: Type.Optional(
    Type.String({ description: "Data to write to stdin (for action=write)" })
  ),
  eof: Type.Optional(
    Type.Boolean({ description: "Close stdin after writing (for action=write)" })
  ),
  offset: Type.Optional(
    Type.Number({ description: "Line offset for log output (for action=log)" })
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max lines to return (for action=log)" })
  ),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key tokens for send-keys (e.g. ["Ctrl-C", "Enter", "Up"])',
    })
  ),
  text: Type.Optional(
    Type.String({ description: "Text to paste (for action=paste)" })
  ),
});

type ProcessArgs = Static<typeof ProcessSchema>;

export function createProcessTool(): ToolDefinition {
  return {
    name: "process",
    label: "Process",
    description: `Manage background exec sessions.

Actions:
- list: List all running and finished sessions
- poll: Get new output since last poll (sessionId required)
- log: Get full aggregated output with offset/limit (sessionId required)
- write: Write data to stdin (sessionId required)
- send-keys: Send key sequences like Ctrl-C, arrow keys (sessionId required, keys=["Ctrl-C"])
- submit: Press Enter/Return (sessionId required)
- paste: Paste text with bracketed paste mode (sessionId required, text="...")
- kill: Kill a running session (sessionId required)
- clear: Remove a finished session (sessionId required)
- remove: Kill if running, or clear if finished (sessionId required)`,
    parameters: ProcessSchema,
    execute: async (
      _toolCallId: string,
      args: ProcessArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      const { action, sessionId } = args;

      if (action === "list") {
        const { running, finished } = listSessions();
        const parts: string[] = [];
        if (running.length === 0 && finished.length === 0) {
          return text("No active or recent sessions.");
        }
        if (running.length > 0) {
          parts.push("Running:");
          for (const s of running) {
            parts.push(`  [${s.id}] ${s.command} (pid=${s.pid}, bg=${s.backgrounded})`);
          }
        }
        if (finished.length > 0) {
          parts.push("Finished:");
          for (const s of finished) {
            parts.push(`  [${s.id}] ${s.command} (status=${s.status}, exit=${s.exitCode})`);
          }
        }
        return text(parts.join("\n"));
      }

      if (!sessionId) {
        return text("Error: sessionId is required for this action. Use action 'list' first to see available session IDs.");
      }

      switch (action) {
        case "poll": {
          const session = getSession(sessionId);
          if (session) {
            const { stdout, stderr } = drainSession(session);
            const parts: string[] = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(`STDERR:\n${stderr}`);
            if (session.exited) parts.push(`\nProcess exited with code ${session.exitCode}`);
            return text(parts.join("\n") || (session.exited ? `Exited (code=${session.exitCode})` : "No new output."));
          }
          const fin = getFinishedSession(sessionId);
          if (fin) return text(`Session finished (status=${fin.status}, exit=${fin.exitCode}). Use action="log" to see full output.`);
          return text(`Session ${sessionId} not found.`);
        }

        case "log": {
          const session = getSession(sessionId);
          const fin = getFinishedSession(sessionId);
          const aggregated = session?.aggregated ?? fin?.aggregated;
          if (aggregated === undefined) return text(`Session ${sessionId} not found.`);
          const lines = aggregated.split("\n");
          const offset = args.offset ?? 0;
          const limit = args.limit ?? lines.length;
          return text(lines.slice(offset, offset + limit).join("\n") || "(empty output)");
        }

        case "write": {
          const session = getSession(sessionId);
          if (!session || session.exited) return text(`Session ${sessionId} not found or already exited.`);
          if (!session.backgrounded) return text("Session is not backgrounded.");
          const stdin = session.stdin || (session.child?.stdin?.writable ? { write: (d: string, cb?: (e?: Error | null) => void) => session.child!.stdin.write(d, cb), end: () => session.child!.stdin.end() } : null);
          if (!stdin || stdin.destroyed) return text("stdin is not writable.");
          if (args.data) stdin.write(args.data);
          if (args.eof) stdin.end();
          return text("Written to stdin.");
        }

        case "send-keys": {
          const session = getSession(sessionId);
          if (!session || session.exited) return text(`Session ${sessionId} not found or already exited.`);
          if (!session.backgrounded) return text("Session is not backgrounded.");
          const keys = args.keys;
          if (!keys || keys.length === 0) return text("Error: keys array is required for send-keys (e.g. [\"Ctrl-C\", \"Enter\"]). Do not retry without specifying keys.");
          const encoded = encodeKeySequence(keys);
          const stdin = session.stdin || (session.child?.stdin?.writable ? { write: (d: string, cb?: (e?: Error | null) => void) => session.child!.stdin.write(d, cb), end: () => session.child!.stdin.end() } : null);
          if (!stdin || stdin.destroyed) return text("stdin is not writable.");
          stdin.write(encoded);
          return text(`Sent keys: ${keys.join(", ")}`);
        }

        case "submit": {
          const session = getSession(sessionId);
          if (!session || session.exited) return text(`Session ${sessionId} not found or already exited.`);
          if (!session.backgrounded) return text("Session is not backgrounded.");
          const stdin = session.stdin || (session.child?.stdin?.writable ? { write: (d: string, cb?: (e?: Error | null) => void) => session.child!.stdin.write(d, cb), end: () => session.child!.stdin.end() } : null);
          if (!stdin || stdin.destroyed) return text("stdin is not writable.");
          stdin.write("\r");
          return text("Submitted (Enter pressed).");
        }

        case "paste": {
          const session = getSession(sessionId);
          if (!session || session.exited) return text(`Session ${sessionId} not found or already exited.`);
          if (!session.backgrounded) return text("Session is not backgrounded.");
          if (!args.text) return text("Error: text is required for paste. Do not retry without specifying text to paste.");
          const stdin = session.stdin || (session.child?.stdin?.writable ? { write: (d: string, cb?: (e?: Error | null) => void) => session.child!.stdin.write(d, cb), end: () => session.child!.stdin.end() } : null);
          if (!stdin || stdin.destroyed) return text("stdin is not writable.");
          const payload = encodePaste(args.text);
          stdin.write(payload);
          return text(`Pasted ${args.text.length} characters.`);
        }

        case "kill": {
          const killed = killSession(sessionId);
          return text(killed ? `Session ${sessionId} killed.` : `Session ${sessionId} not found or already exited.`);
        }

        case "clear": {
          const cleared = clearFinished(sessionId);
          return text(cleared ? `Session ${sessionId} cleared.` : `Session ${sessionId} not found in finished sessions.`);
        }

        case "remove": {
          const session = getSession(sessionId);
          if (session && !session.exited) {
            killSession(sessionId);
            return text(`Session ${sessionId} killed and removed.`);
          }
          const cleared = clearFinished(sessionId);
          return text(cleared ? `Session ${sessionId} cleared.` : `Session ${sessionId} not found.`);
        }

        default:
          return text(`Unknown action: ${action}. Valid: list, poll, log, write, send-keys, submit, paste, kill, clear, remove`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
