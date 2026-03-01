/**
 * Slack Message Handler
 *
 * Slack integration:
 * - Inbound message debouncing
 * - Typing indicators (assistant.threads.setStatus)
 * - Ack reactions (eyes emoji)
 * - Block streaming (incremental response updates)
 * - Thread starter context
 * - Session-based thread tracking (no timeout)
 * - Markdown-aware chunking
 * - Markdown-to-Slack mrkdwn conversion (via IR)
 */
import type { WebClient } from "@slack/web-api";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/index.js";
import { and, eq, ne } from "drizzle-orm";
import { executeAgentWithPi, type AgentEvent } from "../../agent/executor-pi.js";
import { getSlackApp } from "../../lib/slack/app.js";
import {
  downloadSlackFile,
  processFilesForAgent,
  cleanupTempFile,
  type SlackFile,
  type DownloadedFile,
} from "../../lib/slack/files.js";
import {
  processMediaFiles,
  formatMediaContext,
} from "../../services/media.service.js";
import { markdownToSlackMrkdwn } from "../../lib/slack/format.js";
import {
  resolveUserName,
  resolveChannelInfo,
  formatInboundEnvelope,
  sanitizeInboundMessage,
} from "../../lib/slack/context.js";
import {
  resolveReplyToModeForChatType,
  createReplyDeliveryPlan,
  type ReplyDeliveryPlan,
} from "../../lib/slack/threading.js";
import { resolveTtsMode, synthesizeSpeech } from "../../services/tts.service.js";
import { uploadFileToSlack } from "../../lib/slack/files.js";
import { getConfig } from "../../lib/config-loader.js";
import { resolveUserContext } from "../../agent/user-context.js";
import { createReplyDispatcher } from "../../lib/slack/reply-dispatcher.js";
import {
  collectWithinWindow,
  dedupeByKey,
  dropOldestWhenFull,
} from "../../lib/queue/queue-helpers.js";
import {
  resolveExecApprovalDecisionBySlackUser,
  type ExecApprovalDecision,
} from "../../services/exec-approval.service.js";
import { sessionBindingService } from "../../services/session-binding.service.js";
import { sessionKeyResolverService } from "../../services/session-key-resolver.service.js";
import { archiveSessionAndTerminateWork } from "../../gateway/services/session-lifecycle-guard.js";
import { buildSessionKey } from "../../core/session-key.js";
import {
  resolveSessionSubagentFlowMode,
  setSessionSubagentFlowMode,
} from "../../agent/subagent-flow-mode.js";
import { killAllForParent, listRuns } from "../../agent/tools/subagent-registry.js";
import { isNaturalLanguageStopIntent } from "./stop-intent.js";
import { createTypingKeepaliveController } from "./typing-keepalive.js";
import {
  parseControlEnvelopeWithLegacyFallback,
  toDeliveryControl,
} from "../../core/control-envelope.js";

// --- Cached Slack auth info for streaming API ---
let cachedAuthInfo: { teamId?: string; botUserId?: string } | undefined;
async function getAuthInfo(
  client: WebClient,
): Promise<{ teamId?: string; botUserId?: string }> {
  if (cachedAuthInfo) return cachedAuthInfo;
  try {
    const result = await client.auth.test();
    cachedAuthInfo = { teamId: result.team_id, botUserId: result.user_id };
  } catch {
    cachedAuthInfo = {};
  }
  return cachedAuthInfo;
}

// --- Configuration (from config.json) ---

const cfg = getConfig();
const ACK_EMOJI = cfg.slack.ackEmoji;
const ACK_SCOPE = cfg.slack.ackReactionScope.toLowerCase();
const DEBOUNCE_MS = 1500;
const SLACK_MAX_MSG_LEN = 3900;
const REPLY_TO_MODES = {
  direct: resolveReplyToModeForChatType("direct"),
  group: resolveReplyToModeForChatType("group"),
  channel: resolveReplyToModeForChatType("channel"),
};

type ChunkMode = "length" | "newline";
const CHUNK_MODE: ChunkMode =
  cfg.slack.chunkMode.toLowerCase() === "newline" ? "newline" : "length";

const HUMAN_DELAY_MODE = cfg.slack.humanDelay.mode.toLowerCase();
const HUMAN_DELAY_MIN_MS = cfg.slack.humanDelay.minMs;
const HUMAN_DELAY_MAX_MS = cfg.slack.humanDelay.maxMs;
const SLACK_TYPING_KEEPALIVE_MS =
  cfg.slack.typing?.keepaliveMs && cfg.slack.typing.keepaliveMs > 0
    ? cfg.slack.typing.keepaliveMs
    : 8_000;
const SLACK_TYPING_MAX_DURATION_MS =
  cfg.slack.typing?.maxDurationMs && cfg.slack.typing.maxDurationMs > 0
    ? cfg.slack.typing.maxDurationMs
    : 600_000;

function getHumanDelay(): number {
  if (HUMAN_DELAY_MODE === "off") return 0;
  const min = HUMAN_DELAY_MIN_MS;
  const max = HUMAN_DELAY_MAX_MS;
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// --- System events buffer (edits, deletes, reactions injected into next agent run) ---

interface SystemEvent {
  type: string;
  [key: string]: unknown;
}

const systemEventsBuffer = new Map<string, SystemEvent[]>(); // key: "channelId:threadTs"
const MAX_SYSTEM_EVENTS = 10;

export function injectSystemEvent(
  channelId: string,
  threadTs: string | undefined,
  event: SystemEvent,
): void {
  if (!channelId) return;
  const key = `${channelId}:${threadTs || "main"}`;
  const events = systemEventsBuffer.get(key) || [];
  events.push(event);
  if (events.length > MAX_SYSTEM_EVENTS) events.shift(); // cap buffer
  systemEventsBuffer.set(key, events);
}

function drainSystemEvents(
  channelId: string,
  threadTs: string,
): string | undefined {
  const key = `${channelId}:${threadTs}`;
  const events = systemEventsBuffer.get(key);
  if (!events || events.length === 0) return undefined;
  systemEventsBuffer.delete(key);
  const lines = events.map((e) => `[System: ${e.type}] ${JSON.stringify(e)}`);
  return `## Recent Activity\n${lines.join("\n")}`;
}

// --- Pending channel history (un-mentioned messages) ---

const pendingHistory = new Map<
  string,
  Array<{ userId: string; text: string; ts: string }>
>();
const MAX_PENDING_HISTORY = 20;

export function storePendingMessage(
  channelId: string,
  userId: string,
  text: string,
  ts: string,
): void {
  const pending = pendingHistory.get(channelId) || [];
  pending.push({ userId, text: text.slice(0, 300), ts });
  if (pending.length > MAX_PENDING_HISTORY) pending.shift();
  pendingHistory.set(channelId, pending);
}

function drainPendingHistory(channelId: string): string | undefined {
  const pending = pendingHistory.get(channelId);
  if (!pending || pending.length === 0) return undefined;
  pendingHistory.delete(channelId);
  const lines = pending.map(
    (m) =>
      `[${new Date(parseFloat(m.ts) * 1000).toISOString()}] ${m.userId}: ${m.text}`,
  );
  return `## Recent Channel Messages (before @mention)\n${lines.join("\n")}`;
}

// --- Session queue (collect mode — serialize agent runs per session) ---

interface QueuedMessage {
  text: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

type SessionQueueMode =
  | "collect"
  | "followup"
  | "steer"
  | "steer-backlog"
  | "interrupt";
type SessionSubagentFlowModeInput = "async" | "supervisor" | "default";

const SESSION_QUEUE_MODE_SET = new Set<SessionQueueMode>([
  "collect",
  "followup",
  "steer",
  "steer-backlog",
  "interrupt",
]);

function isSessionQueueMode(value: string): value is SessionQueueMode {
  return SESSION_QUEUE_MODE_SET.has(value as SessionQueueMode);
}

function isSessionSubagentFlowModeInput(
  value: string,
): value is SessionSubagentFlowModeInput {
  return value === "async" || value === "supervisor" || value === "default";
}

function normalizeSessionQueueMode(value: string | undefined): SessionQueueMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized && isSessionQueueMode(normalized)) {
    return normalized;
  }
  return "steer-backlog";
}

const DEFAULT_SESSION_QUEUE_MODE = normalizeSessionQueueMode(cfg.slack.queueMode);

const activeRuns = new Map<string, Promise<void>>();
const activeAbortControllers = new Map<string, AbortController>();
const pendingQueues = new Map<string, QueuedMessage[]>();
const sessionQueueModes = new Map<string, SessionQueueMode>();
const MAX_CONCURRENT_RUNS = cfg.slack.maxConcurrentRuns;
const MAX_PENDING_PER_SESSION = 25;
const PENDING_QUEUE_WINDOW_MS = 5 * 60 * 1000;
let globalRunCount = 0;

function normalizePendingQueue(queue: QueuedMessage[]): QueuedMessage[] {
  const fresh = collectWithinWindow(
    queue,
    PENDING_QUEUE_WINDOW_MS,
    (item) => {
      const parsed = Number(item.messageTs);
      if (Number.isFinite(parsed)) return parsed * 1000;
      return Date.now();
    },
  );
  const deduped = dedupeByKey(
    fresh,
    (item) =>
      `${item.channelId}:${item.threadTs}:${item.messageTs || item.text.slice(0, 64)}`,
  );
  dropOldestWhenFull(deduped, MAX_PENDING_PER_SESSION, 0);
  return deduped;
}

async function withSessionQueue(
  sessionId: string,
  message: QueuedMessage,
  mode: SessionQueueMode,
  runFn: (
    combinedMessage: string,
    messageTs: string,
    abortSignal?: AbortSignal,
  ) => Promise<void>,
): Promise<void> {
  // If a run is active for this session, queue the message
  if (activeRuns.has(sessionId)) {
    const queue = pendingQueues.get(sessionId) || [];
    let nextQueue: QueuedMessage[];
    if (mode === "steer" || mode === "interrupt") {
      nextQueue = [message];
    } else if (mode === "steer-backlog") {
      nextQueue = [message, ...queue];
    } else {
      nextQueue = [...queue, message];
    }
    dropOldestWhenFull(nextQueue, MAX_PENDING_PER_SESSION, 0);
    pendingQueues.set(sessionId, normalizePendingQueue(nextQueue));
    if (mode === "steer" || mode === "steer-backlog" || mode === "interrupt") {
      const abortReason = mode === "interrupt" ? "queue-interrupt" : "queue-steer";
      activeAbortControllers.get(sessionId)?.abort(abortReason);
    }
    console.log(
      `[QUEUE] Message queued for session ${sessionId} (${nextQueue.length} pending, mode=${mode})`,
    );
    return;
  }

  // Global concurrency check
  if (globalRunCount >= MAX_CONCURRENT_RUNS) {
    const queue = pendingQueues.get(sessionId) || [];
    let nextQueue: QueuedMessage[];
    if (mode === "steer" || mode === "interrupt") {
      nextQueue = [message];
    } else {
      nextQueue = [...queue, message];
    }
    dropOldestWhenFull(nextQueue, MAX_PENDING_PER_SESSION, 0);
    pendingQueues.set(sessionId, normalizePendingQueue(nextQueue));
    console.log(
      `[QUEUE] Global concurrency limit (${MAX_CONCURRENT_RUNS}), queuing for session ${sessionId} (mode=${mode})`,
    );
    return;
  }

  // Run immediately
  globalRunCount++;
  const abortController = new AbortController();
  activeAbortControllers.set(sessionId, abortController);
  const runPromise = (async () => {
    try {
      await runFn(message.text, message.messageTs, abortController.signal);
    } finally {
      globalRunCount--;
      activeRuns.delete(sessionId);
      activeAbortControllers.delete(sessionId);
      // Drain queue according to session mode.
      const queue = pendingQueues.get(sessionId);
      if (queue && queue.length > 0) {
        const normalizedQueue = normalizePendingQueue(queue);
        const resolvedMode = await resolveSessionQueueMode(sessionId);
        if (normalizedQueue.length === 0) {
          pendingQueues.delete(sessionId);
        } else {
          let nextMessage: QueuedMessage;
          let remaining: QueuedMessage[];
          if (resolvedMode === "collect") {
            nextMessage = {
              text: normalizedQueue.map((q) => q.text).join("\n\n"),
              channelId: normalizedQueue[0].channelId,
              threadTs: normalizedQueue[0].threadTs,
              messageTs: normalizedQueue[normalizedQueue.length - 1].messageTs,
            };
            remaining = [];
          } else {
            nextMessage = normalizedQueue[0];
            remaining = normalizedQueue.slice(1);
          }

          if (remaining.length > 0) {
            pendingQueues.set(sessionId, remaining);
          } else {
            pendingQueues.delete(sessionId);
          }

          console.log(
            `[QUEUE] Draining queued message(s) for session ${sessionId} (mode=${resolvedMode}, remaining=${remaining.length})`,
          );
          await withSessionQueue(sessionId, nextMessage, resolvedMode, runFn);
        }
      }
    }
  })();

  activeRuns.set(sessionId, runPromise);
  await runPromise;
}

async function resolveSessionQueueMode(sessionId: string): Promise<SessionQueueMode> {
  const cached = sessionQueueModes.get(sessionId);
  if (cached) {
    return cached;
  }

  const [session] = await db
    .select({ metadata: avaSessions.metadata })
    .from(avaSessions)
    .where(eq(avaSessions.id, sessionId))
    .limit(1);

  const metadata = (session?.metadata || {}) as Record<string, unknown>;
  const fromSession =
    typeof metadata.queueMode === "string" ? metadata.queueMode : undefined;
  const mode = normalizeSessionQueueMode(fromSession ?? DEFAULT_SESSION_QUEUE_MODE);
  sessionQueueModes.set(sessionId, mode);
  return mode;
}

async function setSessionQueueMode(
  sessionId: string,
  mode: SessionQueueMode,
): Promise<void> {
  sessionQueueModes.set(sessionId, mode);

  const [session] = await db
    .select({ metadata: avaSessions.metadata })
    .from(avaSessions)
    .where(eq(avaSessions.id, sessionId))
    .limit(1);

  const metadata = (session?.metadata || {}) as Record<string, unknown>;
  metadata.queueMode = mode;

  await db
    .update(avaSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(eq(avaSessions.id, sessionId));
}

// --- Debouncing ---

export interface SlackAttachment {
  text?: string;
  fallback?: string;
  author_name?: string;
  author_id?: string;
  from_url?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  [key: string]: unknown;
}

interface DebouncedMessage {
  messages: string[];
  files: SlackFile[];
  attachments: SlackAttachment[];
  timer: NodeJS.Timeout;
  channelId: string;
  threadTs: string;
  userId: string;
  botUserId?: string;
  messageTs: string;
}

const debounceMap = new Map<string, DebouncedMessage>();

function getThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function getExternalId(channelId: string, threadTs: string): string {
  // For DMs, threadTs is "dm:<userId>" — one session per user
  if (threadTs.startsWith("dm:")) {
    return `slack:${threadTs}`;
  }
  return `slack:${channelId}:${threadTs}`;
}

function isDmSession(threadTs: string): boolean {
  return threadTs.startsWith("dm:");
}

// --- Thread history ---

const THREAD_HISTORY_LIMIT = cfg.slack.threadHistoryLimit;
const threadHistoryCache = new Map<string, string>();

interface ThreadHistoryResult {
  context: string;
  starterFiles?: SlackFile[];
}

async function getThreadHistory(
  client: WebClient,
  channelId: string,
  threadTs: string,
  messageTs: string,
  isNewSession: boolean,
): Promise<ThreadHistoryResult | null> {
  // Only fetch if this is a reply in a thread (messageTs !== threadTs)
  if (messageTs === threadTs) return null;

  const key = getThreadKey(channelId, threadTs);

  // For existing sessions, return cached starter context (lightweight)
  if (!isNewSession && threadHistoryCache.has(key)) {
    return { context: threadHistoryCache.get(key)! };
  }

  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: isNewSession ? THREAD_HISTORY_LIMIT : 1,
      inclusive: true,
    });

    const messages = result.messages ?? [];
    if (messages.length === 0) return null;

    // Extract starter files for media hydration
    const starterMsg = messages[0];
    const starterFiles = (starterMsg?.files ?? []) as SlackFile[];

    if (!isNewSession) {
      // Just cache the root message for existing sessions
      const rootText = starterMsg?.text?.slice(0, 500) ?? "";
      if (rootText) threadHistoryCache.set(key, rootText);
      return { context: rootText, starterFiles };
    }

    // For new sessions: batch-resolve user names and build full history
    const uniqueUserIds = [
      ...new Set(
        messages
          .map((m) => (m as { user?: string }).user)
          .filter(Boolean) as string[],
      ),
    ];
    const userNames = new Map<string, string>();
    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const name = await resolveUserName(client, uid);
        userNames.set(uid, name);
      }),
    );

    // Filter out the current message from history
    const historyMessages = messages.filter(
      (m) => (m as { ts?: string }).ts !== messageTs,
    );

    const parts: string[] = [];
    for (const msg of historyMessages) {
      const m = msg as {
        user?: string;
        bot_id?: string;
        ts?: string;
        text?: string;
      };
      const sender = m.user
        ? (userNames.get(m.user) ?? m.user)
        : m.bot_id
          ? `Bot`
          : "Unknown";
      const isBot = !!m.bot_id;
      const role = isBot ? "assistant" : "user";
      const ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : "";
      const text = m.text ?? "";
      parts.push(`[${ts}] ${sender} (${role}): ${text}`);
    }

    const context = parts.join("\n\n");
    // Cache the root text for subsequent non-new-session lookups
    const rootText = starterMsg?.text?.slice(0, 500) ?? "";
    if (rootText) threadHistoryCache.set(key, rootText);

    return { context, starterFiles };
  } catch {
    return null;
  }
}

// --- Session-based thread tracking (no timeout) ---

export async function isThreadActive(
  channelId: string,
  threadTs: string,
): Promise<boolean> {
  const state = await resolveThreadDispatchState(channelId, threadTs);
  return Boolean(state);
}

async function resolveSlackSessionForThread(
  channelId: string,
  threadTs: string,
): Promise<{ id: string; userId: string } | null> {
  const externalId = getExternalId(channelId, threadTs);
  const [session] = await db
    .select({ id: avaSessions.id, userId: avaSessions.userId })
    .from(avaSessions)
    .where(
      and(
        eq(avaSessions.externalId, externalId),
        eq(avaSessions.source, "slack"),
        ne(avaSessions.status, "archived"),
        ne(avaSessions.status, "deleted"),
        ne(avaSessions.lifecycleState, "archived"),
        ne(avaSessions.lifecycleState, "deleted"),
      ),
    )
    .limit(1);
  return session ?? null;
}

export interface ThreadDispatchState {
  sessionId: string;
  ownerUserId: string;
  hasActiveRun: boolean;
  hasPendingQueue: boolean;
  hasRunningSubagents: boolean;
}

export async function resolveThreadDispatchState(
  channelId: string,
  threadTs: string,
): Promise<ThreadDispatchState | null> {
  const session = await resolveSlackSessionForThread(channelId, threadTs);
  if (!session) {
    return null;
  }

  const hasActiveRun =
    activeRuns.has(session.id) || activeAbortControllers.has(session.id);
  const queued = pendingQueues.get(session.id);
  const hasPendingQueue = Boolean(queued && queued.length > 0);
  const hasRunningSubagents = listRuns(session.id).running.length > 0;

  return {
    sessionId: session.id,
    ownerUserId: session.userId,
    hasActiveRun,
    hasPendingQueue,
    hasRunningSubagents,
  };
}

async function stopActiveRunForThread(params: {
  client: WebClient;
  channelId: string;
  threadTs: string;
  ackText: string;
}): Promise<boolean> {
  const session = await resolveSlackSessionForThread(
    params.channelId,
    params.threadTs,
  );
  if (!session) {
    return false;
  }

  const hasActiveRun =
    activeRuns.has(session.id) || activeAbortControllers.has(session.id);
  const killedSubagents = killAllForParent(session.id);
  if (!hasActiveRun && killedSubagents <= 0) {
    return false;
  }

  if (hasActiveRun) {
    activeAbortControllers.get(session.id)?.abort("user-stop");
    pendingQueues.delete(session.id);
  }
  const suffix =
    killedSubagents > 0
      ? ` Also stopped ${killedSubagents} running subagent${killedSubagents === 1 ? "" : "s"}.`
      : "";
  await postMessage(
    params.client,
    params.channelId,
    `${params.ackText}${suffix}`,
    params.threadTs,
  );
  return true;
}

// --- Slack helpers ---

function cleanSlackMessage(text: string, botUserId?: string): string {
  let cleaned = text;
  if (botUserId) {
    cleaned = cleaned
      .replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "")
      .trim();
  }
  return cleaned;
}

import {
  sanitizeAssistantOutput,
  isMessagingToolDuplicate,
} from "../../agent/sanitize-output.js";
import { extractMessagingToolSentText } from "./messaging-tool-dedupe.js";

function normalizeSlackReply(text: string | undefined): string | null {
  if (!text) return null;
  const sanitized = sanitizeAssistantOutput(text);
  const trimmed = sanitized.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function postMessage(
  client: WebClient,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  try {
    // DM sessions (dm:xxx) reply inline — no thread_ts
    const useThread = threadTs && !isDmSession(threadTs);
    const result = await client.chat.postMessage({
      channel: channelId,
      text,
      ...(useThread ? { thread_ts: threadTs } : {}),
      mrkdwn: true,
    });
    return result.ts;
  } catch (error) {
    console.error("Failed to post Slack message:", error);
    return undefined;
  }
}

// --- Typing indicators ---

async function setTypingStatus(
  client: WebClient,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  // Skip for DM sessions (no real thread_ts to set status on)
  if (isDmSession(threadTs)) return;
  try {
    if (typeof client.apiCall === "function") {
      await client.apiCall("assistant.threads.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      });
    }
  } catch {
    // API may not be available — silently ignore
  }
}

// --- Ack reactions ---

async function addAckReaction(
  client: WebClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  try {
    await client.reactions.add({
      channel: channelId,
      name: ACK_EMOJI,
      timestamp: messageTs,
    });
  } catch {
    // ignore (may already have reaction or missing scope)
  }
}

async function removeAckReaction(
  client: WebClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  try {
    await client.reactions.remove({
      channel: channelId,
      name: ACK_EMOJI,
      timestamp: messageTs,
    });
  } catch {
    // ignore
  }
}

// --- Markdown chunking ---

/**
 * Chunk a Slack message respecting markdown boundaries.
 *
 * Options:
 * - maxLen: hard cap per chunk (default SLACK_MAX_MSG_LEN)
 * - minLen: don't emit chunks smaller than this (except the last one)
 * - mode: "length" (default) or "newline" (paragraph-first splitting)
 *
 * Code fence repair: when splitting inside a code fence, closes the fence
 * in the current chunk and reopens it in the next.
 */
function chunkSlackMessage(
  text: string,
  maxLen = SLACK_MAX_MSG_LEN,
  { minLen = 0, mode = CHUNK_MODE }: { minLen?: number; mode?: ChunkMode } = {},
): string[] {
  if (text.length <= maxLen) return [text];

  // Newline mode: split on paragraph boundaries first, then length-chunk oversized paragraphs
  if (mode === "newline") {
    const paragraphs = text.split(/\n\n/);
    const result: string[] = [];
    let buffer = "";
    for (const para of paragraphs) {
      const candidate = buffer ? buffer + "\n\n" + para : para;
      if (candidate.length > maxLen && buffer) {
        result.push(buffer);
        buffer = para;
      } else if (candidate.length > maxLen) {
        // Single paragraph exceeds maxLen — fall through to length chunking
        result.push(
          ...chunkSlackMessage(para, maxLen, { minLen, mode: "length" }),
        );
        buffer = "";
      } else {
        buffer = candidate;
      }
    }
    if (buffer) result.push(buffer);
    // Apply minLen merging: merge small chunks with their predecessor
    if (minLen > 0 && result.length > 1) {
      const merged: string[] = [result[0]];
      for (let i = 1; i < result.length; i++) {
        const last = merged[merged.length - 1];
        if (
          result[i].length < minLen &&
          (last + "\n\n" + result[i]).length <= maxLen
        ) {
          merged[merged.length - 1] = last + "\n\n" + result[i];
        } else {
          merged.push(result[i]);
        }
      }
      return merged;
    }
    return result;
  }

  // Length mode: break preference cascade (paragraph > newline > sentence > space > hard)
  const chunks: string[] = [];
  let remaining = text;
  let openFence = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push((openFence ? openFence + "\n" : "") + remaining);
      break;
    }

    let breakAt = -1;
    const slice = remaining.slice(0, maxLen);

    const paraBreak = slice.lastIndexOf("\n\n");
    if (paraBreak > maxLen * 0.3) breakAt = paraBreak;
    if (breakAt === -1) {
      const lineBreak = slice.lastIndexOf("\n");
      if (lineBreak > maxLen * 0.3) breakAt = lineBreak;
    }
    if (breakAt === -1) {
      // Sentence break (period/question/exclamation followed by space)
      const sentenceRe = /[.!?]\s/g;
      let lastSentence = -1;
      let match: RegExpExecArray | null;
      while ((match = sentenceRe.exec(slice)) !== null) {
        if (match.index > maxLen * 0.3) lastSentence = match.index + 1;
      }
      if (lastSentence > 0) breakAt = lastSentence;
    }
    if (breakAt === -1) {
      const spaceBreak = slice.lastIndexOf(" ");
      if (spaceBreak > maxLen * 0.3) breakAt = spaceBreak;
    }
    if (breakAt === -1) breakAt = maxLen;

    const cut = remaining.slice(0, breakAt);

    // Detect fence language tag for proper reopening
    const fenceMatches = cut.match(/^(```\w*)/gm) || [];
    const fenceCount = fenceMatches.length;

    let chunkText = (openFence ? openFence + "\n" : "") + cut;
    if (fenceCount % 2 !== 0) {
      // Splitting inside a code fence — close it and reopen in next chunk
      chunkText += "\n```";
      // Reopen with the last opening fence tag (preserves language)
      const lastOpenTag = fenceMatches[fenceMatches.length - 1] || "```";
      openFence = lastOpenTag;
    } else {
      openFence = "";
    }

    chunks.push(chunkText);
    remaining = remaining.slice(breakAt).trimStart();
  }

  // Apply minLen merging: merge small trailing chunks with predecessor
  if (minLen > 0 && chunks.length > 1) {
    const merged: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const last = merged[merged.length - 1];
      if (
        chunks[i].length < minLen &&
        (last + "\n" + chunks[i]).length <= maxLen
      ) {
        merged[merged.length - 1] = last + "\n" + chunks[i];
      } else {
        merged.push(chunks[i]);
      }
    }
    return merged;
  }

  return chunks;
}

// --- Session management ---

async function getOrCreateSession(
  userId: string,
  channelId: string,
  threadTs: string,
  firstMessage?: string,
): Promise<{ id: string; isNew: boolean }> {
  const externalId = getExternalId(channelId, threadTs);
  const preferredSessionKey = buildSessionKey({
    scope: "main",
    channel: "slack",
    conversationId: channelId,
    threadId: threadTs,
  });
  const [session] = await db
    .insert(avaSessions)
    .values({
      userId,
      externalId,
      source: "slack",
      title: firstMessage ? firstMessage.slice(0, 100) : "Slack conversation",
      status: "active",
    })
    .onConflictDoUpdate({
      target: avaSessions.externalId,
      set: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        status: "active",
        lifecycleState: "active",
        archivedAt: null,
        deletedAt: null,
        archivedByReason: null,
      },
    })
    .returning();

  const isNew =
    !session.lastMessageAt ||
    session.lastMessageAt.getTime() === session.createdAt?.getTime();

  if (isNew) {
    console.log(
      `Created new Slack session: ${session.id} for thread ${externalId}`,
    );
  }

  await sessionKeyResolverService.ensureBoundIdentity({
    sessionId: session.id,
    preferredSessionKey,
    agentId: "main",
    scope: "slack",
  });

  await sessionBindingService.updateBindingFromInbound(session.id, {
    channel: "slack",
    externalId,
    slack: {
      channelId,
      threadTs: isDmSession(threadTs) ? undefined : threadTs,
    },
  });

  return { id: session.id, isNew };
}

// --- Slash commands (parsed from text) ---

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

async function handleSlashCommand(
  message: string,
  client: WebClient,
  channelId: string,
  threadTs: string,
  slackUserId?: string,
): Promise<boolean> {
  const trimmed = message.trim().toLowerCase();

  if (trimmed.startsWith("/think")) {
    const level = trimmed.replace("/think", "").trim() || "high";
    if (!VALID_THINKING_LEVELS.includes(level)) {
      await postMessage(
        client,
        channelId,
        `Invalid thinking level. Valid: ${VALID_THINKING_LEVELS.join(", ")}`,
        threadTs,
      );
      return true;
    }
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      const metadata = (session.metadata || {}) as Record<string, unknown>;
      metadata.thinkingLevel = level;
      await db
        .update(avaSessions)
        .set({ metadata })
        .where(eq(avaSessions.id, session.id));
    }
    await postMessage(
      client,
      channelId,
      `Thinking level set to: *${level}*`,
      threadTs,
    );
    return true;
  }

  if (trimmed === "/status") {
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      const metadata = (session.metadata || {}) as Record<string, unknown>;
      const flowMode = await resolveSessionSubagentFlowMode(session.id);
      await postMessage(
        client,
        channelId,
        [
          `*Session:* ${session.id}`,
          `*Tokens:* ${session.tokenCount}`,
          `*Thinking:* ${metadata.thinkingLevel || "off"}`,
          `*Subagent Flow:* ${flowMode}`,
          `*Created:* ${session.createdAt?.toISOString()}`,
        ].join("\n"),
        threadTs,
      );
    } else {
      await postMessage(
        client,
        channelId,
        "No active session in this thread.",
        threadTs,
      );
    }
    return true;
  }

  if (trimmed.startsWith("/approve")) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      await postMessage(
        client,
        channelId,
        "Usage: /approve <id> allow-once|allow-always|deny",
        threadTs,
      );
      return true;
    }

    if (!slackUserId) {
      await postMessage(
        client,
        channelId,
        "Cannot resolve approval: missing Slack user identity.",
        threadTs,
      );
      return true;
    }

    const approvalId = parts[1].trim();
    const decisionAlias = parts[2].trim().toLowerCase();
    const decisionMap: Record<string, ExecApprovalDecision> = {
      allow: "allow-once",
      once: "allow-once",
      "allow-once": "allow-once",
      allowonce: "allow-once",
      always: "allow-always",
      "allow-always": "allow-always",
      allowalways: "allow-always",
      deny: "deny",
      reject: "deny",
      block: "deny",
    };
    const decision = decisionMap[decisionAlias];
    if (!decision) {
      await postMessage(
        client,
        channelId,
        "Decision must be allow-once, allow-always, or deny.",
        threadTs,
      );
      return true;
    }

    const resolved = await resolveExecApprovalDecisionBySlackUser({
      approvalId,
      decision,
      slackUserId,
    });

    if (!resolved.ok) {
      await postMessage(
        client,
        channelId,
        `Approval could not be applied: ${resolved.reason ?? "unknown error"}.`,
        threadTs,
      );
      return true;
    }

    await postMessage(
      client,
      channelId,
      `Exec approval ${decision} submitted for ${approvalId}.`,
      threadTs,
    );
    return true;
  }

  if (trimmed === "/new" || trimmed === "/reset") {
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      await archiveSessionAndTerminateWork(session.id, "slack-reset-command");
      await db
        .update(avaSessions)
        .set({ externalId: null })
        .where(eq(avaSessions.id, session.id));
      pendingQueues.delete(session.id);
      sessionQueueModes.delete(session.id);
      await postMessage(
        client,
        channelId,
        "Session reset. Start a new conversation.",
        threadTs,
      );
    } else {
      await postMessage(client, channelId, "No session to reset.", threadTs);
    }
    return true;
  }

  // /stop — abort the current agent run
  if (trimmed === "/stop") {
    const stopped = await stopActiveRunForThread({
      client,
      channelId,
      threadTs,
      ackText: "Stopping current run...",
    });
    if (!stopped) {
      await postMessage(client, channelId, "No active run to stop.", threadTs);
    }
    return true;
  }

  // /compact — compress conversation history
  if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      await postMessage(
        client,
        channelId,
        "Compacting conversation history...",
        threadTs,
      );
      try {
        const { buildCompactionPrompt } =
          await import("../../agent/system-prompt.js");
        const { PostgresSessionAdapter } =
          await import("../../agent/session-adapter.js");
        const adapter = new PostgresSessionAdapter(session.id);
        const messages = await adapter.loadMessages();
        if (messages.length > 0) {
          const msgSummary = messages
            .map(
              (m) =>
                `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[content]"}`,
            )
            .join("\n");
          const summary = buildCompactionPrompt(msgSummary).slice(0, 5000);
          await db
            .update(avaSessions)
            .set({ contextSummary: summary })
            .where(eq(avaSessions.id, session.id));
          await adapter.clearMessages();
          await postMessage(
            client,
            channelId,
            `Context compacted. ${messages.length} messages summarized.`,
            threadTs,
          );
        } else {
          await postMessage(client, channelId, "Nothing to compact.", threadTs);
        }
      } catch (err) {
        console.error("[COMPACT] Failed:", err);
        await postMessage(client, channelId, "Compaction failed.", threadTs);
      }
    } else {
      await postMessage(client, channelId, "No active session.", threadTs);
    }
    return true;
  }

  // /max on|off — toggle Claude Opus (Max mode)
  if (trimmed.startsWith("/max")) {
    const arg = trimmed.replace("/max", "").trim();
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);

    if (!session) {
      await postMessage(client, channelId, "No active session.", threadTs);
      return true;
    }

    const metadata = (session.metadata || {}) as Record<string, unknown>;
    let replyText: string;

    if (arg === "on") {
      metadata.modelOverride = "claude-opus-4-6";
      replyText = `🔥 *Max mode activated.* Switched to *claude-opus-4-6* (Claude Opus). Use \`/max off\` to switch back.`;
    } else if (arg === "off") {
      metadata.modelOverride = null; // Clear the override
      replyText = `😴 *Max mode deactivated.* Switched back to default model.`;
    } else if (arg === "") {
      replyText = "Usage: `/max on|off` — toggle Opus max power mode";
    } else {
      // Handle any other invalid arguments
      replyText = "Usage: `/max on|off` — toggle Opus max power mode";
    }

    await db
      .update(avaSessions)
      .set({ metadata })
      .where(eq(avaSessions.id, session.id));
    await postMessage(client, channelId, replyText, threadTs);
    return true;
  }

  // /model <name> — switch model in-thread
  if (trimmed.startsWith("/model")) {
    const modelId = trimmed.replace("/model", "").trim();
    if (!modelId) {
      await postMessage(
        client,
        channelId,
        "Usage: `/model <model-name>` (e.g. `/model gemini-2.5-pro`)",
        threadTs,
      );
      return true;
    }
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      const metadata = (session.metadata || {}) as Record<string, unknown>;
      metadata.modelOverride = modelId;
      await db
        .update(avaSessions)
        .set({ metadata })
        .where(eq(avaSessions.id, session.id));
      await postMessage(
        client,
        channelId,
        `Model set to: *${modelId}*`,
        threadTs,
      );
    } else {
      await postMessage(client, channelId, "No active session.", threadTs);
    }
    return true;
  }

  // /verbose on|off — deprecated (streaming is always on)
  if (trimmed === "/verbose on" || trimmed === "/verbose off") {
    await postMessage(
      client,
      channelId,
      "Responses are now always streamed in real-time. The `/verbose` toggle is no longer needed.",
      threadTs,
    );
    return true;
  }

  // /queue mode <collect|followup|steer|steer-backlog|interrupt>
  if (trimmed.startsWith("/queue mode")) {
    const requested = trimmed.replace("/queue mode", "").trim().toLowerCase();
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (!session) {
      await postMessage(client, channelId, "No active session.", threadTs);
      return true;
    }
    if (!requested) {
      const currentMode = await resolveSessionQueueMode(session.id);
      await postMessage(
        client,
        channelId,
        `Current queue mode: *${currentMode}*\nUsage: \`/queue mode <collect|followup|steer|steer-backlog|interrupt>\``,
        threadTs,
      );
      return true;
    }
    if (!isSessionQueueMode(requested)) {
      await postMessage(
        client,
        channelId,
        `Invalid queue mode: \`${requested}\`. Use one of: collect, followup, steer, steer-backlog, interrupt.`,
        threadTs,
      );
      return true;
    }
    await setSessionQueueMode(session.id, requested);
    await postMessage(
      client,
      channelId,
      `Queue mode set to *${requested}*.`,
      threadTs,
    );
    return true;
  }

  // /queue — show queue status or clear
  if (trimmed === "/queue" || trimmed === "/queue status") {
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      const isRunning = activeRuns.has(session.id);
      const pending = pendingQueues.get(session.id)?.length || 0;
      const mode = await resolveSessionQueueMode(session.id);
      await postMessage(
        client,
        channelId,
        [
          `*Queue status:*`,
          `Mode: ${mode}`,
          `Active run: ${isRunning ? "yes" : "no"}`,
          `Pending messages: ${pending}`,
          `Global runs: ${globalRunCount}/${MAX_CONCURRENT_RUNS}`,
        ].join("\n"),
        threadTs,
      );
    } else {
      await postMessage(client, channelId, "No active session.", threadTs);
    }
    return true;
  }

  // /flow / /flow mode <async|supervisor|default>
  if (trimmed === "/flow" || trimmed.startsWith("/flow mode")) {
    const requested = trimmed
      .replace("/flow mode", "")
      .trim()
      .toLowerCase();
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (!session) {
      await postMessage(client, channelId, "No active session.", threadTs);
      return true;
    }

    if (!requested || trimmed === "/flow") {
      const metadata = (session.metadata || {}) as Record<string, unknown>;
      const override =
        typeof metadata.subagentFlowMode === "string"
          ? metadata.subagentFlowMode
          : "default";
      const effectiveMode = await resolveSessionSubagentFlowMode(session.id);
      await postMessage(
        client,
        channelId,
        [
          `*Subagent flow mode:* ${effectiveMode}`,
          `Override: ${override}`,
          "Usage: `/flow mode <async|supervisor|default>`",
        ].join("\n"),
        threadTs,
      );
      return true;
    }

    if (!isSessionSubagentFlowModeInput(requested)) {
      await postMessage(
        client,
        channelId,
        `Invalid flow mode: \`${requested}\`. Use one of: async, supervisor, default.`,
        threadTs,
      );
      return true;
    }

    const effectiveMode = await setSessionSubagentFlowMode(session.id, requested);
    const overrideLabel =
      requested === "default" ? "default (inherit global config)" : requested;
    await postMessage(
      client,
      channelId,
      `Flow mode set to *${overrideLabel}*. Effective mode: *${effectiveMode}*.`,
      threadTs,
    );
    return true;
  }

  if (trimmed === "/queue clear") {
    const externalId = getExternalId(channelId, threadTs);
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(eq(avaSessions.externalId, externalId))
      .limit(1);
    if (session) {
      const count = pendingQueues.get(session.id)?.length || 0;
      pendingQueues.delete(session.id);
      await postMessage(
        client,
        channelId,
        `Cleared ${count} pending message(s).`,
        threadTs,
      );
    } else {
      await postMessage(client, channelId, "No active session.", threadTs);
    }
    return true;
  }

  // /subagents — manage sub-agent runs (placeholder — lists active runs)
  if (trimmed.startsWith("/subagents")) {
    await postMessage(
      client,
      channelId,
      "Sub-agent management coming soon. Use `spawn_subagent` via the agent for now.",
      threadTs,
    );
    return true;
  }

  // /bash <cmd> or ! <cmd> — run shell command directly (gated)
  if (trimmed.startsWith("/bash ") || message.trim().startsWith("! ")) {
    if (!cfg.slack.bashEnabled) {
      await postMessage(
        client,
        channelId,
        "Bash commands disabled. Set `SLACK_BASH_ENABLED=true` to enable.",
        threadTs,
      );
      return true;
    }
    const cmd = message.trim().replace(/^\/(bash)\s+|^!\s+/, "");
    if (!cmd) {
      await postMessage(
        client,
        channelId,
        "Usage: `/bash <command>` or `! <command>`",
        threadTs,
      );
      return true;
    }
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync(cmd, {
        timeout: 30000,
        encoding: "utf-8",
        maxBuffer: 50 * 1024,
      }).trim();
      const truncated =
        output.length > SLACK_MAX_MSG_LEN - 20
          ? output.slice(0, SLACK_MAX_MSG_LEN - 20) + "\n...(truncated)"
          : output;
      await postMessage(
        client,
        channelId,
        `\`\`\`\n${truncated || "(no output)"}\n\`\`\``,
        threadTs,
      );
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error
          ? (err as { stderr?: string }).stderr || err.message
          : String(err);
      await postMessage(
        client,
        channelId,
        `\`\`\`\n${String(errMsg).slice(0, 500)}\n\`\`\``,
        threadTs,
      );
    }
    return true;
  }

  // ── User management commands (admin-only) ─────────────────────────

  if (trimmed === "/users" && slackUserId) {
    const { resolveUserContext: ruc } =
      await import("../../agent/user-context.js");
    const ctx = await ruc("slack", slackUserId);
    if (ctx.role !== "owner" && ctx.role !== "admin") {
      await postMessage(
        client,
        channelId,
        "Only owner/admin can list users.",
        threadTs,
      );
      return true;
    }
    const { listUsers, getUserIdentities } =
      await import("../../services/user.service.js");
    const users = await listUsers();
    const lines: string[] = [];
    for (const u of users) {
      const identities = await getUserIdentities(u.id);
      const slackId = identities.find(
        (i) => i.provider === "slack",
      )?.externalId;
      const label = slackId
        ? `<@${slackId}>`
        : u.displayName || u.id.slice(0, 8);
      const extras = identities
        .filter((i) => i.provider !== "slack")
        .map((i) => `${i.provider}: ${i.externalId}`);
      const extraStr = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      lines.push(`• ${label}${extraStr} — *${u.role}*`);
    }
    await postMessage(
      client,
      channelId,
      lines.length > 0 ? lines.join("\n") : "No users found.",
      threadTs,
    );
    return true;
  }

  if (trimmed.startsWith("/role ") && slackUserId) {
    const { resolveUserContext: ruc } =
      await import("../../agent/user-context.js");
    const ctx = await ruc("slack", slackUserId);
    if (ctx.role !== "owner") {
      await postMessage(
        client,
        channelId,
        "Only the owner can change roles.",
        threadTs,
      );
      return true;
    }
    const parts = message.trim().split(/\s+/);
    if (parts.length < 3) {
      await postMessage(
        client,
        channelId,
        "Usage: `/role @user admin|member`",
        threadTs,
      );
      return true;
    }
    const targetMention = parts[1];
    const newRole = parts[2].toLowerCase();
    if (newRole !== "admin" && newRole !== "member") {
      await postMessage(
        client,
        channelId,
        "Role must be `admin` or `member`.",
        threadTs,
      );
      return true;
    }
    const slackIdMatch = targetMention.match(/<@(\w+)>/);
    const targetSlackId = slackIdMatch ? slackIdMatch[1] : targetMention;
    const { getUserBySlackId, setUserRole } =
      await import("../../services/user.service.js");
    const targetUser = await getUserBySlackId(targetSlackId);
    if (!targetUser) {
      await postMessage(
        client,
        channelId,
        "User not found. They need to interact with Kai first.",
        threadTs,
      );
      return true;
    }
    if (targetUser.role === "owner") {
      await postMessage(
        client,
        channelId,
        "Cannot change the owner's role.",
        threadTs,
      );
      return true;
    }
    await setUserRole(targetUser.id, newRole as "admin" | "member");
    await postMessage(
      client,
      channelId,
      `Role for <@${targetSlackId}> set to *${newRole}*.`,
      threadTs,
    );
    return true;
  }

  // /help or /commands — list all available commands
  if (trimmed === "/help" || trimmed === "/commands") {
    await postMessage(
      client,
      channelId,
      [
        "*Available commands:*",
        "`/stop` — abort current run",
        "`/think <level>` — set thinking (off/minimal/low/medium/high)",
        "`/max on|off` — toggle Opus max power mode",
        "`/model <name>` — switch model",
        "`/verbose` — (deprecated, streaming is always on)",
        "`/compact` — compress conversation history",
        "`/queue` — show queue status",
        "`/queue mode <mode>` — set queue mode (collect/followup/steer/steer-backlog/interrupt)",
        "`/queue clear` — clear pending messages",
        "`/flow mode <async|supervisor|default>` — set subagent orchestration mode for this thread",
        "`/status` — session info",
        "`/new` or `/reset` — start fresh",
        "`/bash <cmd>` — run shell command (requires SLACK_BASH_ENABLED)",
        "",
        "*Admin:*",
        "`/users` — list all users (owner/admin only)",
        "`/role @user admin|member` — change a user's role (owner only)",
        "",
        "_Credentials, identity linking, and preferences are handled conversationally — just tell Kai._",
        "",
        "`/help` — this message",
      ].join("\n"),
      threadTs,
    );
    return true;
  }

  return false;
}

// --- Debounced message entry ---

export function enqueueSlackMessage(
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  messageTs: string,
  botUserId?: string,
  files?: SlackFile[],
  attachments?: SlackAttachment[],
): void {
  // Skip debounce for messages with file attachments
  const hasFiles = files && files.length > 0;

  const key = getThreadKey(channelId, threadTs);
  const existing = debounceMap.get(key);

  if (existing && !hasFiles) {
    // Add to buffer, reset timer
    if (text) existing.messages.push(text);
    if (attachments?.length) existing.attachments.push(...attachments);
    existing.messageTs = messageTs;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushDebounce(key), DEBOUNCE_MS);
    existing.timer.unref();
    return;
  }

  if (hasFiles) {
    // Flush any existing debounce and process immediately with files
    if (existing) {
      clearTimeout(existing.timer);
      debounceMap.delete(key);
      if (existing.messages.length > 0) {
        const combinedText = existing.messages.join("\n");
        handleSlackMessage(
          existing.channelId,
          existing.threadTs,
          existing.userId,
          combinedText,
          existing.messageTs,
          existing.botUserId,
          undefined,
          existing.attachments.length > 0 ? existing.attachments : undefined,
        ).catch(console.error);
      }
    }
    handleSlackMessage(
      channelId,
      threadTs,
      userId,
      text,
      messageTs,
      botUserId,
      files,
      attachments,
    ).catch(console.error);
    return;
  }

  // New debounce entry
  const timer = setTimeout(() => flushDebounce(key), DEBOUNCE_MS);
  timer.unref();
  const entry: DebouncedMessage = {
    messages: text ? [text] : [],
    files: [],
    attachments: attachments ? [...attachments] : [],
    channelId,
    threadTs,
    userId,
    botUserId,
    messageTs,
    timer,
  };
  debounceMap.set(key, entry);
}

async function flushDebounce(key: string): Promise<void> {
  const entry = debounceMap.get(key);
  if (!entry) return;
  debounceMap.delete(key);

  const combinedText = entry.messages.join("\n");
  console.log(
    `[SLACK] Debounce flush: ${key} (${entry.messages.length} msg(s), ${combinedText.length} chars)`,
  );
  try {
    await handleSlackMessage(
      entry.channelId,
      entry.threadTs,
      entry.userId,
      combinedText,
      entry.messageTs,
      entry.botUserId,
      entry.files.length > 0 ? entry.files : undefined,
      entry.attachments.length > 0 ? entry.attachments : undefined,
    );
  } catch (error) {
    console.error("Error in debounced message handler:", error);
  }
}

// --- Main message handler ---

export async function handleSlackMessage(
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  messageTs: string,
  botUserId?: string,
  files?: SlackFile[],
  attachments?: SlackAttachment[],
): Promise<void> {
  console.log("Slack message received", {
    channelId,
    threadTs,
    userId,
    textLength: text.length,
    fileCount: files?.length ?? 0,
  });

  const client = getSlackApp().client;

  // Clean message text
  let userMessage = sanitizeInboundMessage(cleanSlackMessage(text, botUserId));

  // Handle slash commands (before debouncing — they should be instant)
  const slashResult = await handleSlashCommand(
    userMessage,
    client,
    channelId,
    threadTs,
    userId,
  );
  if (slashResult) return;

  // Natural-language stop intent routes through the same control lane as /stop.
  if (isNaturalLanguageStopIntent(userMessage)) {
    const stopped = await stopActiveRunForThread({
      client,
      channelId,
      threadTs,
      ackText: "Stopping current run and clearing queued follow-ups.",
    });
    if (stopped) return;
  }

  // Add ack reaction (scoped by SLACK_ACK_REACTION_SCOPE: all/dms/mentions/off)
  const isDm = isDmSession(threadTs);
  const shouldAck =
    ACK_SCOPE === "off"
      ? false
      : ACK_SCOPE === "dms"
        ? isDm
        : ACK_SCOPE === "mentions"
          ? !isDm
          : true; // "all" or unrecognized = always ack
  if (shouldAck) {
    await addAckReaction(client, channelId, messageTs);
  }

  // Download and process any attached files
  let downloadedFiles: DownloadedFile[] = [];
  if (files && files.length > 0) {
    console.log(`Downloading ${files.length} file(s) from Slack`);
    downloadedFiles = await Promise.all(files.map(downloadSlackFile));

    const mediaResults = await processMediaFiles(downloadedFiles);
    const mediaContext = formatMediaContext(mediaResults);
    const fileContext = await processFilesForAgent(downloadedFiles);
    const combinedContext = [mediaContext, fileContext]
      .filter(Boolean)
      .join("\n\n");
    if (combinedContext) {
      userMessage = userMessage
        ? `${userMessage}\n\n## Attached Files\n${combinedContext}`
        : `## Attached Files\n${combinedContext}`;
    }
  }

  // Extract shared message context from attachments
  if (attachments?.length) {
    const sharedMessages = attachments
      .filter((a) => a.is_msg_unfurl || a.from_url)
      .map((a) => {
        const author = a.author_name || "Unknown";
        const channel = a.channel_name ? `#${a.channel_name}` : "";
        const content = a.text || a.fallback || "";
        if (!content) return "";
        return `[Shared message from ${author}${channel ? ` in ${channel}` : ""}]\n${content}`;
      })
      .filter(Boolean);

    // Also include non-unfurl attachments that have text (e.g., bot attachments)
    const otherAttachments = attachments
      .filter((a) => !a.is_msg_unfurl && !a.from_url && (a.text || a.fallback))
      .map((a) => {
        const content = a.text || a.fallback || "";
        const author = a.author_name ? `[From ${a.author_name}] ` : "";
        return `${author}${content}`;
      })
      .filter(Boolean);

    const allContext = [...sharedMessages, ...otherAttachments];
    if (allContext.length > 0) {
      const attachmentContext = allContext.join("\n\n");
      userMessage = userMessage
        ? `${userMessage}\n\n## Shared Messages\n${attachmentContext}`
        : `## Shared Messages\n${attachmentContext}`;
    }
  }

  // Handle empty message
  if (!userMessage) {
    await postMessage(
      client,
      channelId,
      "Hi! I'm Kai, your team coworker. How can I help today?",
      threadTs,
    );
    await removeAckReaction(client, channelId, messageTs);
    return;
  }

  // Resolve sender name and channel info for structured envelope
  const senderName = await resolveUserName(client, userId);
  const channelType = isDm ? "direct" : "channel";
  let channelName: string | undefined;
  if (!isDm) {
    const info = await resolveChannelInfo(client, channelId);
    channelName = info.name;
  }

  // Format with structured inbound envelope (thread context injected after session check below)
  userMessage = formatInboundEnvelope({
    senderName,
    channelName,
    channelType,
    timestamp: messageTs,
    text: userMessage,
  });

  // Inject system events (edits, deletes, reactions since last run)
  const sysEvents = drainSystemEvents(channelId, threadTs);
  if (sysEvents) {
    userMessage = `${sysEvents}\n\n${userMessage}`;
  }

  // Inject pending channel history (messages before @mention)
  const pendingCtx = drainPendingHistory(channelId);
  if (pendingCtx) {
    userMessage = `${pendingCtx}\n\n${userMessage}`;
  }

  // Build and persist group chat context (survives compaction via session metadata)
  let groupChatContext: string | undefined;
  if (!isDm && channelName) {
    const info = await resolveChannelInfo(client, channelId);
    const metaParts: string[] = [];
    if (info.topic) metaParts.push(`Topic: ${info.topic}`);
    if (info.purpose) metaParts.push(`Purpose: ${info.purpose}`);

    // Build group chat context for system prompt injection
    const contextLines = [`This is a group conversation in #${info.name}.`];
    if (metaParts.length > 0) {
      contextLines.push(metaParts.join(" | "));
    }
    contextLines.push(
      "Multiple participants may be present. Only respond when relevant.",
      "Address people by name when responding to specific messages.",
      "If no user-facing reply is needed, output exactly one JSON control envelope and nothing else: {\"v\":1,\"action\":\"suppress\",\"reason\":\"group-chat-no-response-needed\"}.",
      "Do not output explanatory meta messages. Use the control envelope instead.",
    );
    groupChatContext = contextLines.join("\n");

    // Also inject into user message for immediate context (first-turn backward compat)
    if (metaParts.length > 0) {
      userMessage = `[Channel #${info.name}: ${metaParts.join(" | ")}]\n\n${userMessage}`;
    }
  }

  // Get or create session
  const { id: sessionId, isNew } = await getOrCreateSession(
    userId,
    channelId,
    threadTs,
    userMessage,
  );
  console.log(
    `[SLACK] Session ${sessionId} (${isNew ? "new" : "existing"}) for ${channelId}:${threadTs}`,
  );

  // Fetch thread history (full history for new sessions, just starter for existing)
  const threadHistory = await getThreadHistory(
    client,
    channelId,
    threadTs,
    messageTs,
    isNew,
  );
  if (threadHistory?.context) {
    const label = isNew ? "## Thread History" : "## Thread Context";
    userMessage = `${label}\n${threadHistory.context}\n\n${userMessage}`;
  }

  // Hydrate media from thread starter if current message has no files
  if (!files?.length && threadHistory?.starterFiles?.length) {
    console.log(
      `[SLACK] Hydrating ${threadHistory.starterFiles.length} file(s) from thread starter`,
    );
    const starterDownloads = await Promise.all(
      threadHistory.starterFiles.map(downloadSlackFile),
    );
    const mediaResults = await processMediaFiles(starterDownloads);
    const mediaContext = formatMediaContext(mediaResults);
    const fileContext = await processFilesForAgent(starterDownloads);
    const combinedContext = [mediaContext, fileContext]
      .filter(Boolean)
      .join("\n\n");
    if (combinedContext) {
      userMessage = `${userMessage}\n\n## Thread Starter Files\n${combinedContext}`;
    }
    downloadedFiles = starterDownloads;
  }

  // Create reply delivery plan for threading (per-chat-type mode)
  const chatTypeKey = isDm ? "direct" : "channel";
  const effectiveReplyMode = REPLY_TO_MODES[chatTypeKey];
  const replyPlan = createReplyDeliveryPlan({
    replyToMode: effectiveReplyMode,
    incomingThreadTs: isDmSession(threadTs) ? undefined : threadTs,
    messageTs,
  });
  const sessionQueueMode = await resolveSessionQueueMode(sessionId);

  // Run agent with session-level queue serialization
  await withSessionQueue(
    sessionId,
    { text: userMessage, channelId, threadTs, messageTs },
    sessionQueueMode,
    async (queuedMessage, queuedMessageTs, abortSignal) => {
      await runAgentAndRespond(
        client,
        channelId,
        threadTs,
        sessionId,
        userId,
        queuedMessage,
        queuedMessageTs,
        downloadedFiles,
        abortSignal,
        replyPlan,
        groupChatContext,
      );
    },
  );
}

/**
 * Execute the agent run and post the response.
 * Uses direct executeAgentWithPi call (no gateway middleman).
 * Callbacks are scoped to this specific run — no cross-session leaking.
 */
async function runAgentAndRespond(
  client: WebClient,
  channelId: string,
  threadTs: string,
  sessionId: string,
  userId: string,
  userMessage: string,
  messageTs: string,
  downloadedFiles: DownloadedFile[],
  abortSignal?: AbortSignal,
  replyPlan?: ReplyDeliveryPlan,
  groupChatContext?: string,
): Promise<void> {
  console.log(
    `[SLACK] Starting agent run for session=${sessionId} user=${userId} messageLen=${userMessage.length}`,
  );
  const typing = createTypingKeepaliveController({
    keepaliveMs: SLACK_TYPING_KEEPALIVE_MS,
    maxDurationMs: SLACK_TYPING_MAX_DURATION_MS,
    setStatus: async (status) => {
      await setTypingStatus(client, channelId, threadTs, status);
    },
  });
  await typing.start("is thinking...");

  // Reply helper — uses delivery plan for threading control (fallback path)
  const sendReply = async (text: string) => {
    const replyThreadTs =
      replyPlan?.nextThreadTs() ??
      (isDmSession(threadTs) ? undefined : threadTs);
    const ts = await postMessage(client, channelId, text, replyThreadTs);
    replyPlan?.markSent();
    return ts;
  };

  // Track texts sent via messaging tools (for duplicate suppression)
  const messagingToolSentTexts: string[] = [];

  // --- Persistent stream session (one growing message per run) ---
  type StreamSession = {
    streamer: ReturnType<WebClient["chatStream"]>;
    stopped: boolean;
  };
  let streamSession: StreamSession | null = null;
  let streamFailed = false;
  let clearedTyping = false;

  const stopStreamSession = async () => {
    if (streamSession && !streamSession.stopped) {
      streamSession.stopped = true;
      try {
        await streamSession.streamer.stop();
        replyPlan?.markSent();
      } catch (err) {
        console.error("[SLACK-STREAM] stop failed:", err);
      }
    }
  };

  // --- Reply dispatcher: serializes all outbound deliveries ---
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, { kind }) => {
      const text = payload.text;
      // Clear typing on first delivery so "is thinking..." disappears
      if (!clearedTyping) {
        clearedTyping = true;
        await typing.clear();
      }

      const replyThreadTs = isDmSession(threadTs) ? undefined : threadTs;

      // Try native streaming (persistent session — one growing message)
      if (cfg.slack.nativeStreaming && replyThreadTs && !streamFailed) {
        try {
          if (!streamSession) {
            const authInfo = await getAuthInfo(client);
            streamSession = {
              streamer: client.chatStream({
                channel: channelId,
                thread_ts: replyThreadTs,
                ...(authInfo.teamId
                  ? { recipient_team_id: authInfo.teamId }
                  : {}),
                ...(authInfo.botUserId
                  ? { recipient_user_id: authInfo.botUserId }
                  : {}),
              }),
              stopped: false,
            };
          }
          await streamSession.streamer.append({ markdown_text: text });
          return;
        } catch (err) {
          console.error(
            `[SLACK-STREAM] ${kind} delivery failed, falling back:`,
            err,
          );
          streamFailed = true;
          streamSession = null;
        }
      }

      // Fallback: standard postMessage
      const chunks = chunkSlackMessage(text);
      for (const chunk of chunks) {
        await sendReply(chunk);
      }
    },
    onError: (err, { kind }) => {
      console.error(`[SLACK] Reply delivery error (${kind}):`, err);
    },
    humanDelay: getHumanDelay,
  });

  // Block buffer (accumulates text_delta events for block streaming)
  let blockBuffer = "";

  // Scan for image URLs in the message and inject vision hints
  const imageUrlRegex =
    /https?:\/\/[^\s>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s>]*)?/gi;
  const imageUrls = userMessage.match(imageUrlRegex);
  if (imageUrls && imageUrls.length > 0) {
    const uniqueUrls = [...new Set(imageUrls)].slice(0, 5);
    const imageHint = `\n\n[Images detected: ${uniqueUrls.join(", ")}. Use analyze_image to examine them if relevant.]`;
    userMessage += imageHint;
  }

  try {
    // Resolve user identity + config + credentials for this request
    const slackDisplayName = await resolveUserName(client, userId);
    const userContext = await resolveUserContext(
      "slack",
      userId,
      slackDisplayName,
    );

    // Direct agent execution — callbacks scoped to this run
    const result = await executeAgentWithPi({
      sessionId,
      userId,
      prompt: userMessage,
      abortSignal,
      externalId: getExternalId(channelId, threadTs),
      userContext,
      beforeStart: groupChatContext
        ? async () => ({ extraContext: groupChatContext })
        : undefined,
      onEvent: (event: AgentEvent) => {
        if (abortSignal?.aborted) return;

        // --- Block streaming: DISABLED per user request ---
        // Streaming sends intermediate messages during execution. User wants only ONE final message.
        // Just accumulate text; final reply sent at lines 1742-1752
        if (event.type === "text_delta" && event.text) {
          blockBuffer += event.text;
        }

        // NOTE: text_end and tool_call no longer send intermediate blocks
        // Old code (now disabled):
        //   if (event.type === "text_end" && blockBuffer) { dispatcher.sendBlockReply(...); }
        //   if (event.type === "tool_call" && blockBuffer) { dispatcher.sendBlockReply(...); }

        // --- Typing status, tool tracking, errors ---
        if (event.type === "tool_call" && event.call) {
          console.log(
            `[SLACK] Tool call: ${event.call.name} (session=${sessionId})`,
          );
          const toolLabel =
            event.call.name === "browser"
              ? "Browsing..."
              : event.call.name === "exec"
                ? "Running command..."
                : event.call.name === "web_search"
                  ? "Searching the web..."
                  : event.call.name === "web_fetch"
                    ? "Fetching content..."
                    : event.call.name === "python_exec"
                      ? "Running Python..."
                      : event.call.name === "memory"
                        ? "Checking memory..."
                        : event.call.name === "spawn_subagent"
                          ? "Spawning sub-agent..."
                          : `Using ${event.call.name}...`;
          void typing.updateStatus(toolLabel);
        }

        if (event.type === "tool_call" && event.call) {
          const sentText = extractMessagingToolSentText(event.call);
          if (sentText) messagingToolSentTexts.push(sentText);
        }

        if (event.type === "error") {
          console.error(
            `[SLACK] Agent error: ${event.error} (session=${sessionId})`,
          );
        }
      },
    });

    // If aborted during execution, clean up stream and bail
    if (abortSignal?.aborted) {
      await stopStreamSession();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      await typing.clear();
      await removeAckReaction(client, channelId, messageTs);
      return;
    }

    // With streaming disabled, blockBuffer contains accumulated text but wasn't sent yet.
    // Use it as fallback if result.content is empty.
    const rawContent = result.content || blockBuffer;
    blockBuffer = ""; // Clear buffer

    const controlEnvelope = parseControlEnvelopeWithLegacyFallback(rawContent);
    const deliveryControl = toDeliveryControl(controlEnvelope, rawContent);
    let finalText: string | null = null;
    if (deliveryControl.mode === "deliver") {
      finalText = normalizeSlackReply(deliveryControl.text);
    } else {
      console.log("[SLACK] Final reply suppressed by control envelope", {
        sessionId,
        reason: deliveryControl.reason,
      });
    }
    if (
      finalText &&
      isMessagingToolDuplicate(finalText, messagingToolSentTexts)
    ) {
      finalText = null;
    }
    if (finalText) {
      dispatcher.sendFinalReply(markdownToSlackMrkdwn(finalText));
    }

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // Finalize the persistent stream session (turns the growing message into a normal message)
    await stopStreamSession();

    // Clear typing
    await typing.clear();

    // Update session metadata
    if (result.usage) {
      await db
        .update(avaSessions)
        .set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          tokenCount: result.usage.totalTokens,
        })
        .where(eq(avaSessions.id, sessionId));
    }

    // TTS: synthesize and upload audio for the final reply
    const ttsMode = resolveTtsMode();
    if (ttsMode === "final") {
      const ttsText = result.content?.trim();
      if (ttsText && normalizeSlackReply(ttsText) !== null) {
        try {
          const ttsResult = await synthesizeSpeech(ttsText);
          if (ttsResult) {
            const ttsThreadTs =
              replyPlan?.nextThreadTs() ??
              (isDmSession(threadTs) ? undefined : threadTs);
            await uploadFileToSlack({
              channelId,
              threadTs: ttsThreadTs,
              filePath: ttsResult.filePath,
              filename: "reply.mp3",
              title: "Voice reply",
            });
            replyPlan?.markSent();
          }
        } catch (err) {
          console.error("[TTS] Failed to synthesize reply:", err);
        }
      }
    }

    console.log(
      dispatcher.didDeliver()
        ? "Slack response sent"
        : "Slack response suppressed",
      {
        channelId,
        threadTs,
        sessionId,
        responseLength: result.content?.length || 0,
        tokensUsed: result.usage?.totalTokens,
        counts: dispatcher.getQueuedCounts(),
      },
    );

    // Remove ack reaction
    await removeAckReaction(client, channelId, messageTs);

    // Cleanup temp files
    for (const file of downloadedFiles) {
      if (file.localPath) {
        cleanupTempFile(file.localPath).catch(() => {});
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    await typing.clear();
    await removeAckReaction(client, channelId, messageTs);

    if (errMsg.includes("aborted") || abortSignal?.aborted) {
      console.log(`[SLACK] Agent run aborted for session=${sessionId}`);
      const abortReason =
        typeof abortSignal?.reason === "string" ? abortSignal.reason : "";
      const shouldAnnounceStop = !abortReason.startsWith("queue-");
      if (shouldAnnounceStop) {
        await sendReply("Run stopped.");
      }
    } else {
      console.error(
        `[SLACK] Agent run FAILED for session=${sessionId}:`,
        errMsg,
      );
      if (errStack) console.error(errStack);
      await sendReply("I encountered an unexpected error. Please try again.");
    }
  } finally {
    typing.dispose();
  }
}

/**
 * Test-only surface for runtime internals that are otherwise private.
 */
export const __testing = {
  runAgentAndRespond,
  withSessionQueue,
  isNaturalLanguageStopIntent,
  stopActiveRunForThread,
  resetQueueState: () => {
    activeRuns.clear();
    activeAbortControllers.clear();
    pendingQueues.clear();
    sessionQueueModes.clear();
    globalRunCount = 0;
  },
  setSessionQueueMode: (sessionId: string, mode: SessionQueueMode) => {
    sessionQueueModes.set(sessionId, mode);
  },
};
