/**
 * Sessions Tool
 *
 * Cross-session messaging (sessions_send) and history inspection (sessions_history).
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { db } from "../../db/client.js";
import { avaSessions, avaMessages } from "../../db/schema/index.js";
import { eq, desc, asc } from "drizzle-orm";

const SessionsSchema = Type.Object({
  action: Type.String({
    description: 'Action: "list", "history", or "send"',
  }),
  sessionId: Type.Optional(
    Type.String({ description: "Target session ID (for history and send)" })
  ),
  message: Type.Optional(
    Type.String({ description: "Message to send to the target session (for send)" })
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max messages to return (for history, default 20)" })
  ),
});

type SessionsArgs = Static<typeof SessionsSchema>;

export function createSessionsTool(context: { userId: string; sessionId: string }): ToolDefinition {
  return {
    name: "sessions",
    label: "Sessions",
    description: `List sessions, view session history, or send messages to other sessions.
- list: Show active sessions
- history: View message history for a session
- send: Send a message into another session (triggers agent run)`,
    parameters: SessionsSchema,
    execute: async (
      _toolCallId: string,
      args: SessionsArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (args.action) {
          case "list": {
            const sessions = await db
              .select({
                id: avaSessions.id,
                title: avaSessions.title,
                source: avaSessions.source,
                tokenCount: avaSessions.tokenCount,
                lastMessageAt: avaSessions.lastMessageAt,
              })
              .from(avaSessions)
              .where(eq(avaSessions.status, "active"))
              .orderBy(desc(avaSessions.lastMessageAt))
              .limit(args.limit || 20);

            if (sessions.length === 0) return text("No active sessions.");
            const formatted = sessions.map((s) =>
              `[${s.id}] ${s.title || "Untitled"} (${s.source}, ${s.tokenCount} tokens, last: ${s.lastMessageAt?.toISOString() || "never"})`
            ).join("\n");
            return text(`${sessions.length} active sessions:\n${formatted}`);
          }

          case "history": {
            if (!args.sessionId) return text("Error: sessionId required for history. Use action 'list' first to discover session IDs.");
            const messages = await db
              .select({
                role: avaMessages.role,
                content: avaMessages.content,
                createdAt: avaMessages.createdAt,
              })
              .from(avaMessages)
              .where(eq(avaMessages.sessionId, args.sessionId))
              .orderBy(asc(avaMessages.createdAt))
              .limit(args.limit || 20);

            if (messages.length === 0) return text("No messages in this session.");
            const formatted = messages.map((m) =>
              `[${m.role}] ${(m.content || "").slice(0, 200)}`
            ).join("\n\n");
            return text(`${messages.length} messages:\n\n${formatted}`);
          }

          case "send": {
            if (!args.sessionId) return text("Error: sessionId required for send. Use action 'list' first to discover session IDs.");
            if (!args.message) return text("Error: message required for send. Do not retry without specifying a message.");

            // Enqueue message in target session via gateway queue
            const { queueService } = await import("../../gateway/services/queue.js");
            await queueService.enqueue(args.sessionId, context.userId, args.message, {
              source: "session",
              mode: "followup",
            });

            return text(`Message sent to session ${args.sessionId}. It will be processed when the session is ready.`);
          }

          default:
            return text(`Unknown action: ${args.action}. Valid: list, history, send`);
        }
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
