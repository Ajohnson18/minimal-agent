import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import type {
  ExecApprovalRequestParams,
  ExecApprovalRequestResult,
  ExecApprovalResolveParams,
  ExecApprovalResolveResult,
  ExecApprovalWaitDecisionParams,
  ExecApprovalWaitDecisionResult,
} from "../protocol/methods.js";
import { runtime } from "../runtime.js";
import {
  requestExecApprovalPending,
  resolveExecApprovalDecisionByUserId,
  type ExecApprovalDecision,
  waitForExecApprovalDecision,
} from "../../services/exec-approval.service.js";
import { getSessionOwnerUserId } from "../../services/exec-approval-store.js";
import { resolveGatewaySessionIdentity } from "../services/session-identity.js";

async function canRequestApprovalForSession(
  sessionId: string,
  authUserId?: string,
): Promise<boolean> {
  if (!authUserId) {
    return true;
  }

  const ownerUserId = await getSessionOwnerUserId(sessionId);
  return ownerUserId === authUserId;
}

export async function execApprovalRequest(
  params: ExecApprovalRequestParams,
  authUserId?: string,
): Promise<ExecApprovalRequestResult | RpcError> {
  const requestedSessionId = (params as { sessionId?: string }).sessionId;

  if (!params?.command || !params?.cwd) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionKey, command, and cwd are required",
    );
  }

  if (!params.sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }
  if (requestedSessionId) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "sessionId is no longer accepted; use sessionKey",
    );
  }

  const identity = await resolveGatewaySessionIdentity({
    sessionKey: params.sessionKey,
  });
  if (!identity) {
    return createError(
      ErrorCodes.NOT_FOUND,
      `Session ${params.sessionKey} not found`,
    );
  }

  const ownerAllowed = await canRequestApprovalForSession(identity.sessionId, authUserId);
  if (!ownerAllowed) {
    return createError(
      ErrorCodes.UNAUTHORIZED,
      "Not authorized to request approval for this session",
    );
  }

  const started = await requestExecApprovalPending({
    sessionId: identity.sessionId,
    command: params.command,
    cwd: params.cwd,
    host: params.host,
    security: params.security,
    ask: params.ask,
    timeoutMs: params.timeoutMs,
    userId: authUserId ?? params.userId,
    agentId: params.agentId,
    resolvedPath: params.resolvedPath,
  });

  if (!started.ok) {
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      started.result.reason ?? "Failed to request approval",
    );
  }

  const pending = started.pending;

  runtime.broadcast({
    event: "exec.approval.requested",
    payload: {
      id: pending.approvalId,
      request: {
        sessionKey: identity.sessionKey,
        command: params.command,
        cwd: params.cwd,
        host: params.host,
        security: params.security,
        ask: params.ask,
        ...(authUserId ? { userId: authUserId } : params.userId ? { userId: params.userId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.resolvedPath ? { resolvedPath: params.resolvedPath } : {}),
      },
      createdAtMs: pending.createdAtMs,
      expiresAtMs: pending.expiresAtMs,
    },
  });

  void pending.decisionPromise.then((result) => {
    if (result.decision !== "timeout" && result.decision !== "error") {
      return;
    }

    runtime.broadcast({
      event: "exec.approval.resolved",
      payload: {
        id: pending.approvalId,
        decision: result.decision,
        resolvedBy: result.resolvedBy,
        ts: Date.now(),
      },
    });
  });

  if (params.twoPhase === true) {
    return {
      id: pending.approvalId,
      sessionKey: identity.sessionKey,
      status: "accepted",
      createdAtMs: pending.createdAtMs,
      expiresAtMs: pending.expiresAtMs,
    };
  }

  const result = await pending.decisionPromise;
  return {
    id: pending.approvalId,
    sessionKey: identity.sessionKey,
    decision:
      result.decision === "allow-once" ||
      result.decision === "allow-always" ||
      result.decision === "deny"
        ? result.decision
        : null,
    createdAtMs: pending.createdAtMs,
    expiresAtMs: pending.expiresAtMs,
  };
}

export async function execApprovalWaitDecision(
  params: ExecApprovalWaitDecisionParams,
): Promise<ExecApprovalWaitDecisionResult | RpcError> {
  const id = params.id?.trim();
  if (!id) {
    return createError(ErrorCodes.INVALID_PARAMS, "id is required");
  }

  const result = await waitForExecApprovalDecision(id);
  if (!result) {
    return createError(
      ErrorCodes.NOT_FOUND,
      "approval expired or not found",
    );
  }

  return {
    id,
    decision:
      result.decision === "allow-once" ||
      result.decision === "allow-always" ||
      result.decision === "deny"
        ? result.decision
        : null,
  };
}

export async function execApprovalResolve(
  params: ExecApprovalResolveParams,
  authUserId?: string,
): Promise<ExecApprovalResolveResult | RpcError> {
  if (!params?.id || !params?.decision) {
    return createError(ErrorCodes.INVALID_PARAMS, "id and decision are required");
  }

  if (!authUserId) {
    return createError(ErrorCodes.UNAUTHORIZED, "Authentication required");
  }

  const decision = params.decision as ExecApprovalDecision;
  if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
    return createError(ErrorCodes.INVALID_PARAMS, "invalid decision");
  }

  const resolved = await resolveExecApprovalDecisionByUserId({
    approvalId: params.id,
    decision,
    userId: authUserId,
  });

  if (!resolved.ok) {
    return createError(
      resolved.reason?.includes("not authorized")
        ? ErrorCodes.UNAUTHORIZED
        : ErrorCodes.NOT_FOUND,
      resolved.reason ?? "failed to resolve approval",
    );
  }

  runtime.broadcast({
    event: "exec.approval.resolved",
    payload: {
      id: params.id,
      decision,
      resolvedBy: authUserId,
      ts: Date.now(),
    },
  });

  return { ok: true };
}
