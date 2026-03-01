/**
 * Chat Methods
 *
 * WebSocket-native chat surface for Web UI:
 * - chat.send
 * - chat.history
 * - chat.abort
 */
import { and, desc, eq } from "drizzle-orm";
import type { ImageContent } from "@mariozechner/pi-ai";
import { executeAgentWithPi, type AgentEvent } from "../../agent/executor-pi.js";
import { resolveUserContext } from "../../agent/user-context.js";
import { parseControlEnvelopeWithLegacyFallback, toDeliveryControl } from "../../core/control-envelope.js";
import { db } from "../../db/client.js";
import { avaMessages, avaSessions } from "../../db/schema/index.js";
import { getConfig } from "../../lib/config-loader.js";
import type { RpcError } from "../protocol/types.js";
import { createError, ErrorCodes } from "../protocol/types.js";
import { normalizeRpcAttachmentsToChatAttachments } from "../attachment-normalize.js";
import { parseChatAttachments, type AttachmentHistoryBlock } from "../chat-attachments.js";
import type {
  ChatAbortParams,
  ChatAbortResult,
  ChatHistoryParams,
  ChatHistoryResult,
  ChatSendParams,
  ChatSendResult,
  ChatSendStatus,
} from "../protocol/methods.js";
import { GATEWAY_CLIENT_CAPS } from "../protocol/client-info.js";
import { runtime } from "../runtime.js";
import {
  resolveGatewaySessionIdentity,
  resolveGatewaySessionIdentityForUser,
} from "../services/session-identity.js";

const CHAT_HISTORY_LIMIT_DEFAULT = 200;
const CHAT_HISTORY_LIMIT_MAX = 1000;
const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_MAX_TOTAL_BYTES = 512 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const GATEWAY_CHAT_CONFIG = getConfig().gateway.chat;
const TOOL_EVENT_MAX_BYTES = GATEWAY_CHAT_CONFIG.toolEventMaxBytes;
const THINKING_STREAM_MIN_INTERVAL_MS = GATEWAY_CHAT_CONFIG.thinking.streamMinIntervalMs;
const THINKING_STREAM_TEXT_MAX_CHARS = GATEWAY_CHAT_CONFIG.thinking.textMaxChars;
const THINKING_STREAM_INCLUDE_TEXT = GATEWAY_CHAT_CONFIG.thinking.includeText;
const CHAT_ATTACHMENT_LIMITS = GATEWAY_CHAT_CONFIG.attachments;

type TagStreamMode = "strip-tags" | "hide-thinking";

type TagStreamState = {
  mode: TagStreamMode;
  pendingTag: string;
  hiddenThinkingDepth: number;
};

const THINKING_TAG_PATTERN = /^<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>$/i;
const FINAL_TAG_PATTERN = /^<\s*\/?\s*final\b[^>]*>$/i;
const INLINE_DIRECTIVE_PATTERN =
  /\[\[\s*(?:audio_as_voice|reply_to_current|reply_to\s*:[^\]\n]+)\s*\]\]/gi;

function createTagStreamState(mode: TagStreamMode): TagStreamState {
  return {
    mode,
    pendingTag: "",
    hiddenThinkingDepth: 0,
  };
}

function sanitizeDeltaDisplayText(text: string): string {
  const cleaned = text.replace(INLINE_DIRECTIVE_PATTERN, "");
  const trimmed = cleaned.trim();
  if (trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK" || trimmed === "ANNOUNCE_SKIP") {
    return "";
  }
  return cleaned;
}

function stripTaggedStreamChunkForDisplay(chunk: string, state: TagStreamState): string {
  if (!chunk) {
    return "";
  }

  let visible = "";
  const appendVisible = (text: string) => {
    if (!text) return;
    if (state.mode === "hide-thinking" && state.hiddenThinkingDepth > 0) {
      return;
    }
    visible += text;
  };

  const consumeTag = (tag: string) => {
    if (FINAL_TAG_PATTERN.test(tag)) {
      return;
    }

    const thinkingMatch = tag.match(THINKING_TAG_PATTERN);
    if (thinkingMatch) {
      if (state.mode === "hide-thinking") {
        if (thinkingMatch[1] === "/") {
          state.hiddenThinkingDepth = Math.max(0, state.hiddenThinkingDepth - 1);
        } else {
          state.hiddenThinkingDepth += 1;
        }
      }
      return;
    }

    appendVisible(tag);
  };

  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];

    if (state.pendingTag) {
      state.pendingTag += char;

      if (state.pendingTag.length === 2) {
        const second = state.pendingTag[1];
        if (!/[a-zA-Z/]/.test(second)) {
          appendVisible(state.pendingTag);
          state.pendingTag = "";
          continue;
        }
      }

      if (char === ">") {
        const completedTag = state.pendingTag;
        state.pendingTag = "";
        consumeTag(completedTag);
      } else if (state.pendingTag.length > 256) {
        appendVisible(state.pendingTag);
        state.pendingTag = "";
      }

      continue;
    }

    if (char === "<") {
      const next = chunk[index + 1];
      if (typeof next === "undefined") {
        state.pendingTag = "<";
        continue;
      }
      if (/[a-zA-Z/]/.test(next)) {
        state.pendingTag = "<";
        continue;
      }
    }

    appendVisible(char);
  }

  return sanitizeDeltaDisplayText(visible);
}

export const __chatStreamInternals = {
  createTagStreamState,
  stripTaggedStreamChunkForDisplay,
};
const FAKE_AGENT_MODE = process.env.AVA_TEST_FAKE_AGENT_MODE === "1";
const FAKE_AGENT_DELAY_MS = (() => {
  const parsed = Number(process.env.AVA_TEST_FAKE_AGENT_DELAY_MS ?? "40");
  if (!Number.isFinite(parsed)) {
    return 40;
  }
  return Math.min(500, Math.max(1, Math.floor(parsed)));
})();

type IdempotencyEntry = {
  runId: string;
  status: ChatSendStatus;
  expiresAt: number;
};

type ToolVerboseLevel = "off" | "on" | "full";

type ChatRichContentBlock = Record<string, unknown>;

type ChatRichMessage = {
  id?: string;
  role: string;
  timestamp: number;
  content: ChatRichContentBlock[];
  omitted?: boolean;
  truncated?: boolean;
};

const idempotencyCache = new Map<string, IdempotencyEntry>();

function nowMs(): number {
  return Date.now();
}

function idempotencyCacheKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId}:${idempotencyKey}`;
}

function pruneIdempotencyCache(now = nowMs()): void {
  for (const [key, value] of idempotencyCache.entries()) {
    if (value.expiresAt <= now) {
      idempotencyCache.delete(key);
    }
  }
}

function readIdempotencyStatus(
  sessionId: string,
  idempotencyKey: string,
): IdempotencyEntry | null {
  pruneIdempotencyCache();
  return idempotencyCache.get(idempotencyCacheKey(sessionId, idempotencyKey)) ?? null;
}

function setIdempotencyStatus(
  sessionId: string,
  idempotencyKey: string,
  entry: Pick<IdempotencyEntry, "runId" | "status">,
): void {
  idempotencyCache.set(idempotencyCacheKey(sessionId, idempotencyKey), {
    ...entry,
    expiresAt: nowMs() + IDEMPOTENCY_TTL_MS,
  });
}

function normalizeToolVerboseLevel(raw: unknown): ToolVerboseLevel {
  if (typeof raw !== "string") {
    return "off";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "full") {
    return "full";
  }
  if (
    normalized === "on" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes"
  ) {
    return "on";
  }
  return "off";
}

async function resolveSessionToolVerboseLevel(sessionId: string): Promise<ToolVerboseLevel> {
  try {
    const [session] = await db
      .select({ metadata: avaSessions.metadata })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);

    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    return normalizeToolVerboseLevel(metadata.verboseLevel);
  } catch {
    return "off";
  }
}

function sanitizeText(input: string | null | undefined): { text: string; truncated: boolean } {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { text: "", truncated: false };
  }

  let text = raw;
  const envelope = parseControlEnvelopeWithLegacyFallback(raw);
  if (envelope) {
    const control = toDeliveryControl(envelope, raw);
    text = control.mode === "deliver" ? control.text : "";
  }

  // Hide legacy control tokens from display.
  if (text === "NO_REPLY" || text === "HEARTBEAT_OK" || text === "ANNOUNCE_SKIP") {
    text = "";
  }

  if (text.length > CHAT_HISTORY_TEXT_MAX_CHARS) {
    return {
      text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
      truncated: true,
    };
  }
  return { text, truncated: false };
}

function normalizeChatMessageInput(input: string): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = input.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: normalized };
}

function utf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeFakeChat(params: {
  message: string;
  abortSignal?: AbortSignal;
  onDelta: (chunk: string) => void;
}): Promise<{
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
  const chunks = ["[fake] ", "stream ", "complete"];
  let streamed = "";
  for (const chunk of chunks) {
    if (params.abortSignal?.aborted) {
      throw new Error("Chat run aborted");
    }
    await sleep(FAKE_AGENT_DELAY_MS);
    if (params.abortSignal?.aborted) {
      throw new Error("Chat run aborted");
    }
    params.onDelta(chunk);
    streamed += chunk;
  }

  const content = `${streamed.trim()} (${params.message.trim()})`;
  return {
    content,
    usage: {
      inputTokens: Math.max(1, params.message.length),
      outputTokens: Math.max(1, content.length),
      totalTokens: Math.max(2, params.message.length + content.length),
    },
  };
}

function buildOversizedPlaceholder(
  message: Pick<ChatRichMessage, "id" | "role" | "timestamp">,
): ChatRichMessage {
  return {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    omitted: true,
  };
}

function buildChatTextMessage(params: {
  role?: string;
  text: string;
  timestamp?: number;
  id?: string;
  truncated?: boolean;
}): ChatRichMessage {
  return {
    ...(params.id ? { id: params.id } : {}),
    role: params.role ?? "assistant",
    timestamp: params.timestamp ?? nowMs(),
    content: [{ type: "text", text: params.text }],
    ...(params.truncated ? { truncated: true } : {}),
  };
}

function sanitizeHistoryContentBlocksFromMetadata(metadata: unknown): ChatRichContentBlock[] | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const rawBlocks = (metadata as { structuredContent?: unknown }).structuredContent;
  if (!Array.isArray(rawBlocks)) {
    return null;
  }

  const sanitizedBlocks: ChatRichContentBlock[] = [];
  for (const rawBlock of rawBlocks) {
    if (!rawBlock || typeof rawBlock !== "object") {
      continue;
    }
    const block = { ...(rawBlock as Record<string, unknown>) };

    if (typeof block.text === "string") {
      const sanitizedText = sanitizeText(block.text);
      if (!sanitizedText.text) {
        continue;
      }
      block.text = sanitizedText.text;
      if (sanitizedText.truncated) {
        block.truncated = true;
      }
    }

    const rawData =
      typeof block.data === "string"
        ? block.data
        : typeof block.base64 === "string"
          ? block.base64
          : typeof block.contentBase64 === "string"
            ? block.contentBase64
            : undefined;

    if (rawData) {
      const bytes = typeof block.bytes === "number" && Number.isFinite(block.bytes)
        ? block.bytes
        : Buffer.byteLength(rawData, "utf8");
      delete block.data;
      delete block.base64;
      delete block.contentBase64;
      block.omitted = true;
      block.bytes = bytes;
    }

    sanitizedBlocks.push(block);
  }

  return sanitizedBlocks.length > 0 ? sanitizedBlocks : null;
}

function buildAgentPromptFromInput(message: string, hasAttachments: boolean, docContext?: string): string {
  const trimmedMessage = message.trim();
  const promptBase = trimmedMessage || (hasAttachments ? "Please review the attached content." : "");
  if (!docContext) {
    return promptBase;
  }
  const header = "Attached document context:";
  return [promptBase, header, docContext].filter(Boolean).join("\n\n");
}

function buildStructuredUserContent(
  message: string,
  attachmentBlocks: AttachmentHistoryBlock[],
): ChatRichContentBlock[] | undefined {
  const blocks: ChatRichContentBlock[] = [];
  const trimmedMessage = message.trim();
  if (trimmedMessage) {
    blocks.push({ type: "text", text: trimmedMessage });
  }
  for (const block of attachmentBlocks) {
    blocks.push({ ...block });
  }
  return blocks.length > 0 ? blocks : undefined;
}

function emitChatEvent(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  seq: number;
  message?: ChatRichMessage;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
  originClientId: string;
  dropIfSlow?: boolean;
}): void {
  runtime.broadcast(
    {
      event: "chat",
      payload: {
        runId: params.runId,
        sessionKey: params.sessionKey,
        seq: params.seq,
        state: params.state,
        ...(params.message ? { message: params.message } : {}),
        ...(typeof params.errorMessage === "string"
          ? { errorMessage: params.errorMessage }
          : {}),
        ...(typeof params.usage !== "undefined" ? { usage: params.usage } : {}),
        ...(typeof params.stopReason === "string" ? { stopReason: params.stopReason } : {}),
      },
    },
    params.sessionId,
    {
      includeClientIds: [params.originClientId],
      dropIfSlow: params.dropIfSlow,
    },
  );
}

function clampToolPayload(value: unknown, fieldLabel: string): unknown {
  const bytes = utf8Bytes(value);
  if (bytes <= TOOL_EVENT_MAX_BYTES) {
    return value;
  }
  return {
    truncated: true,
    field: fieldLabel,
    maxBytes: TOOL_EVENT_MAX_BYTES,
    originalBytes: bytes,
  };
}

function emitCapabilityGatedAgentEvent(params: {
  sessionId: string;
  payload: {
    runId: string;
    sessionKey: string;
    stream: string;
    seq: number;
    ts: number;
    data?: Record<string, unknown>;
  };
}): void {
  const recipients = runtime.getSessionClientIds({
    sessionId: params.sessionId,
    eventType: "agent",
    requiredCaps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
  });
  if (recipients.length === 0) {
    return;
  }
  runtime.sendEventToClients(recipients, "agent", params.payload, {
    dropIfSlow: true,
  });
}

async function resolveSessionIdentity(params: {
  sessionKey: string;
  authUserId?: string;
}): Promise<{ sessionId: string; sessionKey: string } | null> {
  if (params.authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: params.authUserId,
      sessionKey: params.sessionKey,
    });
    if (!identity) return null;
    return {
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
    };
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: params.sessionKey,
  });
  if (!identity) return null;
  return {
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
  };
}

export async function chatSend(
  params: ChatSendParams,
  clientId: string,
  authUserId?: string,
): Promise<ChatSendResult | RpcError> {
  const sessionKey = params.sessionKey?.trim();
  const rawMessage = typeof params.message === "string" ? params.message.trim() : "";
  const requestedIdempotencyKey = params.idempotencyKey?.trim();
  const thinking = params.thinking?.trim();
  const deliver = params.deliver !== false;
  const userId = authUserId ?? "gateway-user";

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }
  if (!requestedIdempotencyKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "idempotencyKey is required");
  }

  const normalizedMessage = normalizeChatMessageInput(rawMessage);
  if (!normalizedMessage.ok) {
    return createError(ErrorCodes.INVALID_PARAMS, normalizedMessage.error);
  }

  if (typeof params.attachments !== "undefined") {
    if (!Array.isArray(params.attachments)) {
      return createError(ErrorCodes.INVALID_PARAMS, "attachments must be an array when provided");
    }
  }

  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    Array.isArray(params.attachments) ? params.attachments : undefined,
  );

  if (!normalizedMessage.message.trim() && normalizedAttachments.length === 0) {
    return createError(ErrorCodes.INVALID_PARAMS, "message or attachment required");
  }

  let parsedAttachments: Awaited<ReturnType<typeof parseChatAttachments>>;
  try {
    parsedAttachments = await parseChatAttachments(normalizedAttachments, {
      maxAttachments: CHAT_ATTACHMENT_LIMITS.maxCount,
      maxBytesPerAttachment: CHAT_ATTACHMENT_LIMITS.maxBytesPerAttachment,
      maxTotalBytes: CHAT_ATTACHMENT_LIMITS.maxTotalBytes,
      maxDocumentChars: CHAT_ATTACHMENT_LIMITS.maxDocumentChars,
    });
  } catch (error) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      error instanceof Error ? error.message : String(error),
    );
  }

  const structuredUserContent = buildStructuredUserContent(
    normalizedMessage.message,
    parsedAttachments.historyBlocks,
  );
  const promptMessage = buildAgentPromptFromInput(
    normalizedMessage.message,
    parsedAttachments.historyBlocks.length > 0,
    parsedAttachments.docContext,
  );

  const identity = await resolveSessionIdentity({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
  }

  // Track the calling client against this session so disconnect cleanup and
  // heartbeat wake logic can reason about active subscribers consistently.
  runtime.subscribe(clientId, [], identity.sessionId);

  const existing = readIdempotencyStatus(identity.sessionId, requestedIdempotencyKey);
  if (existing) {
    return {
      runId: existing.runId,
      status: existing.status,
    };
  }

  const run = runtime.createRun(identity.sessionId, userId, {
    runId: requestedIdempotencyKey,
  });

  setIdempotencyStatus(identity.sessionId, requestedIdempotencyKey, {
    runId: run.runId,
    status: "in_flight",
  });

  if (thinking) {
    const [session] = await db
      .select({ metadata: avaSessions.metadata })
      .from(avaSessions)
      .where(eq(avaSessions.id, identity.sessionId))
      .limit(1);
    const metadata = ((session?.metadata ?? {}) as Record<string, unknown>);
    metadata.thinkingLevel = thinking;
    await db
      .update(avaSessions)
      .set({ metadata })
      .where(eq(avaSessions.id, identity.sessionId));
  }

  void executeChatRun({
    runId: run.runId,
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
    userId,
    message: promptMessage,
    displayMessage: normalizedMessage.message,
    images: parsedAttachments.images,
    inputContentBlocks: structuredUserContent,
    originClientId: clientId,
    timeoutMs: params.timeoutMs,
    idempotencyKey: requestedIdempotencyKey,
    deliver,
  });

  return {
    runId: run.runId,
    status: "started",
  };
}

async function executeChatRun(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  userId: string;
  message: string;
  displayMessage: string;
  images?: ImageContent[];
  inputContentBlocks?: ChatRichContentBlock[];
  originClientId: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  deliver: boolean;
}): Promise<void> {
  let seq = 0;
  let agentSeq = 0;
  let thinkingPulseSent = false;
  let streamedThinkingText = "";
  let pendingThinkingDelta = "";
  let lastThinkingEmitAt = 0;
  let thinkingFlushTimer: NodeJS.Timeout | null = null;
  const assistantStreamState = createTagStreamState("hide-thinking");
  const thinkingStreamState = createTagStreamState("strip-tags");
  const run = runtime.getRun(params.runId);
  if (!run) {
    return;
  }
  const toolVerboseLevel = await resolveSessionToolVerboseLevel(params.sessionId);

  runtime.updateRun(params.runId, { status: "running" });

  let timeout: NodeJS.Timeout | null = null;
  if (Number.isFinite(params.timeoutMs) && (params.timeoutMs as number) > 0) {
    timeout = setTimeout(() => {
      runtime.cancelRun(params.runId);
    }, Math.floor(params.timeoutMs as number));
    timeout.unref?.();
  }

  try {
    const emitAgentStream = (stream: string, data?: Record<string, unknown>) => {
      agentSeq += 1;
      emitCapabilityGatedAgentEvent({
        sessionId: params.sessionId,
        payload: {
          runId: params.runId,
          sessionKey: params.sessionKey,
          stream,
          seq: agentSeq,
          ts: nowMs(),
          ...(data ? { data } : {}),
        },
      });
    };

    const clearThinkingFlushTimer = () => {
      if (!thinkingFlushTimer) {
        return;
      }
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    };

    const flushPendingThinking = () => {
      if (!pendingThinkingDelta) {
        return;
      }

      thinkingPulseSent = true;
      streamedThinkingText += pendingThinkingDelta;
      const fullText = streamedThinkingText;
      const textWasTrimmed = fullText.length > THINKING_STREAM_TEXT_MAX_CHARS;
      const textForEvent = textWasTrimmed
        ? fullText.slice(fullText.length - THINKING_STREAM_TEXT_MAX_CHARS)
        : fullText;

      emitAgentStream("thinking", {
        delta: pendingThinkingDelta,
        ...(THINKING_STREAM_INCLUDE_TEXT
          ? {
              text: textForEvent,
              ...(textWasTrimmed
                ? {
                    truncated: true,
                    totalChars: fullText.length,
                  }
                : {}),
            }
          : {}),
      });

      pendingThinkingDelta = "";
      lastThinkingEmitAt = nowMs();
      clearThinkingFlushTimer();
    };

    const queueThinkingDelta = (delta: string) => {
      pendingThinkingDelta += delta;
      if (THINKING_STREAM_MIN_INTERVAL_MS <= 0) {
        flushPendingThinking();
        return;
      }
      const elapsed = nowMs() - lastThinkingEmitAt;
      const waitMs = THINKING_STREAM_MIN_INTERVAL_MS - elapsed;
      if (waitMs <= 0) {
        flushPendingThinking();
        return;
      }
      if (!thinkingFlushTimer) {
        thinkingFlushTimer = setTimeout(() => {
          thinkingFlushTimer = null;
          flushPendingThinking();
        }, waitMs);
        thinkingFlushTimer.unref?.();
      }
    };

    const handleDelta = (text: string) => {
      const visibleDelta = stripTaggedStreamChunkForDisplay(text, assistantStreamState);
      if (!visibleDelta) {
        return;
      }
      seq += 1;
      emitChatEvent({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        seq,
        state: "delta",
        message: buildChatTextMessage({ text: visibleDelta }),
        originClientId: params.originClientId,
        dropIfSlow: true,
      });
    };

    const handleAgentEvent = (event: AgentEvent) => {
      switch (event.type) {
        case "text_delta":
          if (event.text) {
            handleDelta(event.text);
          }
          return;
        case "thinking": {
          if (!event.text) {
            if (thinkingPulseSent || pendingThinkingDelta || streamedThinkingText) {
              return;
            }
            thinkingPulseSent = true;
            emitAgentStream("thinking", {});
            return;
          }
          const thinkingDelta = stripTaggedStreamChunkForDisplay(event.text, thinkingStreamState);
          if (!thinkingDelta) {
            return;
          }
          queueThinkingDelta(thinkingDelta);
          return;
        }
        case "tool_call":
          if (!event.call) return;
          flushPendingThinking();
          emitAgentStream("tool", {
            phase: "call",
            toolName: event.call.name,
            args: clampToolPayload(event.call.args, "args"),
          });
          return;
        case "tool_result":
          if (!event.result) return;
          flushPendingThinking();
          emitAgentStream("tool", {
            phase: "result",
            toolName: event.result.name,
            ...(toolVerboseLevel === "full"
              ? { result: clampToolPayload(event.result.result, "result") }
              : {}),
          });
          return;
        default:
          return;
      }
    };

    let result: {
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    if (FAKE_AGENT_MODE) {
      // Keep fake mode deterministic for process tests while exercising tool-event paths.
      handleAgentEvent({ type: "thinking" });
      handleAgentEvent({
        type: "tool_call",
        call: { name: "fake_tool", args: { message: params.displayMessage || params.message } },
      });
      handleAgentEvent({
        type: "tool_result",
        result: { name: "fake_tool", result: { ok: true } },
      });

      result = await executeFakeChat({
        message: params.displayMessage || params.message,
        abortSignal: run.abortController?.signal,
        onDelta: handleDelta,
      });
    } else {
      const userContext = await resolveUserContext("web", params.userId);
      result = await executeAgentWithPi({
        sessionId: params.sessionId,
        userId: params.userId,
        userContext,
        prompt: params.message,
        displayPrompt: params.displayMessage,
        images: params.images,
        inputContentBlocks: params.inputContentBlocks,
        abortSignal: run.abortController?.signal,
        onEvent: handleAgentEvent,
      });
    }

    flushPendingThinking();

    const latestRun = runtime.getRun(params.runId);
    if (!latestRun || latestRun.status === "cancelled") {
      seq += 1;
      emitChatEvent({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        seq,
        state: "aborted",
        originClientId: params.originClientId,
      });
      if (params.idempotencyKey) {
        setIdempotencyStatus(params.sessionId, params.idempotencyKey, {
          runId: params.runId,
          status: "error",
        });
      }
      return;
    }

    runtime.updateRun(params.runId, {
      status: "completed",
      completedAt: nowMs(),
      content: result.content,
      usage: result.usage,
    });

    const envelope = parseControlEnvelopeWithLegacyFallback(result.content);
    const delivery = toDeliveryControl(envelope, result.content);
    const finalMessage = delivery.mode === "deliver" ? delivery.text.trim() : "";

    seq += 1;
    emitChatEvent({
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      seq,
      state: "final",
      ...(params.deliver && finalMessage
        ? { message: buildChatTextMessage({ text: finalMessage }) }
        : {}),
      usage: result.usage,
      originClientId: params.originClientId,
      stopReason: "stop",
    });

    if (params.idempotencyKey) {
      setIdempotencyStatus(params.sessionId, params.idempotencyKey, {
        runId: params.runId,
        status: "ok",
      });
    }
  } catch (error) {
    pendingThinkingDelta = "";
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    }
    const latestRun = runtime.getRun(params.runId);
    const aborted = latestRun?.status === "cancelled";
    if (aborted) {
      seq += 1;
      emitChatEvent({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        seq,
        state: "aborted",
        originClientId: params.originClientId,
      });
      if (params.idempotencyKey) {
        setIdempotencyStatus(params.sessionId, params.idempotencyKey, {
          runId: params.runId,
          status: "error",
        });
      }
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    runtime.updateRun(params.runId, {
      status: "error",
      completedAt: nowMs(),
      error: errorMessage,
    });

    seq += 1;
    emitChatEvent({
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      seq,
      state: "error",
      errorMessage,
      originClientId: params.originClientId,
    });

    if (params.idempotencyKey) {
      setIdempotencyStatus(params.sessionId, params.idempotencyKey, {
        runId: params.runId,
        status: "error",
      });
    }
  } finally {
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer);
      thinkingFlushTimer = null;
    }
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function chatHistory(
  params: ChatHistoryParams,
  authUserId?: string,
): Promise<ChatHistoryResult | RpcError> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveSessionIdentity({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
  }

  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(CHAT_HISTORY_LIMIT_MAX, Math.floor(params.limit as number)))
    : CHAT_HISTORY_LIMIT_DEFAULT;

  const [messages, sessionRows] = await Promise.all([
    db
      .select({
        id: avaMessages.id,
        role: avaMessages.role,
        content: avaMessages.content,
        metadata: avaMessages.metadata,
        createdAt: avaMessages.createdAt,
      })
      .from(avaMessages)
      .where(eq(avaMessages.sessionId, identity.sessionId))
      .orderBy(desc(avaMessages.createdAt))
      .limit(limit),
    db
      .select({ metadata: avaSessions.metadata })
      .from(avaSessions)
      .where(eq(avaSessions.id, identity.sessionId))
      .limit(1),
  ]);

  let budgetBytes = 0;
  const prepared: ChatRichMessage[] = [];

  for (const row of messages.reverse()) {
    const timestamp = row.createdAt?.getTime() ?? nowMs();
    const candidateRaw = {
      id: row.id,
      role: row.role,
      timestamp,
      content: row.content ?? "",
      metadata: row.metadata ?? {},
    };

    let entry: ChatRichMessage;
    let entryBytes = utf8Bytes(candidateRaw);
    if (entryBytes > CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES) {
      entry = buildOversizedPlaceholder({
        id: row.id,
        role: row.role,
        timestamp,
      });
      entryBytes = utf8Bytes(entry);
    } else {
      const structuredBlocks = sanitizeHistoryContentBlocksFromMetadata(row.metadata);
      if (structuredBlocks && structuredBlocks.length > 0) {
        entry = {
          id: row.id,
          role: row.role,
          timestamp,
          content: structuredBlocks,
        };
        entryBytes = utf8Bytes(entry);
      } else {
        const sanitized = sanitizeText(row.content);
        if (!sanitized.text) {
          continue;
        }
        entry = {
          ...buildChatTextMessage({
            id: row.id,
            role: row.role,
            timestamp,
            text: sanitized.text,
          }),
          ...(sanitized.truncated ? { truncated: true } : {}),
        };
        entryBytes = utf8Bytes(entry);
      }
    }

    if (budgetBytes + entryBytes > CHAT_HISTORY_MAX_TOTAL_BYTES) {
      break;
    }

    budgetBytes += entryBytes;
    prepared.push(entry);
  }

  const metadata = ((sessionRows[0]?.metadata ?? {}) as Record<string, unknown>);
  const thinkingLevel =
    typeof metadata.thinkingLevel === "string" ? metadata.thinkingLevel : undefined;
  const verboseLevel =
    typeof metadata.verboseLevel === "string" ? metadata.verboseLevel : undefined;

  return {
    sessionKey: identity.sessionKey,
    sessionId: identity.sessionId,
    messages: prepared,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(verboseLevel ? { verboseLevel } : {}),
  };
}

export async function chatAbort(
  params: ChatAbortParams,
  authUserId?: string,
): Promise<ChatAbortResult | RpcError> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveSessionIdentity({
    sessionKey,
    authUserId,
  });
  if (!identity) {
    return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
  }

  if (params.runId?.trim()) {
    const runId = params.runId.trim();
    const run = runtime.getRun(runId);
    if (!run || run.sessionId !== identity.sessionId) {
      return createError(ErrorCodes.NOT_FOUND, `Run ${runId} not found`);
    }
    if (authUserId && run.userId !== authUserId) {
      return createError(ErrorCodes.UNAUTHORIZED, "Not authorized for this run");
    }

    const cancelled = runtime.cancelRun(runId);
    if (cancelled) {
      runtime.broadcast(
        {
          event: "chat",
          payload: {
            runId,
            sessionKey: identity.sessionKey,
            seq: 0,
            state: "aborted",
          },
        },
        identity.sessionId,
      );
    }
    return {
      ok: true,
      aborted: cancelled ? 1 : 0,
      runIds: cancelled ? [runId] : [],
    };
  }

  // Abort all active runs for the session.
  const activeRunIds = runtime
    .getRunsBySession(identity.sessionId)
    .filter((run) => run.status === "pending" || run.status === "running")
    .map((run) => run.runId);
  const cancelled = runtime.cancelRunsForSession(identity.sessionId);
  const cancelledRunIds = activeRunIds.filter((runId) => runtime.getRun(runId)?.status === "cancelled");

  for (const runId of cancelledRunIds) {
    runtime.broadcast(
      {
        event: "chat",
        payload: {
          runId,
          sessionKey: identity.sessionKey,
          seq: 0,
          state: "aborted",
        },
      },
      identity.sessionId,
    );
  }

  return {
    ok: true,
    aborted: cancelledRunIds.length || cancelled,
    runIds: cancelledRunIds,
  };
}

export async function getSessionPreviewSnippet(sessionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({
      content: avaMessages.content,
    })
    .from(avaMessages)
    .where(
      and(
        eq(avaMessages.sessionId, sessionId),
        eq(avaMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(avaMessages.createdAt))
    .limit(1);

  if (!row?.content) {
    return undefined;
  }
  const sanitized = sanitizeText(row.content).text.trim();
  if (!sanitized) return undefined;
  return sanitized.length <= 280 ? sanitized : `${sanitized.slice(0, 280)}...`;
}

export async function assertSessionExistsForUser(params: {
  sessionKey: string;
  authUserId?: string;
}): Promise<boolean> {
  const identity = await resolveSessionIdentity(params);
  if (!identity) return false;
  const [session] = await db
    .select({ id: avaSessions.id })
    .from(avaSessions)
    .where(eq(avaSessions.id, identity.sessionId))
    .limit(1);
  return Boolean(session);
}
