/**
 * PostgreSQL Session Adapter for Pi-Agent
 *
 * This module bridges pi-agent's session expectations with our PostgreSQL storage.
 * Pi-agent uses file-based SessionManager internally. We:
 * 1. Load messages from PostgreSQL before agent execution
 * 2. Convert between DB format and pi-ai Message format
 * 3. Save messages back to PostgreSQL after execution
 */
import { db } from "../db/client.js";
import {
  avaSessions,
  avaMessages,
  type ToolCall as DbToolCall,
  type AvaMessage,
} from "../db/schema/index.js";
import { eq, and, asc, inArray } from "drizzle-orm";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";

// AgentMessage from pi-coding-agent extends Message with additional session-specific types
// We use a simple 'any' to handle the complex union type from the session
type AnyMessage = any;

const MESSAGE_TEXT_MAX_CHARS = 12_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clampMessageText(value: string): string {
  if (value.length <= MESSAGE_TEXT_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, MESSAGE_TEXT_MAX_CHARS)}\n...(truncated)...`;
}

function sanitizeStructuredContentBlocks(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const blocks: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const next: Record<string, unknown> = { ...record };
    if (typeof next.text === "string") {
      const trimmed = next.text.trim();
      if (!trimmed) {
        continue;
      }
      next.text = clampMessageText(trimmed);
    }

    const rawData =
      typeof next.data === "string"
        ? next.data
        : typeof next.base64 === "string"
          ? next.base64
          : typeof next.contentBase64 === "string"
            ? next.contentBase64
            : undefined;
    if (rawData) {
      const bytes = Buffer.byteLength(rawData, "utf8");
      delete next.data;
      delete next.base64;
      delete next.contentBase64;
      next.omitted = true;
      next.bytes = bytes;
    }

    blocks.push(next);
  }

  return blocks.length > 0 ? blocks : undefined;
}

function extractMessageMetadata(msg: Message): Record<string, unknown> {
  const metadata = asRecord((msg as { metadata?: unknown }).metadata);
  return metadata ? { ...metadata } : {};
}

/**
 * Adapter to bridge pi-agent's session expectations with PostgreSQL storage.
 */
export class PostgresSessionAdapter {
  constructor(private sessionId: string) {}

  /**
   * Load messages from PostgreSQL and convert to pi-ai format.
   * Only loads non-compacted messages.
   */
  async loadMessages(): Promise<Message[]> {
    const dbMessages = await db
      .select()
      .from(avaMessages)
      .where(
        and(
          eq(avaMessages.sessionId, this.sessionId),
          eq(avaMessages.isCompacted, false),
        ),
      )
      .orderBy(asc(avaMessages.createdAt));

    return dbMessagesToPiMessages(dbMessages);
  }

  /**
   * Save new messages to PostgreSQL.
   * This only saves messages that don't already exist (by comparing timestamps).
   */
  async saveMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    await db.transaction(async (tx) => {
      for (const msg of messages) {
        const dbMsg = piMessageToDbMessage(msg, this.sessionId);
        await tx.insert(avaMessages).values(dbMsg);
      }

      // Update session's lastMessageAt
      await tx
        .update(avaSessions)
        .set({ lastMessageAt: new Date() })
        .where(eq(avaSessions.id, this.sessionId));
    });
  }

  /**
   * Save a single message to PostgreSQL.
   * Uses transaction to ensure atomic insert + session update.
   */
  async saveMessage(message: Message): Promise<void> {
    const dbMsg = piMessageToDbMessage(message, this.sessionId);
    await db.transaction(async (tx) => {
      await tx.insert(avaMessages).values(dbMsg);
      await tx
        .update(avaSessions)
        .set({ lastMessageAt: new Date() })
        .where(eq(avaSessions.id, this.sessionId));
    });
  }

  /**
   * Clear all messages for this session (used during auto-compaction).
   */
  async clearMessages(): Promise<void> {
    await db
      .delete(avaMessages)
      .where(eq(avaMessages.sessionId, this.sessionId));
  }

  /**
   * Get session metadata.
   */
  async getSessionMetadata() {
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.id, this.sessionId));
    return session;
  }

  /**
   * Update session's context summary (used after compaction).
   */
  async updateContextSummary(summary: string): Promise<void> {
    await db
      .update(avaSessions)
      .set({ contextSummary: summary })
      .where(eq(avaSessions.id, this.sessionId));
  }

  /**
   * Mark messages as compacted.
   * Uses batch update for efficiency (single query instead of N queries).
   */
  async markMessagesCompacted(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    await db
      .update(avaMessages)
      .set({ isCompacted: true })
      .where(inArray(avaMessages.id, messageIds));
  }
}

/**
 * Convert database messages to pi-ai Message format.
 */
export function dbMessagesToPiMessages(dbMessages: AvaMessage[]): Message[] {
  const result: Message[] = [];

  for (const dbMsg of dbMessages) {
    const piMsg = dbMessageToPiMessage(dbMsg);
    if (piMsg) {
      result.push(piMsg);
    }
  }

  return result;
}

/**
 * Convert a single database message to pi-ai Message format.
 */
function dbMessageToPiMessage(dbMsg: AvaMessage): Message | null {
  const timestamp = dbMsg.createdAt.getTime();

  switch (dbMsg.role) {
    case "user":
      return {
        id: dbMsg.id,
        role: "user",
        content: dbMsg.content || "",
        timestamp,
      } as UserMessage;

    case "assistant":
      // Build content array from text + tool calls
      const content: (TextContent | PiToolCall)[] = [];

      if (dbMsg.content) {
        content.push({
          type: "text",
          text: dbMsg.content,
        });
      }

      // Convert tool calls
      if (dbMsg.toolCalls && dbMsg.toolCalls.length > 0) {
        for (const tc of dbMsg.toolCalls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments) as Record<
              string,
              unknown
            >;
          } catch (e) {
            console.error(
              "Failed to parse tool call arguments:",
              tc.function.arguments,
            );
          }
          content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.function.name,
            arguments: parsedArgs,
          });
        }
      }

      return {
        id: dbMsg.id,
        role: "assistant",
        content,
        api: "google-vertex", // Default, will be overwritten by actual response
        provider: "google",
        model: "gemini-2.0-flash",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: dbMsg.tokenCount || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      } as AssistantMessage;

    case "tool":
      // Tool result message
      return {
        id: dbMsg.id,
        role: "toolResult",
        toolCallId: dbMsg.toolCallId || "",
        toolName: dbMsg.name || "",
        content: [
          {
            type: "text",
            text: dbMsg.content || "",
          },
        ],
        isError: false, // We don't store this in DB currently
        timestamp,
      } as ToolResultMessage;

    case "system":
      // System messages are handled separately as systemPrompt
      // Pi-ai doesn't have a system message type in the messages array
      return null;

    default:
      console.warn(`Unknown message role: ${dbMsg.role}`);
      return null;
  }
}

/**
 * Convert a pi-ai Message to database message format.
 */
export function piMessageToDbMessage(
  msg: Message,
  sessionId: string,
): Omit<AvaMessage, "id" | "createdAt"> & { createdAt?: Date } {
  const metadata = extractMessageMetadata(msg);
  const base = {
    sessionId,
    createdAt: new Date(msg.timestamp),
    isCompacted: false,
    metadata,
  };

  switch (msg.role) {
    case "user": {
      const userMsg = msg as UserMessage;
      const content =
        typeof userMsg.content === "string"
          ? userMsg.content
          : userMsg.content
              .filter((c) => c.type === "text")
              .map((c) => (c as TextContent).text)
              .join("\n");
      const explicitStructuredContent = sanitizeStructuredContentBlocks(base.metadata.structuredContent);
      const inferredStructuredContent =
        explicitStructuredContent ?? sanitizeStructuredContentBlocks(userMsg.content);
      const nextMetadata =
        inferredStructuredContent && inferredStructuredContent.length > 0
          ? {
              ...base.metadata,
              structuredContent: inferredStructuredContent,
            }
          : base.metadata;

      return {
        ...base,
        role: "user",
        content,
        toolCalls: null,
        toolCallId: null,
        name: null,
        tokenCount: null,
        metadata: nextMetadata,
      };
    }

    case "assistant": {
      const assistantMsg = msg as AssistantMessage;

      // Extract text content
      const textParts = assistantMsg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as TextContent).text);
      const content = textParts.join("");

      // Extract tool calls
      const toolCalls: DbToolCall[] = assistantMsg.content
        .filter((c) => c.type === "toolCall")
        .map((c) => {
          const tc = c as PiToolCall;
          return {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          };
        });

      return {
        ...base,
        role: "assistant",
        content: content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        toolCallId: null,
        name: null,
        tokenCount: assistantMsg.usage?.totalTokens || null,
      };
    }

    case "toolResult": {
      const toolMsg = msg as ToolResultMessage;
      const content = toolMsg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as TextContent).text)
        .join("\n");

      return {
        ...base,
        role: "tool",
        content,
        toolCalls: null,
        toolCallId: toolMsg.toolCallId,
        name: toolMsg.toolName,
        tokenCount: null,
      };
    }

    default:
      throw new Error(`Unknown message role: ${(msg as any).role}`);
  }
}

/**
 * Extract only text content from an assistant message.
 * Accepts any message array to handle pi-coding-agent's extended message types.
 */
export function extractAssistantText(messages: AnyMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      const textParts = assistantMsg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as TextContent).text);
      return textParts.join("");
    }
  }
  return "";
}

/**
 * Extract tool calls from messages.
 * Accepts any message array to handle pi-coding-agent's extended message types.
 */
export function extractToolCalls(messages: AnyMessage[]): PiToolCall[] {
  const toolCalls: PiToolCall[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      for (const c of assistantMsg.content) {
        if (c.type === "toolCall") {
          toolCalls.push(c as PiToolCall);
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Filter messages to only include standard Message types.
 * Excludes pi-coding-agent specific types like CustomMessage, BashExecutionMessage, etc.
 */
export function filterToMessages(messages: AnyMessage[]): Message[] {
  return messages.filter((msg) => {
    // Keep user, assistant, and toolResult messages
    return (
      msg.role === "user" ||
      msg.role === "assistant" ||
      msg.role === "toolResult"
    );
  }) as Message[];
}

/**
 * Repair tool_use/tool_result pairing in session history.
 *
 * Claude requires every tool_use block to have a matching tool_result
 * IMMEDIATELY after the assistant message. This function:
 * - Moves matching toolResult messages directly after their assistant toolCall turn
 * - Inserts synthetic error toolResults for missing ids
 * - Drops duplicate toolResults for the same id
 * - Drops orphaned toolResults that don't match any tool_use
 */
export function repairToolUseResultPairing(messages: Message[]): Message[] {
  type ToolCallLike = { id: string; name?: string };

  function extractToolCallsFromAssistant(
    msg: AssistantMessage,
  ): ToolCallLike[] {
    if (!Array.isArray(msg.content)) return [];
    const calls: ToolCallLike[] = [];
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      const rec = block as { type?: string; id?: string; name?: string };
      if (!rec.id) continue;
      if (
        rec.type === "toolCall" ||
        rec.type === "toolUse" ||
        rec.type === "functionCall"
      ) {
        calls.push({ id: rec.id, name: rec.name });
      }
    }
    return calls;
  }

  function extractToolResultId(msg: ToolResultMessage): string | null {
    return msg.toolCallId || null;
  }

  function makeMissing(toolCallId: string, toolName?: string): Message {
    return {
      role: "toolResult",
      toolCallId,
      toolName: toolName ?? "unknown",
      content: [
        {
          type: "text",
          text: "[session repair] Tool result unavailable (previous run interrupted before completion).",
        },
      ],
      isError: false,
      timestamp: Date.now(),
    } as ToolResultMessage;
  }

  const out: Message[] = [];
  const seenToolResultIds = new Set<string>();

  const pushToolResult = (msg: ToolResultMessage) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) return; // drop duplicate
    if (id) seenToolResultIds.add(id);
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;

    if (role !== "assistant") {
      // Drop free-floating toolResult entries — they'll be placed after their assistant
      if (role !== "toolResult") out.push(msg);
      continue;
    }

    const assistant = msg as AssistantMessage;
    const stopReason = (assistant as unknown as Record<string, unknown>)
      .stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(msg);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    // Scan forward for matching tool results in the span until next assistant
    const spanResults = new Map<string, ToolResultMessage>();
    const remainder: Message[] = [];

    let j = i + 1;
    for (; j < messages.length; j++) {
      const next = messages[j];
      if (next.role === "assistant") break;

      if (next.role === "toolResult") {
        const tr = next as ToolResultMessage;
        const id = extractToolResultId(tr);
        if (
          id &&
          toolCallIds.has(id) &&
          !seenToolResultIds.has(id) &&
          !spanResults.has(id)
        ) {
          spanResults.set(id, tr);
          continue;
        }
        // Drop orphaned or duplicate tool results
        continue;
      }

      remainder.push(next);
    }

    out.push(msg);

    // Place tool results in tool_call order, inserting synthetic ones for missing
    for (const call of toolCalls) {
      const existing = spanResults.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        pushToolResult(makeMissing(call.id, call.name) as ToolResultMessage);
      }
    }

    // Re-add non-toolResult messages from the span
    for (const rem of remainder) {
      out.push(rem);
    }

    i = j - 1; // skip the span we already processed
  }

  return out;
}
