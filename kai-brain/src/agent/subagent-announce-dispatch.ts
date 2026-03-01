import type { DeliveryRouteFailureReason } from "../gateway/services/delivery-router.js";

export type QueueAnnounceOutcome =
  | "sent"
  | "queued"
  | "duplicate"
  | "suppressed"
  | "failed";

export type AnnounceDispatchPhase =
  | "direct-primary"
  | "internal-session-fallback"
  | "queue-fallback";

export interface AnnounceDeliveryPhaseResult {
  phase: AnnounceDispatchPhase;
  outcome: QueueAnnounceOutcome;
  attemptedAt: number;
  reason?: string;
  routeFailureReason?: DeliveryRouteFailureReason;
  routeCandidateChain?: string[];
}

export interface AnnounceDispatchStepResult {
  outcome: QueueAnnounceOutcome;
  reason?: string;
  routeFailureReason?: DeliveryRouteFailureReason;
  routeCandidateChain?: string[];
  /**
   * Force continuation to the next phase even if this step returned
   * a nominally terminal outcome (for explicit fallback choreography).
   */
  continueToNextPhase?: boolean;
}

export interface AnnounceDispatchStep {
  phase: AnnounceDispatchPhase;
  run: () => Promise<AnnounceDispatchStepResult>;
}

const TERMINAL_OUTCOMES = new Set<QueueAnnounceOutcome>([
  "sent",
  "queued",
  "duplicate",
  "suppressed",
]);

export async function runSubagentAnnounceDispatch(
  steps: AnnounceDispatchStep[],
): Promise<{
  outcome: QueueAnnounceOutcome;
  phases: AnnounceDeliveryPhaseResult[];
}> {
  const phases: AnnounceDeliveryPhaseResult[] = [];
  let finalOutcome: QueueAnnounceOutcome = "failed";

  for (const step of steps) {
    const result = await step.run();
    finalOutcome = result.outcome;
    phases.push({
      phase: step.phase,
      outcome: result.outcome,
      attemptedAt: Date.now(),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.routeFailureReason
        ? { routeFailureReason: result.routeFailureReason }
        : {}),
      ...(result.routeCandidateChain
        ? { routeCandidateChain: result.routeCandidateChain }
        : {}),
    });

    const shouldContinue =
      result.continueToNextPhase ?? !TERMINAL_OUTCOMES.has(result.outcome);
    if (!shouldContinue) {
      break;
    }
  }

  return { outcome: finalOutcome, phases };
}
