import { createHash } from "node:crypto";
import {
  deliverToChannelResult,
  getDeliveryTargetForSession,
  parseDeliveryTarget,
  type DeliverToChannelOptions,
  type DeliveryTarget,
} from "../../agent/delivery.js";
import { createLogger } from "../../lib/logger.js";
import { sessionBindingService } from "../../services/session-binding.service.js";
import { sessionKeyResolverService } from "../../services/session-key-resolver.service.js";
import { runHookPhaseOutput } from "../../hooks/index.js";

const log = createLogger("agent");

export interface DeliveryRouteRequest {
  sessionId?: string;
  sessionKey?: string;
  preferredExternalId?: string;
  targetOverride?: DeliveryTarget | null;
  accountId?: string;
}

export type DeliveryRouteFailureReason =
  | "invalid-target-override"
  | "binding-missing"
  | "binding-invalid"
  | "preferred-target-invalid"
  | "no-delivery-target";

export interface DeliveryRouteDiagnostics {
  routeCandidateChain: string[];
  routeFailureReason?: DeliveryRouteFailureReason;
}

export interface RoutedDeliveryRequest extends DeliveryRouteRequest {
  content: string;
  idempotencyKey?: string;
  idempotencyOwner?: string;
  durability?: "direct" | "durable";
  reason?: string;
  expiresAt?: Date;
}

export interface DeliveryRouteResolution {
  sessionId?: string;
  sessionKey?: string;
  target: DeliveryTarget;
  diagnostics?: DeliveryRouteDiagnostics;
}

export type RoutedDeliveryResult =
  | {
      status: "sent";
      sessionId?: string;
      sessionKey?: string;
      target: DeliveryTarget;
      idempotencyKey?: string;
      diagnostics?: DeliveryRouteDiagnostics;
    }
  | { status: "suppressed"; reason: string }
  | { status: "failed"; reason: string; diagnostics?: DeliveryRouteDiagnostics };

function trim(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function buildDeliveryIdempotencyKey(input: {
  namespace: string;
  sessionId?: string;
  sessionKey?: string;
  reason?: string;
  content: string;
  eventKey?: string;
}): string {
  const namespace = trim(input.namespace) ?? "delivery";
  const identity = trim(input.sessionKey) ?? trim(input.sessionId) ?? "unknown";
  const reason = trim(input.reason) ?? "none";
  const eventKey = trim(input.eventKey) ?? "none";
  const contentHash = stableHash(input.content);
  return `${namespace}:v1:${identity}:${reason}:${eventKey}:${contentHash}`;
}

async function resolveSessionIdentity(params: {
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ sessionId?: string; sessionKey?: string }> {
  const sessionId = trim(params.sessionId);
  const sessionKey = trim(params.sessionKey);

  if (sessionId) {
    const identity = await sessionKeyResolverService.resolveBySessionId(sessionId);
    return {
      sessionId,
      ...(identity?.sessionKey ? { sessionKey: identity.sessionKey } : {}),
    };
  }

  if (sessionKey) {
    const identity = await sessionKeyResolverService.resolveBySessionKey(sessionKey);
    return {
      ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
      sessionKey,
    };
  }

  return {};
}

function normalizeTarget(target: DeliveryTarget | null | undefined): DeliveryTarget | null {
  if (!target || target.channel === "unknown") return null;
  return target;
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export async function resolveDeliveryRoute(
  request: DeliveryRouteRequest,
): Promise<DeliveryRouteResolution | null> {
  const detailed = await resolveDeliveryRouteDetailed(request);
  return detailed.route;
}

export async function resolveDeliveryRouteDetailed(
  request: DeliveryRouteRequest,
): Promise<{ route: DeliveryRouteResolution | null; diagnostics: DeliveryRouteDiagnostics }> {
  const identity = await resolveSessionIdentity({
    sessionId: request.sessionId,
    sessionKey: request.sessionKey,
  });
  const accountId = normalizeOptionalToken(request.accountId);
  const routeCandidateChain: string[] = [];

  const withRoute = (
    target: DeliveryTarget,
    candidate: string,
  ): { route: DeliveryRouteResolution; diagnostics: DeliveryRouteDiagnostics } => {
    routeCandidateChain.push(`${candidate}:selected`);
    return {
      route: {
        ...identity,
        target,
        diagnostics: {
          routeCandidateChain,
        },
      },
      diagnostics: {
        routeCandidateChain,
      },
    };
  };

  const noRoute = (
    reason: DeliveryRouteFailureReason = "no-delivery-target",
  ): { route: null; diagnostics: DeliveryRouteDiagnostics } => {
    const diagnostics: DeliveryRouteDiagnostics = {
      routeCandidateChain,
      routeFailureReason: reason,
    };
    log.warn(
      {
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey,
        routeFailureReason: reason,
        routeCandidateChain,
      },
      "Delivery route resolution failed",
    );
    return {
      route: null,
      diagnostics,
    };
  };

  if (request.targetOverride) {
    const target = normalizeTarget(request.targetOverride);
    if (!target) {
      routeCandidateChain.push("targetOverride:invalid-target-override");
    } else {
      return withRoute(target, "targetOverride");
    }
  }

  if (identity.sessionKey) {
    const binding = await sessionBindingService.resolveCurrentBindingBySessionKey(
      identity.sessionKey,
      accountId ? { accountId } : undefined,
    );
    if (!binding?.externalId) {
      routeCandidateChain.push("sessionKeyBinding:binding-missing");
    } else {
      const target = parseDeliveryTarget(binding.externalId);
      if (target && target.channel !== "unknown") {
        return withRoute(target, "sessionKeyBinding");
      }
      routeCandidateChain.push("sessionKeyBinding:binding-invalid");
    }
  }

  const preferredExternalId = trim(request.preferredExternalId);
  if (preferredExternalId) {
    const parsed = parseDeliveryTarget(preferredExternalId);
    if (parsed && parsed.channel !== "unknown") {
      return withRoute(parsed, "preferredExternalId");
    }
    routeCandidateChain.push("preferredExternalId:preferred-target-invalid");
  }

  if (identity.sessionId) {
    if (accountId) {
      const binding = await sessionBindingService.resolveCurrentBinding(identity.sessionId, {
        accountId,
      });
      if (!binding?.externalId) {
        routeCandidateChain.push("sessionIdBinding:binding-missing");
      } else {
        const parsed = parseDeliveryTarget(binding.externalId);
        if (parsed && parsed.channel !== "unknown") {
          return withRoute(parsed, "sessionIdBinding");
        }
        routeCandidateChain.push("sessionIdBinding:binding-invalid");
      }
    } else {
      const target = await getDeliveryTargetForSession(identity.sessionId);
      if (target) {
        return withRoute(target, "sessionIdBinding");
      }
      routeCandidateChain.push("sessionIdBinding:binding-missing");
    }
  }

  return noRoute();
}

export async function routeDelivery(
  request: RoutedDeliveryRequest,
): Promise<RoutedDeliveryResult> {
  const content = request.content.trim();
  if (!content) {
    return { status: "suppressed", reason: "empty-content" };
  }

  const resolved = await resolveDeliveryRouteDetailed(request);
  const route = resolved.route;
  if (!route) {
    return {
      status: "failed",
      reason: resolved.diagnostics.routeFailureReason ?? "no-delivery-target",
      diagnostics: resolved.diagnostics,
    };
  }

  let finalTarget: DeliveryTarget = route.target;
  let finalContent = content;

  try {
    const hookOutput = await runHookPhaseOutput("before_delivery", {
      sessionId: route.sessionId ?? "unknown",
      sessionKey: route.sessionKey,
      content,
      target: route.target,
    });

    if (hookOutput.suppress === true) {
      return {
        status: "suppressed",
        reason: hookOutput.reason ?? "before-delivery-suppressed",
      };
    }

    if (hookOutput.target) {
      finalTarget = hookOutput.target;
    }
    if (typeof hookOutput.content === "string") {
      finalContent = hookOutput.content.trim();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      {
        err: error,
        sessionId: route.sessionId,
        sessionKey: route.sessionKey,
      },
      "before_delivery hook blocked delivery",
    );
    return {
      status: "failed",
      reason: `before-delivery-fail-closed:${message}`,
    };
  }

  if (!finalContent) {
    return { status: "suppressed", reason: "empty-content-after-hook" };
  }

  const idempotencyKey =
    trim(request.idempotencyKey) ??
    buildDeliveryIdempotencyKey({
      namespace: "delivery",
      sessionId: route.sessionId,
      sessionKey: route.sessionKey,
      reason: request.reason,
      content: finalContent,
    });

  const deliverOptions: DeliverToChannelOptions = {
    durability: request.durability ?? "direct",
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    ...(request.idempotencyOwner ? { idempotencyOwner: request.idempotencyOwner } : {}),
    idempotencyKey,
  };

  const delivered = await deliverToChannelResult(
    finalTarget,
    finalContent,
    deliverOptions,
  );
  if (delivered.status === "failed") {
    if (request.targetOverride) {
      log.warn(
        {
          sessionId: route.sessionId,
          sessionKey: route.sessionKey,
          failedTargetExternalId: finalTarget.externalId,
          fallbackPreferredExternalId: request.preferredExternalId,
          reason: delivered.reason,
        },
        "Primary targetOverride delivery failed; attempting route fallback",
      );
      const fallbackResult = await routeDelivery({
        ...request,
        targetOverride: undefined,
        idempotencyKey,
        content: finalContent,
      });
      if (fallbackResult.status === "sent" || fallbackResult.status === "suppressed") {
        return fallbackResult;
      }
      if (fallbackResult.reason === "no-delivery-target") {
        return {
          status: "failed",
          reason: delivered.reason,
          diagnostics: route.diagnostics,
        };
      }
      return {
        status: "failed",
        reason: fallbackResult.reason,
        diagnostics: fallbackResult.diagnostics ?? route.diagnostics,
      };
    }
    return { status: "failed", reason: delivered.reason, diagnostics: route.diagnostics };
  }
  if (delivered.status === "suppressed") {
    return { status: "suppressed", reason: delivered.reason };
  }

  return {
    status: "sent",
    sessionId: route.sessionId,
    ...(route.sessionKey ? { sessionKey: route.sessionKey } : {}),
    target: finalTarget,
    idempotencyKey,
    diagnostics: route.diagnostics,
  };
}
