import {
  getExecApprovalRecord,
  getSessionOwnerUserId,
  getUserBySlackExternalId,
  getUserRoleById,
} from "./exec-approval-store.js";

interface AuthResult {
  ok: boolean;
  reason?: string;
  resolvedBy?: string;
}

function isPrivilegedRole(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

function decideResolverAccess(params: {
  sessionOwnerUserId: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
}): AuthResult {
  if (isPrivilegedRole(params.actorRole ?? null)) {
    return { ok: true };
  }

  if (!params.sessionOwnerUserId) {
    return { ok: false, reason: "session owner not found" };
  }

  if (params.actorUserId && params.sessionOwnerUserId === params.actorUserId) {
    return { ok: true };
  }

  return { ok: false, reason: "not authorized to resolve this approval" };
}

export async function authorizeSlackApprovalResolver(params: {
  approvalId: string;
  slackUserId: string;
}): Promise<AuthResult> {
  const approval = await getExecApprovalRecord(params.approvalId);
  if (!approval) {
    return { ok: false, reason: "approval is not pending (already resolved or expired)" };
  }

  const [sessionOwnerUserId, actor] = await Promise.all([
    getSessionOwnerUserId(approval.sessionId),
    getUserBySlackExternalId(params.slackUserId),
  ]);

  const access = decideResolverAccess({
    sessionOwnerUserId,
    actorUserId: actor?.id,
    actorRole: actor?.role,
  });

  if (!access.ok) {
    return access;
  }

  return {
    ok: true,
    resolvedBy: actor?.id ?? `slack:${params.slackUserId}`,
  };
}

export async function authorizeUserApprovalResolver(params: {
  approvalId: string;
  userId: string;
}): Promise<AuthResult> {
  const approval = await getExecApprovalRecord(params.approvalId);
  if (!approval) {
    return { ok: false, reason: "approval is not pending (already resolved or expired)" };
  }

  const [sessionOwnerUserId, role] = await Promise.all([
    getSessionOwnerUserId(approval.sessionId),
    getUserRoleById(params.userId),
  ]);

  const access = decideResolverAccess({
    sessionOwnerUserId,
    actorUserId: params.userId,
    actorRole: role,
  });
  if (!access.ok) {
    return access;
  }

  return {
    ok: true,
    resolvedBy: params.userId,
  };
}
