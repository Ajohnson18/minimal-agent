/**
 * Subagent Announce Flow
 *
 * When a subagent completes, this module:
 * 1. Attempts direct completion delivery (idempotent) to the target channel.
 * 2. Falls back to system-event enqueue + heartbeat wake if direct send fails.
 * 3. Avoids heartbeat wake for duplicate/no-op enqueue paths.
 */
import {
  queueSystemEventWithStatus,
  type QueueSystemEventResult,
} from '../gateway/services/system-events.js';
import { wakeHeartbeat } from '../gateway/services/heartbeat.service.js';
import { queueService } from "../gateway/services/queue.js";
import { canDeliverToSession } from '../gateway/services/session-lifecycle-guard.js';
import { routeDelivery } from '../gateway/services/delivery-router.js';
import { createLogger } from '../lib/logger.js';
import type { SubagentRun } from './tools/subagent-registry.js';
import type {
  CompletionPolicy,
  SubagentCompletionDescriptor,
  SubagentCompletionPayload,
} from '../core/system-events.js';
import { runHookPhaseOutput } from '../hooks/index.js';
import type { DeliveryTarget } from './delivery.js';
import {
  runSubagentAnnounceDispatch,
  type AnnounceDeliveryPhaseResult,
  type QueueAnnounceOutcome,
} from "./subagent-announce-dispatch.js";

const log = createLogger('subagent-announce');
const DEFAULT_SUBAGENT_FALLBACK_TTL_MS = 60 * 60 * 1000;
const EMPTY_COMPLETED_RESULT_MESSAGE =
  "Subagent finished but returned no results. This can mean there was no matching data, or the run failed internally. Retry only if you expected a concrete result.";

function resolveSubagentFallbackTtlMs(): number {
  const fromEnv = Number(process.env.AVA_SUBAGENT_FALLBACK_TTL_MS);
  if (!Number.isFinite(fromEnv)) {
    return DEFAULT_SUBAGENT_FALLBACK_TTL_MS;
  }
  return Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.floor(fromEnv)));
}

const SUBAGENT_FALLBACK_TTL_MS = resolveSubagentFallbackTtlMs();

function buildAnnounceIdempotencyKey(run: SubagentRun): string {
  return `announce:v1:${run.parentSessionId}:${run.id}`;
}

function toSubagentOutcome(
  status: SubagentRun['status'],
): SubagentCompletionPayload['outcome'] {
  if (status === 'completed' || status === 'failed' || status === 'timeout') {
    return status;
  }
  return 'failed';
}

function toBriefSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentenceEnd = normalized.search(/[.!?](\s|$)/);
  if (sentenceEnd >= 0) {
    return normalized.slice(0, sentenceEnd + 1).trim();
  }
  return normalized;
}

function buildRunReferenceLines(run: SubagentRun): string[] {
  return [
    `Run ID: ${run.id}`,
    run.sessionId ? `Child Session ID: ${run.sessionId}` : undefined,
    run.childSessionKey ? `Child Session Key: ${run.childSessionKey}` : undefined,
    run.fullResultPath ? `Full Result Path: ${run.fullResultPath}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

function resolveRunDurationMs(run: SubagentRun): number | undefined {
  if (!run.endedAt || !run.startedAt) {
    return undefined;
  }
  return Math.max(0, run.endedAt - run.startedAt);
}

function resolveAnnounceSummaryText(run: SubagentRun): string {
  const summary = run.announceSummary?.trim();
  if (summary) {
    return summary;
  }
  if (run.status === "completed") {
    const result = run.result?.trim();
    if (result) {
      return result;
    }
    return EMPTY_COMPLETED_RESULT_MESSAGE;
  }
  if (run.error?.trim()) {
    const label = run.status === "timeout" ? "timed out" : run.status;
    return `Subagent ${label}: ${run.error}`.trim();
  }
  return "";
}

function buildCompletionDescriptor(run: SubagentRun): SubagentCompletionDescriptor {
  const summary = resolveAnnounceSummaryText(run);
  const durationMs = resolveRunDurationMs(run);
  const toolsUsed = run.toolsUsed.filter((tool) => tool.trim().length > 0);
  return {
    runId: run.id,
    outcome: toSubagentOutcome(run.status) ?? "failed",
    summary,
    ...(run.sessionId ? { childSessionId: run.sessionId } : {}),
    ...(run.childSessionKey ? { childSessionKey: run.childSessionKey } : {}),
    ...(run.fullResultPath ? { fullResultPath: run.fullResultPath } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
  };
}

function recordAnnounceDispatch(
  run: SubagentRun,
  phases: AnnounceDeliveryPhaseResult[],
  outcome: QueueAnnounceOutcome,
): void {
  run.announceDeliveryPhases = phases;
  run.metadata = {
    ...(run.metadata ?? {}),
    announceDeliveryOutcome: outcome,
    announceDeliveryPhases: phases,
  };
}

/**
 * Format a subagent completion for delivery/system-event fallback.
 * Keeps summary fidelity and always includes durable references.
 */
function formatAnnounceMessage(run: SubagentRun): string {
  const summaryText = resolveAnnounceSummaryText(run);
  if (!summaryText) return "";

  const effectiveSummary =
    run.announceMode === "brief" ? toBriefSummary(summaryText) : summaryText;
  const references = buildRunReferenceLines(run);
  return [
    "Summary:",
    effectiveSummary || "(not available)",
    references.length > 0 ? ["", "References:", ...references] : [],
  ]
    .flat()
    .join("\n");
}

function buildFallbackEventText(run: SubagentRun, message: string): string {
  const duration = run.endedAt
    ? `${Math.round((run.endedAt - run.startedAt) / 1000)}s`
    : 'unknown';
  const isFailureStatus = run.status === 'failed' || run.status === 'timeout';

  const instructions = run.announceMode === 'full'
    ? (
      isFailureStatus
        ? 'A subagent has failed. Convert the result below into your normal assistant voice and deliver to the user. This failure must always be communicated.'
        : 'A subagent has completed. Convert the result below into your normal assistant voice and deliver to the user. If this was already communicated, avoid duplicating content.'
    )
    : 'Subagent completed (background task).';

  return [
    instructions,
    '',
    `Task: ${run.task.slice(0, 100)}`,
    `Status: ${run.status} (${duration})`,
    'Result:',
    message,
    ...(
      buildRunReferenceLines(run).length > 0
        ? ["", "References:", ...buildRunReferenceLines(run)]
        : []
    ),
  ].filter(Boolean).join('\n');
}

function buildInternalParentFollowupMessage(
  run: SubagentRun,
  message: string,
  descriptor: SubagentCompletionDescriptor,
): string {
  const references = buildRunReferenceLines(run);
  return [
    "A child subagent completed and requires parent-session handling.",
    "Review the completion summary below and decide what to deliver upstream.",
    "",
    `Announce Mode: ${run.announceMode}`,
    `Outcome: ${descriptor.outcome}`,
    "",
    "Summary:",
    descriptor.summary || "(not available)",
    ...(references.length > 0 ? ["", "References:", ...references] : []),
    "",
    "Completion Payload:",
    message,
  ]
    .filter(Boolean)
    .join("\n");
}

async function enqueueInternalParentFollowup(
  run: SubagentRun,
  message: string,
): Promise<{ outcome: QueueAnnounceOutcome; reason?: string }> {
  const descriptor = buildCompletionDescriptor(run);
  const internalPrompt = buildInternalParentFollowupMessage(
    run,
    message,
    descriptor,
  );
  if (!internalPrompt.trim()) {
    return { outcome: "suppressed", reason: "empty-internal-prompt" };
  }

  try {
    await queueService.enqueue(run.parentSessionId, run.userId, internalPrompt, {
      mode: "followup",
      source: "subagent-completion",
      sourceMetadata: {
        runId: run.id,
        announceMode: run.announceMode,
        outcome: descriptor.outcome,
        childSessionId: descriptor.childSessionId,
        childSessionKey: descriptor.childSessionKey,
        fullResultPath: descriptor.fullResultPath,
      },
    });
    log.info(
      {
        metric: "subagent_internal_dispatch_queued",
        runId: run.id,
        parentSessionId: run.parentSessionId,
      },
      "Queued internal parent-session follow-up for subagent completion",
    );
    return { outcome: "queued" };
  } catch (error) {
    log.error(
      {
        metric: "subagent_internal_dispatch_failed",
        runId: run.id,
        parentSessionId: run.parentSessionId,
        err: error,
      },
      "Failed to queue internal parent-session follow-up for subagent completion",
    );
    return { outcome: "failed", reason: "internal-enqueue-failed" };
  }
}

async function enqueueFallbackEvent(
  run: SubagentRun,
  message: string,
): Promise<QueueSystemEventResult> {
  const flowMode =
    run.flowMode ??
    (typeof run.metadata?.flowMode === "string"
      ? run.metadata.flowMode
      : undefined);
  const metadata: Record<string, unknown> = {
    status: run.status,
    originKind: "subagent",
    ...(flowMode ? { flowMode } : {}),
  };
  const requesterIsSubagent = run.requesterIsSubagent === true;
  const deliveryExternalId = run.deliveryContext?.externalId?.trim();
  if (deliveryExternalId && !requesterIsSubagent) {
    metadata.deliveryExternalId = deliveryExternalId;
    metadata.routeCandidateChain = ["subagent:deliveryContext"];
  }

  const completionPolicy: CompletionPolicy =
    run.announceMode === 'silent'
      ? { relay: 'silent', relevance: 'internal', reason: 'subagent-silent' }
      : requesterIsSubagent
        ? {
            relay: "auto",
            relevance: "internal",
            reason: "subagent-nested-parent-mediated",
          }
        : { relay: 'always', relevance: 'user', reason: 'subagent-completion' };
  const descriptor = buildCompletionDescriptor(run);

  return queueSystemEventWithStatus({
    sessionId: run.parentSessionId,
    kind: 'subagent.completion',
    payload: {
      text: buildFallbackEventText(run, message),
      completionPolicy,
      subagentRunId: run.id,
      announceMode: run.announceMode,
      outcome: descriptor.outcome,
      summary: descriptor.summary,
      childSessionId: descriptor.childSessionId,
      childSessionKey: descriptor.childSessionKey,
      fullResultPath: descriptor.fullResultPath,
      durationMs: descriptor.durationMs,
      toolsUsed: descriptor.toolsUsed,
    },
    eventKey: `subagent:${run.id}`,
    expiresAt: Date.now() + SUBAGENT_FALLBACK_TTL_MS,
    metadata,
  });
}

/**
 * Queue/deliver a subagent completion.
 *
 * full/brief:
 * - direct-first channel delivery using idempotency key
 * - if direct send fails, enqueue system event and wake heartbeat on successful enqueue
 *
 * silent:
 * - suppress announce delivery/fallback entirely
 */
export async function queueAnnounce(run: SubagentRun): Promise<QueueAnnounceOutcome> {
  const conclude = (
    outcome: QueueAnnounceOutcome,
    phases: AnnounceDeliveryPhaseResult[],
  ): QueueAnnounceOutcome => {
    recordAnnounceDispatch(run, phases, outcome);
    return outcome;
  };
  const flowMode =
    run.flowMode ??
    (typeof run.metadata?.flowMode === "string"
      ? run.metadata.flowMode
      : undefined);
  const deliverable = await canDeliverToSession(run.parentSessionId);
  if (!deliverable) {
    log.info(
      { runId: run.id, parentSessionId: run.parentSessionId, flowMode },
      'Suppressing subagent announce for non-deliverable session',
    );
    return conclude("suppressed", []);
  }

  if (run.announceMode === 'silent') {
    log.info(
      {
        runId: run.id,
        parentSessionId: run.parentSessionId,
        flowMode,
      },
      'Suppressing subagent announce due to silent mode',
    );
    return conclude("suppressed", []);
  }

  const message = formatAnnounceMessage(run);

  if (!message) {
    log.info(
      {
        runId: run.id,
        status: run.status,
      },
      'Subagent completion suppressed (empty result)',
    );
    return conclude("suppressed", []);
  }

  const idempotencyKey = buildAnnounceIdempotencyKey(run);
  let targetOverride: DeliveryTarget | undefined;
  try {
    const hookOutput = await runHookPhaseOutput("subagent_delivery_target", {
      parentSessionId: run.parentSessionId,
      childSessionId: run.sessionId || run.id,
      preferredTarget: null,
    });
    if (hookOutput.target) {
      targetOverride = hookOutput.target;
    }
  } catch (error) {
    log.error(
      {
        err: error,
        runId: run.id,
        parentSessionId: run.parentSessionId,
      },
      "subagent_delivery_target hook failed (fail-closed)",
    );
    return conclude("failed", [
      {
        phase: "direct-primary",
        outcome: "failed",
        attemptedAt: Date.now(),
        reason: "subagent-delivery-target-hook-failed",
      },
    ]);
  }

  const requesterIsSubagent = run.requesterIsSubagent === true;
  const hasDeliveryContext = !!run.deliveryContext?.externalId;
  let allowInternalFallback = requesterIsSubagent;

  if (requesterIsSubagent) {
    log.info(
      {
        runId: run.id,
        parentSessionId: run.parentSessionId,
        hasDeliveryContext,
      },
      "Skipping direct subagent completion delivery because requester is a subagent session",
    );
  }

  const dispatch = await runSubagentAnnounceDispatch([
    {
      phase: "direct-primary",
      run: async () => {
        if (requesterIsSubagent) {
          return {
            outcome: "suppressed",
            reason: "requester-subagent-internal-only",
            continueToNextPhase: true,
          };
        }

        const routed = await routeDelivery({
          sessionId: run.parentSessionId,
          preferredExternalId: run.deliveryContext?.externalId,
          targetOverride,
          content: message,
          idempotencyKey,
          durability: "direct",
          reason: "subagent-direct",
        });
        if (routed.status === "sent") {
          log.info(
            {
              metric: "subagent_direct_delivery_success",
              runId: run.id,
              parentSessionId: run.parentSessionId,
              idempotencyKey: routed.idempotencyKey ?? idempotencyKey,
            },
            "Subagent completion delivered directly",
          );
          return { outcome: "sent" };
        }

        if (routed.status === "suppressed") {
          const directOutcome: QueueAnnounceOutcome =
            routed.reason === "already-sent" || routed.reason === "idempotency-inflight"
              ? "duplicate"
              : "suppressed";
          log.info(
            {
              runId: run.id,
              parentSessionId: run.parentSessionId,
              reason: routed.reason,
              directOutcome,
            },
            "Subagent direct delivery suppressed; skipping fallback",
          );
          return {
            outcome: directOutcome,
            reason: routed.reason,
          };
        }

        const routeFailureReason =
          routed.status === "failed"
            ? routed.diagnostics?.routeFailureReason
            : undefined;
        const routeCandidateChain =
          routed.status === "failed"
            ? routed.diagnostics?.routeCandidateChain
            : undefined;
        if (
          routeFailureReason === "no-delivery-target" ||
          routed.reason === "no-delivery-target"
        ) {
          allowInternalFallback = true;
        }
        log.info(
          {
            runId: run.id,
            parentSessionId: run.parentSessionId,
            status: routed.status,
            reason: routed.status === "failed" ? routed.reason : undefined,
            routeFailureReason,
            routeCandidateChain,
          },
          "Subagent direct delivery did not send; falling back",
        );
        return {
          outcome: "failed",
          reason:
            routed.status === "failed"
              ? routed.reason
              : "direct-delivery-no-send",
          routeFailureReason,
          routeCandidateChain,
          continueToNextPhase: true,
        };
      },
    },
    {
      phase: "internal-session-fallback",
      run: async () => {
        if (!allowInternalFallback) {
          return {
            outcome: "suppressed",
            reason: "internal-fallback-not-needed",
            continueToNextPhase: true,
          };
        }

        const internal = await enqueueInternalParentFollowup(run, message);
        if (internal.outcome === "queued" || internal.outcome === "duplicate") {
          return { outcome: internal.outcome };
        }
        if (internal.outcome === "suppressed") {
          return {
            outcome: "suppressed",
            reason: internal.reason ?? "internal-fallback-suppressed",
            continueToNextPhase: true,
          };
        }
        return {
          outcome: "failed",
          reason: internal.reason ?? "internal-fallback-failed",
          continueToNextPhase: true,
        };
      },
    },
    {
      phase: "queue-fallback",
      run: async () => {
        log.info(
          {
            metric: "subagent_direct_delivery_fallback",
            runId: run.id,
            parentSessionId: run.parentSessionId,
          },
          "Subagent direct/internal delivery unavailable; falling back to heartbeat event",
        );

        let queuedEvent: QueueSystemEventResult = { status: "failed" };
        try {
          queuedEvent = await enqueueFallbackEvent(run, message);
        } catch (error) {
          log.error(
            {
              metric: "subagent_direct_delivery_fallback",
              runId: run.id,
              parentSessionId: run.parentSessionId,
              err: error,
            },
            "Failed to enqueue subagent fallback event",
          );
          return {
            outcome: "failed",
            reason: "fallback-enqueue-threw",
          };
        }

        if (queuedEvent.status === "queued") {
          wakeHeartbeat(run.parentSessionId, {
            kind: "event",
            eventKind: "subagent.completion",
            source: "subagent",
          });
          log.info(
            { runId: run.id, status: run.status, parentSessionId: run.parentSessionId },
            "Subagent completion queued and heartbeat wake requested",
          );
          return { outcome: "queued" };
        }

        if (queuedEvent.status === "duplicate") {
          log.info(
            { runId: run.id, status: run.status, parentSessionId: run.parentSessionId },
            "Subagent fallback event was duplicate; skipping wake",
          );
          return { outcome: "duplicate", reason: "duplicate-event-key" };
        }

        log.warn(
          { runId: run.id, status: run.status, parentSessionId: run.parentSessionId },
          "Subagent fallback event enqueue failed",
        );
        return { outcome: "failed", reason: "fallback-enqueue-failed" };
      },
    },
  ]);

  return conclude(dispatch.outcome, dispatch.phases);
}
