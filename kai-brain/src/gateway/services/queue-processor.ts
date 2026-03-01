/**
 * Queue Processor
 *
 * Processes queued agent requests in the background.
 * Polls for pending items and executes them.
 */
import { queueService } from "./queue.js";
import type { QueueItem } from "./queue.js";
import { runtime } from "../runtime.js";
import {
  executeAgentWithPi,
  type AgentEvent,
} from "../../agent/executor-pi.js";
import { getContextSummary } from "../../agent/compaction.js";
import { resolveUserContext } from "../../agent/user-context.js";
import type {
  AgentStartedEvent,
  AgentThinkingEvent,
  AgentChunkEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentCompletedEvent,
  AgentErrorEvent,
  ChatEvent,
} from "../protocol/events.js";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { eq } from "drizzle-orm";
import { slackClient } from "../../lib/slack/app.js";
import { markdownToSlackMrkdwn } from "../../lib/slack/format.js";
import { queueLogger as log } from "../../lib/logger.js";
import {
  SANDBOX_UNAVAILABLE_CODE,
  isSandboxUnavailableError,
} from "../../sandbox/errors.js";
import {
  CONTROL_ENVELOPE_REQUIREMENT,
  parseControlEnvelopeWithLegacyFallback,
  toDeliveryControl,
} from "../../core/control-envelope.js";
import { resolveGatewaySessionIdentity } from "./session-identity.js";

const SAFETY_POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT_SESSIONS = 10;

class QueueProcessor {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private activeSessions = new Set<string>();

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("Queue processor started");

    // Wire event-driven drain
    queueService.onEnqueue = () => this.drain();

    queueService.recoverStuck().then((count) => {
      if (count > 0) {
        log.info({ count }, "Recovered stuck queue items");
      }
    });

    // Process already-queued work immediately on startup.
    this.drain();
    this.scheduleSafetyPoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("Queue processor stopped");
  }

  /**
   * Test-only reset for queue processor singleton state.
   */
  resetForTests(): void {
    this.stop();
    this.draining = false;
    this.activeSessions.clear();
  }

  /** Event-driven drain — call when items are enqueued. */
  drain(): void {
    if (!this.running || this.draining) return;
    this.draining = true;
    this.processNextItems().finally(() => {
      this.draining = false;
    });
  }

  /** Safety-net poll (infrequent fallback, not the primary mechanism). */
  private scheduleSafetyPoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.processNextItems().finally(() => this.scheduleSafetyPoll());
    }, SAFETY_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private async processNextItems(): Promise<void> {
    // Get stats to see if there's work to do
    const stats = await queueService.getStats();
    if (stats.pending === 0) return;

    // Get unique sessions with pending items
    const { db } = await import("../../db/client.js");
    const { avaQueue } = await import("../../db/schema/queue.js");
    const { eq } = await import("drizzle-orm");

    const pendingSessions = await db
      .selectDistinct({ sessionId: avaQueue.sessionId })
      .from(avaQueue)
      .where(eq(avaQueue.status, "pending"))
      .limit(MAX_CONCURRENT_SESSIONS);

    // Process each session that isn't already active
    const promises = pendingSessions
      .filter((s) => !this.activeSessions.has(s.sessionId))
      .filter((s) => !this.hasActiveRuntimeRun(s.sessionId))
      .map((s) => this.processSession(s.sessionId));

    await Promise.allSettled(promises);
  }

  private hasActiveRuntimeRun(sessionId: string): boolean {
    return runtime
      .getRunsBySession(sessionId)
      .some((run) => run.status === "pending" || run.status === "running");
  }

  private async processSession(sessionId: string): Promise<void> {
    this.activeSessions.add(sessionId);

    try {
      // Dequeue next item for this session
      const item = await queueService.dequeue(sessionId);
      if (!item) {
        return;
      }

      await this.executeItem(item);
    } catch (error) {
      log.error({ err: error, sessionId }, "Error processing session");
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  private async executeItem(item: QueueItem): Promise<void> {
    const { id, sessionId, userId, message } = item;
    const sessionIdentity = await resolveGatewaySessionIdentity({ sessionId });
    const sessionKey = sessionIdentity?.sessionKey ?? sessionId;
    const emitChatStream =
      item.source === "heartbeat-internal-fallback" ||
      item.source === "subagent-completion";
    let chatSeq = 0;

    // Create run record
    const run = runtime.createRun(sessionId, userId);

    // Update queue item with run ID
    await this.updateQueueRunId(id, run.runId);

    // Broadcast started event
    const startedEvent: AgentStartedEvent = {
      event: "agent.started",
      payload: {
        runId: run.runId,
        sessionKey,
        startedAt: run.startedAt,
      },
    };
    runtime.broadcast(startedEvent, sessionId);

    try {
      runtime.updateRun(run.runId, { status: "running" });

      // For isolated mode (cron jobs), run without conversation history
      const isIsolated = item.mode === "isolated";
      const contextSummary = isIsolated
        ? undefined
        : await getContextSummary(sessionId);

      // For isolated mode, build a context-enriched prompt
      const prompt = isIsolated
        ? await buildScheduledTaskPrompt(
            message,
            sessionId,
            item.source,
            item.sourceMetadata as Record<string, unknown> | undefined,
          )
        : message;

      const userContext = await resolveUserContext("web", userId);

      const result = await executeAgentWithPi({
        sessionId,
        userId,
        userContext,
        prompt,
        contextSummary: contextSummary || undefined,
        skipHistory: isIsolated,
        abortSignal: run.abortController?.signal,
        onEvent: (event: AgentEvent) => {
          this.handleAgentEvent(run.runId, sessionId, event, {
            enabled: emitChatStream,
            sessionKey,
            emitChatDelta: (text: string) => {
              chatSeq += 1;
              const chatEvent: ChatEvent = {
                event: "chat",
                payload: {
                  runId: run.runId,
                  sessionKey,
                  seq: chatSeq,
                  state: "delta",
                  message: {
                    role: "assistant",
                    timestamp: Date.now(),
                    content: [{ type: "text", text }],
                  },
                },
              };
              runtime.broadcast(chatEvent, sessionId, { dropIfSlow: true });
            },
          });
        },
      });

      // Update run
      runtime.updateRun(run.runId, {
        status: "completed",
        completedAt: Date.now(),
        content: result.content,
        usage: result.usage,
      });

      // Complete queue item
      await queueService.complete(id, result.content, run.runId);

      // Broadcast completed event
      const completedAt = Date.now();
      const completedEvent: AgentCompletedEvent = {
        event: "agent.completed",
        payload: {
          runId: run.runId,
          sessionKey,
          content: result.content,
          usage: result.usage,
          completedAt,
        },
      };
      runtime.broadcast(completedEvent, sessionId);

      if (emitChatStream) {
        const envelope = parseControlEnvelopeWithLegacyFallback(result.content);
        const delivery = toDeliveryControl(envelope, result.content);
        const finalMessage = delivery.mode === "deliver" ? delivery.text.trim() : "";
        chatSeq += 1;
        const chatEvent: ChatEvent = {
          event: "chat",
          payload: {
            runId: run.runId,
            sessionKey,
            seq: chatSeq,
            state: "final",
            ...(finalMessage
              ? {
                  message: {
                    role: "assistant",
                    timestamp: completedAt,
                    content: [{ type: "text", text: finalMessage }],
                  },
                }
              : {}),
          },
        };
        runtime.broadcast(chatEvent, sessionId, { dropIfSlow: true });
      }

      // If this is a Slack session and triggered by cron, dispatch using typed
      // control-envelope semantics.
      if (item.source === "cron") {
        const controlEnvelope = parseControlEnvelopeWithLegacyFallback(result.content);
        const deliveryControl = toDeliveryControl(controlEnvelope, result.content);
        if (deliveryControl.mode === "deliver") {
          await this.notifySlackIfNeeded(sessionId, deliveryControl.text);
        } else {
          log.info(
            { sessionId, reason: deliveryControl.reason },
            "Suppressed cron delivery via control envelope",
          );
        }
      }
    } catch (error) {
      const errorMessage = isSandboxUnavailableError(error)
        ? `${SANDBOX_UNAVAILABLE_CODE}: ${error.message}`
        : (error instanceof Error ? error.message : String(error));
      if (isSandboxUnavailableError(error)) {
        log.warn(
          { sessionId, queueItemId: id, runId: run.runId },
          "Queue item failed due to sandbox unavailability (no retry)",
        );
      }

      runtime.updateRun(run.runId, {
        status: "error",
        completedAt: Date.now(),
        error: errorMessage,
      });

      // Fail queue item
      await queueService.fail(id, errorMessage);

      // Broadcast error event
      const errorAt = Date.now();
      const errorEvent: AgentErrorEvent = {
        event: "agent.error",
        payload: {
          runId: run.runId,
          sessionKey,
          error: errorMessage,
          errorAt,
        },
      };
      runtime.broadcast(errorEvent, sessionId);

      if (emitChatStream) {
        chatSeq += 1;
        const chatEvent: ChatEvent = {
          event: "chat",
          payload: {
            runId: run.runId,
            sessionKey,
            seq: chatSeq,
            state: "error",
            errorMessage,
          },
        };
        runtime.broadcast(chatEvent, sessionId, { dropIfSlow: true });
      }

    }
  }

  private handleAgentEvent(
    runId: string,
    sessionId: string,
    event: AgentEvent,
    chatContext?: {
      enabled: boolean;
      sessionKey: string;
      emitChatDelta: (text: string) => void;
    },
  ): void {
    switch (event.type) {
      case "thinking": {
        const thinkingEvent: AgentThinkingEvent = {
          event: "agent.thinking",
          payload: { runId },
        };
        runtime.broadcast(thinkingEvent, sessionId);
        break;
      }

      case "text_delta":
        if (event.text) {
          const chunkEvent: AgentChunkEvent = {
            event: "agent.chunk",
            payload: { runId, text: event.text },
          };
          runtime.broadcast(chunkEvent, sessionId);
          if (chatContext?.enabled) {
            chatContext.emitChatDelta(event.text);
          }
        }
        break;

      case "tool_call":
        if (event.call) {
          const toolCallEvent: AgentToolCallEvent = {
            event: "agent.tool_call",
            payload: {
              runId,
              toolName: event.call.name,
              args: event.call.args,
            },
          };
          runtime.broadcast(toolCallEvent, sessionId);
        }
        break;

      case "tool_result":
        if (event.result) {
          const toolResultEvent: AgentToolResultEvent = {
            event: "agent.tool_result",
            payload: {
              runId,
              toolName: event.result.name,
              result: event.result.result,
            },
          };
          runtime.broadcast(toolResultEvent, sessionId);
        }
        break;
    }
  }

  private async updateQueueRunId(itemId: string, runId: string): Promise<void> {
    const { avaQueue } = await import("../../db/schema/queue.js");
    await db.update(avaQueue).set({ runId }).where(eq(avaQueue.id, itemId));
  }

  /**
   * If session is from Slack, send the response back to the thread.
   */
  private async notifySlackIfNeeded(
    sessionId: string,
    content: string
  ): Promise<void> {
    try {
      // Get session to check if it's from Slack
      const [session] = await db
        .select()
        .from(avaSessions)
        .where(eq(avaSessions.id, sessionId))
        .limit(1);

      if (!session || session.source !== "slack" || !session.externalId) {
        return;
      }

      // Parse externalId: "slack:CHANNEL_ID:THREAD_TS"
      const parts = session.externalId.split(":");
      if (parts.length < 3 || parts[0] !== "slack") {
        return;
      }

      const channelId = parts[1];
      const threadTs = parts[2];

      // Convert markdown and chunk for Slack
      const slackContent = markdownToSlackMrkdwn(content);
      const MAX_LEN = 3900;
      const chunks = slackContent.length <= MAX_LEN
        ? [slackContent]
        : slackContent.match(new RegExp(`.{1,${MAX_LEN}}`, "gs")) || [slackContent];

      for (const chunk of chunks) {
        await slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
        });
      }

      log.info({ channelId, threadTs, chunks: chunks.length }, "Cron result sent to Slack");
    } catch (error) {
      log.error({ err: error }, "Failed to notify Slack");
    }
  }
}

async function buildScheduledTaskPrompt(
  payload: string,
  sessionId: string,
  source: QueueItem["source"],
  sourceMetadata?: Record<string, unknown>,
): Promise<string> {
  const lines = ['[Scheduled Task]'];

  try {
    const [session] = await db
      .select({ externalId: avaSessions.externalId, source: avaSessions.source })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);

    if (session?.externalId?.startsWith('slack:')) {
      lines.push('This task was scheduled from a Slack conversation. Use slack_message to deliver any messages.');
    }
  } catch { /* proceed without context */ }

  if (sourceMetadata?.jobName) {
    lines.push(`Task: ${sourceMetadata.jobName}`);
  }

  lines.push('', 'Execute this task now:', payload);
  if (source === "cron") {
    lines.push(
      "",
      "Cron delivery is controlled by a typed control envelope.",
      'Never return legacy token strings (NO_REPLY, HEARTBEAT_OK, ANNOUNCE_SKIP); return the JSON envelope instead.',
      CONTROL_ENVELOPE_REQUIREMENT,
    );
  }
  return lines.join('\n');
}

export const queueProcessor = new QueueProcessor();
