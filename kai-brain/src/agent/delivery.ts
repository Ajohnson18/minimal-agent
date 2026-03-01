/**
 * Channel-Agnostic Delivery
 *
 * Routes agent responses to the appropriate channel based on session externalId.
 * Supports direct send and durable queued send for restart-safe async delivery.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { avaSessions } from "../db/schema/sessions.js";
import { createLogger } from "../lib/logger.js";
import { markdownToSlackMrkdwn } from "../lib/slack/format.js";
import { outboundIdempotencyService } from "../services/outbound-idempotency.service.js";
import { outboundDeliveryQueueService } from "../services/outbound-delivery-queue.service.js";
import { sessionBindingService } from "../services/session-binding.service.js";

const log = createLogger("agent");

/**
 * Parsed channel info from an externalId.
 */
export interface DeliveryTarget {
  channel: "slack" | "unknown";
  /** Raw external ID string */
  externalId: string;
  /** Channel-specific fields */
  slack?: {
    channelId: string;
    threadTs?: string;
  };
}

export interface DeliverToChannelOptions {
  idempotencyKey?: string;
  idempotencyOwner?: string;
  durability?: "direct" | "durable";
  sessionId?: string;
  expiresAt?: Date;
  reason?: string;
}

export type DeliverToChannelResult =
  | { status: "sent" }
  | { status: "suppressed"; reason: "already-sent" | "idempotency-inflight" }
  | { status: "failed"; reason: string };

function isDurableDeliveryEnabled(): boolean {
  const envValue = process.env.AVA_OUTBOUND_DURABLE;
  if (!envValue) return true;
  return !["0", "false", "off", "no"].includes(envValue.toLowerCase());
}

function normalizeOwner(owner: string | undefined): string | undefined {
  const normalized = owner?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Parse a session externalId into a delivery target.
 *
 * Formats:
 * - "slack:CHANNEL_ID:THREAD_TS" → Slack thread
 * - "slack:dm:USER_ID" → Slack DM
 */
export function parseDeliveryTarget(externalId: string): DeliveryTarget | null {
  if (!externalId) return null;

  if (externalId.startsWith("slack:")) {
    const parts = externalId.split(":");
    if (parts.length < 2) return null;

    // DM format: "slack:dm:USER_ID"
    if (parts[1] === "dm") {
      return {
        channel: "slack",
        externalId,
        slack: {
          channelId: parts[2] || "",
        },
      };
    }

    // Thread format: "slack:CHANNEL_ID:THREAD_TS"
    return {
      channel: "slack",
      externalId,
      slack: {
        channelId: parts[1],
        threadTs: parts[2] || undefined,
      },
    };
  }

  return { channel: "unknown", externalId };
}

function normalizeDeliveryTarget(target: DeliveryTarget): DeliveryTarget | null {
  if (target.channel !== "slack") {
    return null;
  }
  const externalId = target.externalId?.trim();
  if (!externalId) {
    return null;
  }
  const parsed = parseDeliveryTarget(externalId);
  if (!parsed || parsed.channel === "unknown") {
    return null;
  }
  return parsed;
}

/**
 * Look up the delivery target for a session by its ID.
 * Prefers current session binding to avoid stale thread routing.
 */
export async function getDeliveryTargetForSession(
  sessionId: string,
): Promise<DeliveryTarget | null> {
  try {
    const binding = await sessionBindingService.resolveCurrentBinding(sessionId);
    if (binding?.externalId) {
      const fromBinding = parseDeliveryTarget(binding.externalId);
      if (fromBinding && fromBinding.channel !== "unknown") {
        return fromBinding;
      }
    }

    const [session] = await db
      .select({ externalId: avaSessions.externalId })
      .from(avaSessions)
      .where(eq(avaSessions.id, sessionId))
      .limit(1);

    if (!session?.externalId) return null;
    return parseDeliveryTarget(session.externalId);
  } catch (err) {
    log.error({ err, sessionId }, "Failed to look up delivery target");
    return null;
  }
}

async function queueDurableDelivery(
  target: DeliveryTarget,
  content: string,
  opts: DeliverToChannelOptions,
): Promise<DeliverToChannelResult> {
  const normalizedTarget = normalizeDeliveryTarget(target);
  if (!normalizedTarget) {
    log.warn(
      { channel: target.channel, externalId: target.externalId },
      "Unknown delivery channel for durable enqueue",
    );
    return { status: "failed", reason: "unknown-channel" };
  }

  const idempotencyKey = opts.idempotencyKey?.trim();
  const idempotencyOwner = normalizeOwner(opts.idempotencyOwner);
  let reservationStatus: "reserved" | "already-sent" | "inflight" | undefined;
  if (idempotencyKey) {
    const alreadySent = await outboundIdempotencyService.isAlreadySent({
      key: idempotencyKey,
    });
    if (alreadySent) {
      log.info(
        { idempotencyKey, channel: normalizedTarget.channel },
        "Skipping durable enqueue for already-sent key",
      );
      return { status: "suppressed", reason: "already-sent" };
    }
  }

  const job = await outboundDeliveryQueueService.enqueueOutboundJob({
    sessionId: opts.sessionId,
    routeSnapshot: normalizedTarget as unknown as Record<string, unknown>,
    payload: { content },
    idempotencyKey,
    reason: opts.reason ?? "async-delivery",
    expiresAt: opts.expiresAt,
  });

  if (idempotencyKey) {
    const reservation = await outboundIdempotencyService.reservePending({
      key: idempotencyKey,
      deliveryJobId: idempotencyOwner ?? job.id,
    });
    reservationStatus = reservation.status;
    if (reservation.status === "already-sent") {
      await outboundDeliveryQueueService.markJobSent(job.id, {
        duplicate: true,
        reason: "already-sent",
      });
      return { status: "suppressed", reason: "already-sent" };
    }
    if (reservation.status === "inflight") {
      await outboundDeliveryQueueService.markJobSent(job.id, {
        duplicate: true,
        reason: "idempotency-inflight",
      });
      return { status: "suppressed", reason: "idempotency-inflight" };
    }
  }

  if (reservationStatus && reservationStatus !== "reserved") {
    return { status: "suppressed", reason: "already-sent" };
  }

  const { wakeOutboundPump } = await import(
    "../gateway/services/outbound-delivery-pump.js"
  );
  wakeOutboundPump("enqueue");
  return { status: "sent" };
}

/**
 * Deliver a message to Slack.
 */
async function deliverToSlack(target: DeliveryTarget, content: string): Promise<boolean> {
  if (!target.slack) return false;

  try {
    const { getSlackApp } = await import("../lib/slack/app.js");
    const app = getSlackApp();
    if (!app) {
      log.error("Slack app not initialized for delivery");
      return false;
    }

    const { channelId, threadTs } = target.slack;
    const text = markdownToSlackMrkdwn(content);

    await app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      mrkdwn: true,
    });

    log.info({ channel: channelId, thread: threadTs }, "Delivered to Slack");
    return true;
  } catch (err) {
    log.error({ err }, "Failed to deliver to Slack");
    return false;
  }
}

async function deliverDirect(
  target: DeliveryTarget,
  content: string,
  opts?: DeliverToChannelOptions,
): Promise<DeliverToChannelResult> {
  const normalizedTarget = normalizeDeliveryTarget(target);
  if (!normalizedTarget) {
    log.warn(
      { channel: target.channel, externalId: target.externalId },
      "Unknown delivery channel",
    );
    return { status: "failed", reason: "unknown-channel" };
  }

  const idempotencyKey = opts?.idempotencyKey?.trim();
  const providedOwner = normalizeOwner(opts?.idempotencyOwner);
  const reservationOwner = idempotencyKey
    ? (providedOwner ?? `direct:${process.pid}:${randomUUID()}`)
    : undefined;
  if (idempotencyKey) {
    const reservation = await outboundIdempotencyService.reservePending({
      key: idempotencyKey,
      deliveryJobId: reservationOwner,
    });
    if (reservation.status === "already-sent") {
      log.info(
        { idempotencyKey, channel: normalizedTarget.channel },
        "Skipping duplicate outbound direct delivery",
      );
      return { status: "suppressed", reason: "already-sent" };
    }
    if (reservation.status === "inflight") {
      log.info(
        { idempotencyKey, channel: normalizedTarget.channel },
        "Skipping outbound direct delivery while identical send is in-flight",
      );
      return { status: "suppressed", reason: "idempotency-inflight" };
    }
  }

  let delivered = false;
  switch (normalizedTarget.channel) {
    case "slack":
      delivered = await deliverToSlack(normalizedTarget, content);
      break;
    default:
      delivered = false;
      break;
  }

  if (idempotencyKey) {
    if (delivered) {
      await outboundIdempotencyService.markSent({
        key: idempotencyKey,
        deliveryJobId: reservationOwner,
      });
    } else {
      await outboundIdempotencyService.releasePendingForRetry({
        key: idempotencyKey,
        error: "direct-delivery-failed",
        deliveryJobId: reservationOwner,
      });
    }
  }

  if (!delivered) {
    return { status: "failed", reason: "delivery-failed" };
  }

  return { status: "sent" };
}

/**
 * Deliver a message to a session's channel.
 * Channel-agnostic: routes to Slack, Telegram, etc. based on externalId.
 */
export async function deliverToChannelResult(
  target: DeliveryTarget,
  content: string,
  opts?: DeliverToChannelOptions,
): Promise<DeliverToChannelResult> {
  const durability = opts?.durability ?? "direct";
  if (durability === "durable" && isDurableDeliveryEnabled()) {
    return queueDurableDelivery(target, content, opts ?? {});
  }
  return deliverDirect(target, content, opts);
}

export async function deliverToChannel(
  target: DeliveryTarget,
  content: string,
  opts?: DeliverToChannelOptions,
): Promise<boolean> {
  const result = await deliverToChannelResult(target, content, opts);
  return result.status !== "failed";
}
