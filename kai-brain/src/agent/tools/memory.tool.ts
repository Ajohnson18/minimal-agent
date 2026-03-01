/**
 * Memory Tool
 *
 * Exposes the memory service to the agent for explicit
 * search, save, list, and delete operations.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  searchMemories,
  storeMemory,
  getUserMemories,
  deleteMemory,
} from "../../services/memory.service.js";

const MemorySchema = Type.Object({
  action: Type.String({
    description: 'Action: "search", "save", "list", "delete"',
  }),
  query: Type.Optional(
    Type.String({ description: "Search query (for action=search)" })
  ),
  content: Type.Optional(
    Type.String({
      description: "Memory content to save (for action=save)",
    })
  ),
  source: Type.Optional(
    Type.String({
      description:
        'Memory source type: "fact", "note", "conversation" (for action=save, default "fact")',
    })
  ),
  importance: Type.Optional(
    Type.Number({
      description:
        "Importance score 0-1 (for action=save, default 0.5). Use higher for critical facts.",
      minimum: 0,
      maximum: 1,
    })
  ),
  memoryId: Type.Optional(
    Type.String({ description: "Memory ID to delete (for action=delete)" })
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results (for action=search/list, default 5/10)",
    })
  ),
});

type MemoryArgs = Static<typeof MemorySchema>;

export function createMemoryTool(context: {
  userId: string;
  sessionId: string;
}): ToolDefinition {
  return {
    name: "memory",
    label: "Memory",
    description: `Search, save, list, or delete long-term memories.
Use this to:
- search: Find remembered facts, preferences, prior decisions
- save: Store important facts about the user (preferences, decisions, context)
- list: See recent memories
- delete: Remove outdated or incorrect memories`,
    parameters: MemorySchema,
    execute: async (
      _toolCallId: string,
      args: MemoryArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (args.action) {
          case "search": {
            if (!args.query) return text("Error: query is required for search. Do not retry without a search query.");
            const limit = args.limit ?? 5;
            const results = await searchMemories(
              context.userId,
              args.query,
              limit
            );
            if (results.length === 0) {
              return text("No matching memories found.");
            }
            const formatted = results
              .map(
                (r, i) =>
                  `${i + 1}. [${r.id}] (score=${r.score.toFixed(2)}, importance=${r.importance}) ${r.content}`
              )
              .join("\n");
            return text(`Found ${results.length} memories:\n${formatted}`);
          }

          case "save": {
            if (!args.content) return text("Error: content is required for save. Do not retry without specifying content to save.");
            const source = (args.source || "fact") as
              | "fact"
              | "note"
              | "conversation";
            const importance = args.importance ?? 0.5;
            const id = await storeMemory(
              context.userId,
              args.content,
              source,
              context.sessionId,
              importance
            );
            return text(`Memory saved (id=${id}).`);
          }

          case "list": {
            const limit = args.limit ?? 10;
            const memories = await getUserMemories(context.userId, limit);
            if (memories.length === 0) {
              return text("No memories stored yet.");
            }
            const formatted = memories
              .map(
                (m) =>
                  `[${m.id}] (${m.source}, importance=${m.importance}) ${m.content}`
              )
              .join("\n");
            return text(`${memories.length} memories:\n${formatted}`);
          }

          case "delete": {
            if (!args.memoryId) return text("Error: memoryId is required for delete. Use search or list to find memory IDs first.");
            await deleteMemory(args.memoryId);
            return text(`Memory ${args.memoryId} deleted.`);
          }

          default:
            return text(
              `Unknown action: ${args.action}. Valid: search, save, list, delete`
            );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text(`Memory error: ${msg}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
