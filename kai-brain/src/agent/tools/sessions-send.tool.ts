/**
 * Sessions Send Tool
 *
 * Enables agent-to-agent (A2A) communication by sending messages between sessions.
 * Useful for coordinating work across multiple subagents.
 */
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { ToolInputError, readStringParam, readNumberParam } from "./common.js";
import { db } from "../../db/client.js";
import { avaSessions, avaMessages } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import { wakeHeartbeat } from "../../gateway/services/heartbeat.service.js";

export function createSessionsSendTool(): ToolDefinition {
  return {
    name: "sessions_send",
    label: "Send Agent-to-Agent Message",
    description: `Send message to another session (agent-to-agent communication).

Use this when:
- You need to coordinate with another subagent
- You want to notify a running agent of new information
- You need to request status or results from another agent

The target session must be active (activity within last hour).`,
    parameters: Type.Object({
      target_session: Type.String({
        description: "Target session ID",
      }),
      message: Type.String({
        description: "Message to send to the target agent",
      }),
      timeout_seconds: Type.Optional(Type.Number({
        description: "Wait timeout in seconds (default: 30)",
        minimum: 1,
        maximum: 300,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        target_session?: string;
        message?: string;
        timeout_seconds?: number;
      },
    ): Promise<AgentToolResult<unknown>> => {
      const targetSession = readStringParam(params, "target_session", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readNumberParam(params, "timeout_seconds", { default: 30, min: 1, max: 300 }) || 30;

      if (message.length > 4000) {
        throw new ToolInputError("Message too long (max 4000 chars)");
      }

      // Resolve target session
      const session = await db.query.avaSessions.findFirst({
        where: eq(avaSessions.id, targetSession),
      });

      if (!session) {
        return {
          content: [{ type: "text", text: `Session ${targetSession} not found` }],
          details: { error: "not_found" },
        };
      }

      // Check if target is active (last activity within 1 hour)
      const lastActivity = session.lastMessageAt || session.createdAt;
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (lastActivity < hourAgo) {
        return {
          content: [{ type: "text", text: `Session ${targetSession} is inactive (last activity: ${lastActivity.toISOString()})` }],
          details: { error: "inactive", lastActivity: lastActivity.toISOString() },
        };
      }

      // Insert message as system event
      await db.insert(avaMessages).values({
        sessionId: targetSession,
        role: "user",
        content: `[Agent message]: ${message}`,
        createdAt: new Date(),
      });

      // Wake heartbeat to process message
      wakeHeartbeat(targetSession, {
        kind: "agent_message",
        source: "agent",
      });

      return {
        content: [{ type: "text", text: `Sent message to session ${targetSession}` }],
        details: { sent: true, targetSession, timeoutSeconds },
      };
    },
  };
}
