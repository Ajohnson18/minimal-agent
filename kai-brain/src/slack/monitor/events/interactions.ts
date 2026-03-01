import {
  EXEC_APPROVAL_ACTION_ID,
  decodeExecApprovalActionValue,
  resolveExecApprovalDecisionBySlackUser,
  type ExecApprovalDecision,
} from "../../../services/exec-approval.service.js";
import type { SlackInteractionPayload } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";

function normalizeResolveReason(reason?: string): string {
  const normalized = reason?.trim();
  if (!normalized) {
    return "already resolved or expired";
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("not authorized")) {
    return "not authorized";
  }
  if (lower.includes("expired")) {
    return "expired";
  }
  if (lower.includes("already resolved") || lower.includes("not pending")) {
    return "already resolved or expired";
  }
  return normalized;
}

async function updateExecApprovalInteractionMessage(params: {
  responseUrl?: string;
  ok: boolean;
  decision: ExecApprovalDecision;
  actorUserId?: string;
  reason?: string;
}): Promise<void> {
  if (!params.responseUrl) {
    return;
  }

  const actor = params.actorUserId ? `<@${params.actorUserId}>` : "a user";
  const decisionLabel =
    params.decision === "allow-once"
      ? "approved once"
      : params.decision === "allow-always"
        ? "approved (always allow)"
        : "denied";
  const text = params.ok
    ? `Exec approval ${decisionLabel} by ${actor}.`
    : `Exec approval could not be applied (${normalizeResolveReason(params.reason)}).`;

  try {
    await fetch(params.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text,
            },
          },
        ],
      }),
    });
  } catch {
    // Slack already received an ACK; failures here are non-fatal.
  }
}

export async function handleSlackInteractionEvent(params: {
  ctx: SlackMonitorContext;
  payload: SlackInteractionPayload;
}): Promise<void> {
  const { ctx, payload } = params;

  if (payload.type !== "block_actions" || !Array.isArray(payload.actions)) {
    return;
  }

  const actorUserId =
    typeof payload.user?.id === "string" ? payload.user.id : undefined;

  for (const action of payload.actions) {
    if (action?.action_id !== EXEC_APPROVAL_ACTION_ID) {
      continue;
    }

    const dedupeKey = [
      "interaction",
      actorUserId || "unknown",
      payload.container?.message_ts || payload.message?.ts || "unknown",
      action.action_id || "",
      action.value || "",
    ].join(":");
    if (ctx.markInteractionSeen(dedupeKey)) {
      return;
    }

    const decoded = decodeExecApprovalActionValue(action.value);
    if (!decoded) {
      await updateExecApprovalInteractionMessage({
        responseUrl: payload.response_url,
        ok: false,
        decision: "deny",
        actorUserId,
        reason: "invalid approval action payload",
      });
      return;
    }

    if (!actorUserId) {
      await updateExecApprovalInteractionMessage({
        responseUrl: payload.response_url,
        ok: false,
        decision: decoded.decision,
        reason: "missing actor identity",
      });
      return;
    }

    const result = await resolveExecApprovalDecisionBySlackUser({
      approvalId: decoded.approvalId,
      decision: decoded.decision,
      slackUserId: actorUserId,
    });

    await updateExecApprovalInteractionMessage({
      responseUrl: payload.response_url,
      ok: result.ok,
      decision: decoded.decision,
      actorUserId,
      reason: result.ok ? undefined : result.reason,
    });
    return;
  }
}
