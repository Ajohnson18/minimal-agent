/**
 * Heartbeat Service
 *
 * Runs periodic agent turns to check for pending tasks and surface alerts.
 *
 * Features:
 * - Scheduled heartbeats (default: 30min)
 * - Event-triggered immediate heartbeats (exec completion, subagent completion)
 * - HEARTBEAT.md checklist support
 * - Duplicate alert detection
 * - Claimed-event processing to avoid duplicate consumption
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAgentWithPi } from "../../agent/executor-pi.js";
import { resolveUserContext } from "../../agent/user-context.js";
import {
  claimSystemEvents,
  finalizeSystemEventClaim,
  releaseSystemEventClaim,
  type SystemEvent,
} from "./system-events.js";
import { queueService } from "./queue.js";
import { runtime } from "../runtime.js";
import type { resolveDeliveryRoute } from "./delivery-router.js";
import {
  resolveDeliveryRouteDetailed,
  routeDelivery,
  type DeliveryRouteDiagnostics,
} from "./delivery-router.js";
import { parseDeliveryTarget } from "../../agent/delivery.js";
import { createLogger } from "../../lib/logger.js";
import {
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { canDeliverToSession } from "./session-lifecycle-guard.js";
import {
  isRelaySuppressed,
  resolveCompletionPolicy,
  type SubagentCompletionPayload,
} from "../../core/system-events.js";
import {
  CONTROL_ENVELOPE_REQUIREMENT,
  parseControlEnvelopeWithLegacyFallback,
  toDeliveryControl,
} from "../../core/control-envelope.js";
import {
  describeHeartbeatReason,
  type HeartbeatWakeReasonInput,
} from "../../core/heartbeat-reason.js";
import { runHookPhaseOutput } from "../../hooks/index.js";
import { parseSlackTarget } from "../../lib/slack/targets.js";

const log = createLogger("agent");
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_WAKE_COALESCE_MS = 100;

function getRoutingHintsFromEvents(
  events: Array<{ metadata?: Record<string, unknown> }>,
): {
  deliveryExternalId?: string;
  accountId?: string;
  originKind?: string;
} {
  let deliveryExternalId: string | undefined;
  let accountId: string | undefined;
  let originKind: string | undefined;

  for (const event of events) {
    const metadata = event.metadata;
    if (!metadata) continue;

    if (!deliveryExternalId) {
      const candidate = metadata["deliveryExternalId"];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        deliveryExternalId = candidate.trim();
      }
    }

    if (!accountId) {
      const candidate = metadata["accountId"];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        accountId = candidate.trim();
      }
    }

    if (!originKind) {
      const candidate = metadata["originKind"];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        originKind = candidate.trim();
      }
    }
  }

  return {
    ...(deliveryExternalId ? { deliveryExternalId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(originKind ? { originKind } : {}),
  };
}

type SuppressedEvent = {
  event: SystemEvent;
  reason: string;
};

function getStringMetadata(event: SystemEvent, key: string): string | null {
  const raw = event.metadata?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEventText(event: SystemEvent): string {
  const text = event.payload?.text;
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (event.kind !== "exec.completion") {
    return trimmed;
  }

  const payload =
    event.payload as unknown as Record<string, unknown> | undefined;
  const outputSeq = payload?.["outputSeq"] as
    | { last?: number; stdout?: number; stderr?: number }
    | undefined;
  if (!outputSeq) {
    return trimmed;
  }
  const parts: string[] = [];
  if (typeof outputSeq.last === "number") parts.push(`last=${outputSeq.last}`);
  if (typeof outputSeq.stdout === "number")
    parts.push(`stdout=${outputSeq.stdout}`);
  if (typeof outputSeq.stderr === "number")
    parts.push(`stderr=${outputSeq.stderr}`);
  if (parts.length === 0) return trimmed;
  return `${trimmed}\nOutput sequence: ${parts.join(", ")}`;
}

function getEventSuppressionReason(event: SystemEvent): string | null {
  if (isRelaySuppressed(event.payload)) {
    const policy = resolveCompletionPolicy(event.payload);
    if (policy.relay === "silent") {
      return "completion-policy-silent";
    }
    if (policy.relay === "auto" && policy.relevance === "internal") {
      return "completion-policy-internal";
    }
  }

  const metadataAnnounceMode = getStringMetadata(
    event,
    "announceMode",
  )?.toLowerCase();
  const payloadAnnounceMode = (
    event.payload as SubagentCompletionPayload | undefined
  )?.announceMode?.toLowerCase();
  if (
    event.kind === "subagent.completion" &&
    (payloadAnnounceMode === "silent" || metadataAnnounceMode === "silent")
  ) {
    return "subagent-announce-silent";
  }

  return null;
}

function partitionRelayableEvents(events: SystemEvent[]): {
  relayableEvents: SystemEvent[];
  suppressedEvents: SuppressedEvent[];
} {
  const relayableEvents: SystemEvent[] = [];
  const suppressedEvents: SuppressedEvent[] = [];

  for (const event of events) {
    const suppressionReason = getEventSuppressionReason(event);
    if (suppressionReason) {
      suppressedEvents.push({ event, reason: suppressionReason });
      continue;
    }
    relayableEvents.push(event);
  }

  return { relayableEvents, suppressedEvents };
}

// Special prompt for exec completion events
const EXEC_EVENT_PROMPT =
  "An async command you ran earlier has completed. The result is shown in the system messages above. " +
  "Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
  "If it failed, explain what went wrong.";

const SUBAGENT_EVENT_PROMPT =
  "A sub-agent you spawned has completed. The result is shown in the system messages above. " +
  "Relay the findings to the user in your normal voice. Keep internal details (session IDs, stats, announce type) private.";

// Default heartbeat prompt (when no events pending)
const DEFAULT_HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, use heartbeat_ack.";

function buildInternalFallbackPromptFromEvents(events: SystemEvent[]): string {
  const hasExecEvent = events.some((event) => event.kind === "exec.completion");
  const hasSubagentEvent = events.some(
    (event) => event.kind === "subagent.completion",
  );
  const contextBlocks = events
    .map(getEventText)
    .filter((text) => text.trim().length > 0);
  const context = contextBlocks.join("\n\n---\n\n");

  let prompt: string;
  if (hasSubagentEvent && !hasExecEvent) {
    prompt = SUBAGENT_EVENT_PROMPT;
  } else if (hasExecEvent && !hasSubagentEvent) {
    prompt = EXEC_EVENT_PROMPT;
  } else if (hasExecEvent || hasSubagentEvent) {
    prompt = `${EXEC_EVENT_PROMPT}\n\n${SUBAGENT_EVENT_PROMPT}`;
  } else {
    prompt =
      "Pending system events require handling. Summarize and communicate any relevant updates to the user.";
  }

  return [
    "Internal fallback: no external delivery target is currently available for this session.",
    "Handle the event context below and respond in this session.",
    "",
    prompt,
    "",
    "Event context:",
    context || "(no event text available)",
  ].join("\n");
}

interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  workspaceDir: string;
  userId: string;
  sessionId: string;
  externalId?: string;
  target?: string;
  to?: string;
  accountId?: string;
}

interface HeartbeatState {
  lastRunMs?: number;
  nextDueMs: number;
  lastAlertText?: string;
  lastAlertSentAt?: number;
}

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string };

export interface RunHeartbeatOnceOptions {
  reason?: HeartbeatWakeReasonInput;
}

type ResolvedHeartbeatDeliveryRoute =
  | {
      mode: "deliver";
      route: NonNullable<Awaited<ReturnType<typeof resolveDeliveryRoute>>>;
      diagnostics?: DeliveryRouteDiagnostics;
    }
  | {
      mode: "suppress";
      reason: string;
      diagnostics?: DeliveryRouteDiagnostics;
    };

function normalizeHeartbeatTarget(target: string | undefined): string {
  const normalized = target?.trim();
  if (!normalized) return "last";
  const lower = normalized.toLowerCase();
  if (lower === "last" || lower === "none" || lower === "slack") {
    return lower;
  }
  return normalized;
}

function buildSlackExternalIdFromTo(to: string | undefined): string | null {
  const candidate = to?.trim();
  if (!candidate) return null;

  try {
    const parsed = parseSlackTarget(candidate);
    if (parsed.kind === "user") {
      return `slack:dm:${parsed.id}`;
    }
    return `slack:${parsed.id}`;
  } catch {
    return null;
  }
}

export class HeartbeatService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private state: HeartbeatState;
  private config: HeartbeatConfig;

  constructor(config: HeartbeatConfig) {
    this.config = config;
    this.state = {
      nextDueMs: Date.now() + config.intervalMs,
    };
  }

  private async resolveHeartbeatDeliveryRoute(
    eventDeliveryExternalId: string | undefined,
    eventAccountId?: string,
  ): Promise<ResolvedHeartbeatDeliveryRoute> {
    const targetMode = normalizeHeartbeatTarget(this.config.target);

    if (targetMode === "none") {
      return {
        mode: "suppress",
        reason: "heartbeat-target-none",
      };
    }

    const accountId = eventAccountId?.trim() || this.config.accountId?.trim();
    if (targetMode === "last") {
      const preferredExternalId =
        eventDeliveryExternalId ?? this.config.externalId;
      const hintedTarget = preferredExternalId
        ? parseDeliveryTarget(preferredExternalId)
        : null;
      const routeAttempt = await resolveDeliveryRouteDetailed({
        sessionId: this.config.sessionId,
        ...(preferredExternalId ? { preferredExternalId } : {}),
        ...(hintedTarget && hintedTarget.channel !== "unknown"
          ? { targetOverride: hintedTarget }
          : {}),
        ...(accountId ? { accountId } : {}),
      });
      const route = routeAttempt.route;
      if (!route) {
        return {
          mode: "suppress",
          reason:
            routeAttempt.diagnostics.routeFailureReason ?? "no-delivery-target",
          diagnostics: routeAttempt.diagnostics,
        };
      }
      return {
        mode: "deliver",
        route,
        diagnostics: routeAttempt.diagnostics,
      };
    }

    let explicitExternalId: string | null = null;
    if (targetMode === "slack") {
      explicitExternalId = buildSlackExternalIdFromTo(this.config.to);
      if (!explicitExternalId) {
        return {
          mode: "suppress",
          reason: "heartbeat-target-misconfigured",
        };
      }
    } else {
      explicitExternalId = targetMode;
    }

    const explicitTarget = parseDeliveryTarget(explicitExternalId);
    if (!explicitTarget || explicitTarget.channel === "unknown") {
      return {
        mode: "suppress",
        reason: "heartbeat-target-unsupported",
      };
    }

    const routeAttempt = await resolveDeliveryRouteDetailed({
      sessionId: this.config.sessionId,
      preferredExternalId: explicitExternalId,
      targetOverride: explicitTarget,
      ...(accountId ? { accountId } : {}),
    });
    const route = routeAttempt.route;
    if (!route) {
      return {
        mode: "suppress",
        reason:
          routeAttempt.diagnostics.routeFailureReason ?? "no-delivery-target",
        diagnostics: routeAttempt.diagnostics,
      };
    }

    return {
      mode: "deliver",
      route,
      diagnostics: routeAttempt.diagnostics,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info(
      {
        sessionId: this.config.sessionId,
        intervalMs: this.config.intervalMs,
      },
      "Heartbeat service started",
    );
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info({ sessionId: this.config.sessionId }, "Heartbeat service stopped");
  }

  /**
   * Request immediate heartbeat run.
   */
  wakeNow(reason: HeartbeatWakeReasonInput): void {
    if (!this.running) {
      log.warn(
        {
          sessionId: this.config.sessionId,
          reason: describeHeartbeatReason(reason),
        },
        "Wake requested but service not running",
      );
      return;
    }

    requestHeartbeatNow({
      sessionId: this.config.sessionId,
      reason,
      coalesceMs: DEFAULT_WAKE_COALESCE_MS,
    });
  }

  private async enqueueInternalFallbackRun(opts: {
    relayableEvents: SystemEvent[];
    routeReason: string;
    reasonLabel: string;
  }): Promise<"queued" | "awaiting-subscriber" | "failed"> {
    if (!runtime.hasSessionSubscribers(this.config.sessionId)) {
      log.info(
        {
          metric: "heartbeat_internal_fallback_skipped",
          sessionId: this.config.sessionId,
          routeReason: opts.routeReason,
          reason: "no-active-session-subscribers",
        },
        "Skipping heartbeat internal fallback because no websocket subscribers are connected",
      );
      return "awaiting-subscriber";
    }

    const prompt = buildInternalFallbackPromptFromEvents(opts.relayableEvents);
    try {
      await queueService.enqueue(
        this.config.sessionId,
        this.config.userId,
        prompt,
        {
          mode: "followup",
          source: "heartbeat-internal-fallback",
          sourceMetadata: {
            routeReason: opts.routeReason,
            wakeReason: opts.reasonLabel,
            eventKinds: opts.relayableEvents.map((event) => event.kind),
            eventIds: opts.relayableEvents.map((event) => event.id),
          },
        },
      );
      log.info(
        {
          metric: "heartbeat_internal_fallback_queued",
          sessionId: this.config.sessionId,
          routeReason: opts.routeReason,
          events: opts.relayableEvents.length,
        },
        "Queued internal heartbeat fallback follow-up",
      );
      return "queued";
    } catch (error) {
      log.warn(
        {
          metric: "heartbeat_internal_fallback_skipped",
          sessionId: this.config.sessionId,
          routeReason: opts.routeReason,
          reason: "enqueue-failed",
          err: error,
        },
        "Failed to enqueue heartbeat internal fallback follow-up",
      );
      return "failed";
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const now = Date.now();
    this.state.nextDueMs = now + this.config.intervalMs;
    const delay = Math.max(0, this.state.nextDueMs - now);

    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;

      requestHeartbeatNow({
        sessionId: this.config.sessionId,
        reason: {
          kind: "interval",
          source: "system",
        },
        coalesceMs: 0,
      });

      this.scheduleNext();
    }, delay);

    // Don't keep process alive for timer
    this.timer.unref?.();
  }

  async runHeartbeatOnce(
    opts: RunHeartbeatOnceOptions = {},
  ): Promise<HeartbeatRunResult> {
    if (!this.running || !this.config.enabled) {
      return { status: "skipped", reason: "disabled" };
    }

    let reason = opts.reason ?? { kind: "manual", source: "system" };
    try {
      const hookOutput = await runHookPhaseOutput("heartbeat_reason_classify", {
        rawReason: describeHeartbeatReason(reason),
        defaultKind: reason.kind,
      });
      if (hookOutput.kind) {
        reason = {
          ...reason,
          kind: hookOutput.kind,
        };
      }
    } catch (error) {
      log.warn(
        { err: error, sessionId: this.config.sessionId },
        "heartbeat_reason_classify hook failed; using default reason",
      );
    }
    const reasonLabel = describeHeartbeatReason(reason);
    const startedAt = Date.now();
    this.state.lastRunMs = startedAt;

    let claimToken: string | undefined;
    let pendingEvents: SystemEvent[] = [];

    try {
      const deliverable = await canDeliverToSession(this.config.sessionId);
      if (!deliverable) {
        return { status: "skipped", reason: "session-not-deliverable" };
      }

      // Session-scoped queue busy checks.
      const [processing, stats] = await Promise.all([
        queueService
          .isSessionProcessing(this.config.sessionId)
          .catch(() => false),
        queueService
          .getStats(this.config.sessionId)
          .catch(() => ({ pending: 0, processing: 0, completed: 0, error: 0 })),
      ]);

      if (processing || stats.pending > 0 || stats.processing > 0) {
        log.debug(
          {
            sessionId: this.config.sessionId,
            queueProcessing: processing,
            queuePending: stats.pending,
            queueActive: stats.processing,
            reason: reasonLabel,
          },
          "Skipping heartbeat - queue busy",
        );
        return { status: "skipped", reason: "queue-busy" };
      }

      // 1. Claim pending events so only one heartbeat worker consumes them.
      const claimed = await claimSystemEvents(this.config.sessionId, {
        limit: 50,
        claimTtlSeconds: 120,
      });

      claimToken = claimed?.claimToken;
      pendingEvents = claimed?.events ?? [];

      const { relayableEvents, suppressedEvents } =
        partitionRelayableEvents(pendingEvents);

      if (suppressedEvents.length > 0) {
        log.info(
          {
            sessionId: this.config.sessionId,
            suppressedCount: suppressedEvents.length,
            reasons: Array.from(new Set(suppressedEvents.map((e) => e.reason))),
          },
          "Suppressing non-user-facing heartbeat events",
        );
      }

      if (pendingEvents.length > 0 && relayableEvents.length === 0) {
        await this.finalizeClaimIfNeeded(claimToken);
        return {
          status: "ran",
          durationMs: Date.now() - startedAt,
        };
      }

      // 2. Check event types and delivery hints.
      const hasExecEvent = relayableEvents.some(
        (e) => e.kind === "exec.completion",
      );
      const hasSubagentEvent = relayableEvents.some(
        (e) => e.kind === "subagent.completion",
      );
      const routingHints = getRoutingHintsFromEvents(relayableEvents);
      const eventDeliveryExternalId = routingHints.deliveryExternalId;
      const deliveryRoute = await this.resolveHeartbeatDeliveryRoute(
        eventDeliveryExternalId,
        routingHints.accountId,
      );
      if (deliveryRoute.mode === "suppress") {
        if (
          deliveryRoute.reason === "no-delivery-target" &&
          relayableEvents.length > 0
        ) {
          const fallbackStatus = await this.enqueueInternalFallbackRun({
            relayableEvents,
            routeReason: deliveryRoute.reason,
            reasonLabel,
          });
          if (fallbackStatus === "queued") {
            await this.finalizeClaimIfNeeded(claimToken);
            return {
              status: "ran",
              durationMs: Date.now() - startedAt,
            };
          }
          if (fallbackStatus === "awaiting-subscriber") {
            await this.releaseClaimIfNeeded(claimToken);
            return { status: "skipped", reason: "awaiting-subscriber" };
          }
          if (fallbackStatus === "failed") {
            await this.releaseClaimIfNeeded(claimToken);
            return { status: "skipped", reason: deliveryRoute.reason };
          }
        }
        await this.finalizeClaimIfNeeded(claimToken);
        log.info(
          {
            sessionId: this.config.sessionId,
            reason: deliveryRoute.reason,
            routeFailureReason: deliveryRoute.diagnostics?.routeFailureReason,
            routeCandidateChain: deliveryRoute.diagnostics?.routeCandidateChain,
            heartbeatTarget: normalizeHeartbeatTarget(this.config.target),
            originKind: routingHints.originKind,
            eventDeliveryExternalId,
          },
          "Suppressing heartbeat run due to delivery-target policy",
        );
        return { status: "skipped", reason: deliveryRoute.reason };
      }
      const deliveryExternalId = deliveryRoute.route.target.externalId;

      // 3. Build prompt based on pending events.
      let prompt: string;
      let systemContext = "";

      if (hasExecEvent || hasSubagentEvent) {
        const execEvents = relayableEvents.filter(
          (e) => e.kind === "exec.completion",
        );
        const subagentEvents = relayableEvents.filter(
          (e) => e.kind === "subagent.completion",
        );

        const contextParts: string[] = [];
        if (execEvents.length > 0) {
          contextParts.push(
            ...execEvents.map(getEventText).filter((text) => text.length > 0),
          );
        }
        if (subagentEvents.length > 0) {
          contextParts.push(
            ...subagentEvents
              .map(getEventText)
              .filter((text) => text.length > 0),
          );
        }
        systemContext = contextParts.join("\n\n---\n\n");

        if (hasSubagentEvent && !hasExecEvent) {
          prompt = SUBAGENT_EVENT_PROMPT;
        } else if (hasExecEvent && !hasSubagentEvent) {
          prompt = EXEC_EVENT_PROMPT;
        } else {
          prompt = EXEC_EVENT_PROMPT + "\n\n" + SUBAGENT_EVENT_PROMPT;
        }
      } else {
        // No events - check HEARTBEAT.md
        const heartbeatContent = await this.readHeartbeatFile();
        if (this.isHeartbeatContentEmpty(heartbeatContent)) {
          log.debug(
            { sessionId: this.config.sessionId },
            "Skipping heartbeat - HEARTBEAT.md empty",
          );
          return { status: "skipped", reason: "empty-heartbeat-file" };
        }
        prompt = DEFAULT_HEARTBEAT_PROMPT;
      }

      // 4. Prepend event context to prompt.
      if (systemContext) {
        prompt = `${systemContext}\n\n${prompt}`;
      }
      prompt = `${prompt}\n\n${CONTROL_ENVELOPE_REQUIREMENT}`;

      // 5. Execute agent with heartbeat prompt.
      log.info(
        {
          sessionId: this.config.sessionId,
          reason: reasonLabel,
          hasEvents: relayableEvents.length > 0,
          claimedEventCount: pendingEvents.length,
          relayableEventCount: relayableEvents.length,
          suppressedEventCount: suppressedEvents.length,
        },
        "Running heartbeat",
      );

      const userContext = await resolveUserContext("web", this.config.userId);

      const result = await executeAgentWithPi({
        sessionId: this.config.sessionId,
        userId: this.config.userId,
        userContext,
        prompt,
        skipHistory: false,
        externalId: deliveryExternalId,
      });

      const responseText = result.content?.trim() || "";
      const controlEnvelope = parseControlEnvelopeWithLegacyFallback(responseText);
      if (!controlEnvelope) {
        await this.releaseClaimIfNeeded(claimToken);
        log.warn(
          {
            sessionId: this.config.sessionId,
            reason: reasonLabel,
            preview: responseText.slice(0, 200),
          },
          "Heartbeat response missing typed control envelope",
        );
        return { status: "skipped", reason: "invalid-control-envelope" };
      }
      const deliveryControl = toDeliveryControl(controlEnvelope, "");

      // 6. Suppress explicit control outcomes.
      if (deliveryControl.mode === "suppress") {
        await this.finalizeClaimIfNeeded(claimToken);
        log.info(
          {
            sessionId: this.config.sessionId,
            controlReason: deliveryControl.reason,
          },
          "Heartbeat returned suppress/ack control outcome",
        );
        return {
          status: "ran",
          durationMs: Date.now() - startedAt,
        };
      }

      const deliveryText = deliveryControl.text.trim();
      if (!deliveryText) {
        await this.finalizeClaimIfNeeded(claimToken);
        log.info(
          {
            sessionId: this.config.sessionId,
            controlReason: deliveryControl.reason,
          },
          "Heartbeat delivered empty text after control parsing; suppressing",
        );
        return {
          status: "ran",
          durationMs: Date.now() - startedAt,
        };
      }

      // 8. Duplicate suppression.
      if (this.isDuplicateAlert(deliveryText)) {
        await this.finalizeClaimIfNeeded(claimToken);
        log.info(
          {
            sessionId: this.config.sessionId,
            preview: deliveryText.slice(0, 100),
          },
          "Skipping duplicate alert",
        );
        return { status: "skipped", reason: "duplicate-alert" };
      }

      // 9. Route delivery through unified delivery router.
      const resolvedAccountId =
        routingHints.accountId?.trim() || this.config.accountId?.trim();
      const routed = await routeDelivery({
        sessionId: this.config.sessionId,
        targetOverride: deliveryRoute.route.target,
        preferredExternalId: deliveryRoute.route.target.externalId,
        ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
        content: deliveryText,
        durability: "durable",
        reason: "heartbeat",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      if (routed.status === "suppressed") {
        await this.finalizeClaimIfNeeded(claimToken);
        log.info(
          {
            sessionId: this.config.sessionId,
            reason: routed.reason,
          },
          "Heartbeat delivery was suppressed by delivery router",
        );
        return {
          status: "ran",
          durationMs: Date.now() - startedAt,
        };
      }

      if (routed.status !== "sent") {
        const reason = routed.reason ?? "delivery-failed";
        if (reason === "no-delivery-target") {
          await this.finalizeClaimIfNeeded(claimToken);
        } else {
          await this.releaseClaimIfNeeded(claimToken);
        }
        log.warn(
          {
            sessionId: this.config.sessionId,
            reason,
            routeFailureReason: routed.diagnostics?.routeFailureReason,
            routeCandidateChain: routed.diagnostics?.routeCandidateChain,
            originKind: routingHints.originKind,
            eventDeliveryExternalId,
          },
          "Failed to route heartbeat alert delivery",
        );
        return { status: "skipped", reason };
      }

      // 10. Success path.
      this.state.lastAlertText = deliveryText;
      this.state.lastAlertSentAt = startedAt;
      await this.finalizeClaimIfNeeded(claimToken);

      log.info(
        {
          sessionId: this.config.sessionId,
          preview: deliveryText.slice(0, 200),
          durationMs: Date.now() - startedAt,
        },
        "Heartbeat alert delivered to channel",
      );

      return {
        status: "ran",
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      await this.releaseClaimIfNeeded(claimToken);

      const error = err instanceof Error ? err.message : String(err);
      log.error(
        {
          sessionId: this.config.sessionId,
          error,
          reason: reasonLabel,
          claimedEventCount: pendingEvents.length,
        },
        "Heartbeat failed",
      );

      return {
        status: "skipped",
        reason: "heartbeat-error",
      };
    }
  }

  private async finalizeClaimIfNeeded(claimToken?: string): Promise<void> {
    if (!claimToken) return;
    const finalized = await finalizeSystemEventClaim(claimToken);
    log.debug(
      { sessionId: this.config.sessionId, claimToken, finalized },
      "Heartbeat claim finalized",
    );
  }

  private async releaseClaimIfNeeded(claimToken?: string): Promise<void> {
    if (!claimToken) return;
    const released = await releaseSystemEventClaim(claimToken);
    log.debug(
      { sessionId: this.config.sessionId, claimToken, released },
      "Heartbeat claim released",
    );
  }

  private async readHeartbeatFile(): Promise<string> {
    try {
      const filePath = join(
        this.config.workspaceDir,
        DEFAULT_HEARTBEAT_FILENAME,
      );
      return await readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  private isHeartbeatContentEmpty(content: string): boolean {
    // Remove comments and headers
    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("<!--")
      );
    });

    return lines.join("").trim().length === 0;
  }

  private isDuplicateAlert(text: string): boolean {
    if (!this.state.lastAlertText || !this.state.lastAlertSentAt) {
      return false;
    }

    const timeSinceLastAlert = Date.now() - this.state.lastAlertSentAt;
    const isDuplicateWindow = timeSinceLastAlert < 24 * 60 * 60 * 1000; // 24 hours
    const isSameText = text.trim() === this.state.lastAlertText.trim();

    return isDuplicateWindow && isSameText;
  }
}

// Global registry of heartbeat services (one per session)
const heartbeats = new Map<string, HeartbeatService>();
let disposeWakeHandler: (() => void) | null = null;

function ensureWakeHandlerRegistered(): void {
  if (disposeWakeHandler) {
    return;
  }

  disposeWakeHandler = setHeartbeatWakeHandler(
    async ({ reason, sessionId }) => {
      const sessionKey = sessionId?.trim();
      if (!sessionKey) {
        return { status: "skipped", reason: "missing-session-id" };
      }

      const service = heartbeats.get(sessionKey);
      if (!service || !service.isRunning()) {
        return { status: "skipped", reason: "service-not-running" };
      }

      return service.runHeartbeatOnce({ reason });
    },
  );
}

function maybeDisposeWakeHandler(): void {
  if (heartbeats.size > 0) {
    return;
  }

  if (disposeWakeHandler) {
    disposeWakeHandler();
    disposeWakeHandler = null;
  }
}

/**
 * Start heartbeat for a session.
 */
export function startHeartbeat(config: HeartbeatConfig): HeartbeatService {
  const existing = heartbeats.get(config.sessionId);
  if (existing) {
    existing.stop();
  }

  ensureWakeHandlerRegistered();

  const service = new HeartbeatService(config);
  heartbeats.set(config.sessionId, service);
  service.start();

  return service;
}

/**
 * Stop heartbeat for a session.
 */
export function stopHeartbeat(sessionId: string): void {
  const service = heartbeats.get(sessionId);
  if (service) {
    service.stop();
    heartbeats.delete(sessionId);
  }

  maybeDisposeWakeHandler();
}

/**
 * Trigger immediate heartbeat for a session (used by background task completions).
 */
export function wakeHeartbeat(
  sessionId: string,
  reason: HeartbeatWakeReasonInput,
): void {
  const service = heartbeats.get(sessionId);
  if (!service) {
    log.warn(
      {
        sessionId,
        reason: describeHeartbeatReason(reason),
      },
      "Wake requested but no heartbeat service found",
    );
    return;
  }

  service.wakeNow(reason);
}

/**
 * Run heartbeat once for a specific session.
 */
export async function runHeartbeatOnce(opts: {
  sessionId: string;
  reason?: HeartbeatWakeReasonInput;
}): Promise<HeartbeatRunResult> {
  const service = heartbeats.get(opts.sessionId);
  if (!service) {
    return { status: "skipped", reason: "service-not-found" };
  }
  return service.runHeartbeatOnce({ reason: opts.reason });
}

/**
 * Get heartbeat status for monitoring.
 */
export function getHeartbeatStats(): { activeHeartbeats: number } {
  return {
    activeHeartbeats: heartbeats.size,
  };
}

/**
 * Test-only reset for all active heartbeat services.
 */
export function resetHeartbeatsForTests(): void {
  for (const service of heartbeats.values()) {
    service.stop();
  }
  heartbeats.clear();
  if (disposeWakeHandler) {
    disposeWakeHandler();
    disposeWakeHandler = null;
  }
}
