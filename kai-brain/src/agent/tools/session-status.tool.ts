/**
 * Session Status Tool
 *
 * Shows current session info: model, usage, cost, thinking level.
 * Allows per-session model override.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { db } from "../../db/client.js";
import { getConfig } from "../../lib/config-loader.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { eq } from "drizzle-orm";

const SessionStatusSchema = Type.Object({
  action: Type.Optional(
    Type.String({ description: 'Action: "status" (default) or "set_model" to change the model for this session' })
  ),
  model: Type.Optional(
    Type.String({ description: "Model ID to set for this session (for action=set_model)" })
  ),
});

type SessionStatusArgs = Static<typeof SessionStatusSchema>;

export function createSessionStatusTool(context: { userId: string; sessionId: string }): ToolDefinition {
  return {
    name: "session_status",
    label: "Session Status",
    description: `Show current session status (model, tokens, thinking level) or change the session model.`,
    parameters: SessionStatusSchema,
    execute: async (
      _toolCallId: string,
      args: SessionStatusArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const [session] = await db.select().from(avaSessions).where(eq(avaSessions.id, context.sessionId)).limit(1);
        if (!session) return text("No active session.");

        const metadata = (session.metadata || {}) as Record<string, unknown>;

        if (args.action === "set_model" && args.model) {
          metadata.modelOverride = args.model;
          await db.update(avaSessions).set({ metadata }).where(eq(avaSessions.id, context.sessionId));
          return text(`Model set to: ${args.model} for this session.`);
        }

        const info = [
          `Session: ${session.id}`,
          `User: ${context.userId}`,
          `Source: ${session.source}`,
          `Tokens: ${session.tokenCount}`,
          `Model: ${(metadata.modelOverride as string) || getConfig().agent.model.primary || "default"}`,
          `Thinking: ${(metadata.thinkingLevel as string) || "off"}`,
          `Created: ${session.createdAt?.toISOString()}`,
          `Last message: ${session.lastMessageAt?.toISOString() || "never"}`,
        ].join("\n");

        return text(info);
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
