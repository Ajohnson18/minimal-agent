import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { avaOutboundIdempotency } from "../db/schema/outbound-idempotency.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("agent");

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export type OutboundIdempotencyState = "pending" | "sent";

export interface OutboundIdempotencyParams {
  key: string;
  ttlSeconds?: number;
  deliveryJobId?: string;
}

type ReservePendingStatus = "reserved" | "inflight" | "already-sent";

interface ReservePendingResult {
  status: ReservePendingStatus;
  owner?: string | null;
}

function normalizeKey(key: string | undefined): string {
  return typeof key === "string" ? key.trim() : "";
}

function resolveTtlSeconds(ttlSeconds?: number): number {
  if (!Number.isFinite(ttlSeconds)) return DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  return Math.max(1, Math.floor(ttlSeconds!));
}

function normalizeOwner(deliveryJobId: string | undefined): string | null {
  const normalized =
    typeof deliveryJobId === "string" ? deliveryJobId.trim() : "";
  return normalized || null;
}

export class OutboundIdempotencyService {
  private async deleteExpired(rawKey: string, now: Date): Promise<void> {
    await db
      .delete(avaOutboundIdempotency)
      .where(
        and(
          eq(avaOutboundIdempotency.idempotencyKey, rawKey),
          lt(avaOutboundIdempotency.expiresAt, now),
        ),
      );
  }

  async reservePending(
    params: OutboundIdempotencyParams,
  ): Promise<ReservePendingResult> {
    const rawKey = normalizeKey(params.key);
    if (!rawKey) {
      return { status: "reserved" };
    }

    const now = new Date();
    const ttlSeconds = resolveTtlSeconds(params.ttlSeconds);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const deliveryJobId = normalizeOwner(params.deliveryJobId);

    try {
      await this.deleteExpired(rawKey, now);

      const inserted = await db
        .insert(avaOutboundIdempotency)
        .values({
          idempotencyKey: rawKey,
          state: "pending",
          deliveryJobId,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({
          idempotencyKey: avaOutboundIdempotency.idempotencyKey,
        });

      if (inserted.length > 0) {
        return { status: "reserved" };
      }

      const [existing] = await db
        .select({
          state: avaOutboundIdempotency.state,
          deliveryJobId: avaOutboundIdempotency.deliveryJobId,
        })
        .from(avaOutboundIdempotency)
        .where(eq(avaOutboundIdempotency.idempotencyKey, rawKey))
        .limit(1);

      if (!existing) {
        return { status: "reserved" };
      }

      if (existing.state === "sent") {
        return { status: "already-sent" };
      }

      const existingOwner = normalizeOwner(existing.deliveryJobId ?? undefined);
      if (
        existingOwner &&
        (!deliveryJobId || existingOwner !== deliveryJobId)
      ) {
        return { status: "inflight", owner: existingOwner };
      }

      // Keep pending records fresh for the owner that won reservation.
      const nextOwner = deliveryJobId ?? existingOwner;
      await db
        .update(avaOutboundIdempotency)
        .set({
          state: "pending",
          deliveryJobId: nextOwner,
          expiresAt,
        })
        .where(eq(avaOutboundIdempotency.idempotencyKey, rawKey));

      return { status: "reserved", owner: nextOwner };
    } catch (error) {
      log.error(
        { err: error, key: rawKey },
        "Failed to reserve outbound idempotency key; allowing send",
      );
      return { status: "reserved" };
    }
  }

  async markSent(params: {
    key: string;
    deliveryJobId?: string;
  }): Promise<boolean> {
    const rawKey = normalizeKey(params.key);
    if (!rawKey) return false;

    const owner = normalizeOwner(params.deliveryJobId);

    try {
      const updated = await db
        .update(avaOutboundIdempotency)
        .set({
          state: "sent",
          sentAt: new Date(),
          deliveryJobId: owner,
          lastError: null,
        })
        .where(
          owner
            ? and(
                eq(avaOutboundIdempotency.idempotencyKey, rawKey),
                or(
                  eq(avaOutboundIdempotency.deliveryJobId, owner),
                  isNull(avaOutboundIdempotency.deliveryJobId),
                ),
              )
            : eq(avaOutboundIdempotency.idempotencyKey, rawKey),
        )
        .returning({ idempotencyKey: avaOutboundIdempotency.idempotencyKey });

      if (updated.length === 0) {
        log.warn(
          { key: rawKey, owner },
          "Skipped markSent because reservation owner did not match",
        );
      }
      return updated.length > 0;
    } catch (error) {
      log.error({ err: error, key: rawKey }, "Failed to mark idempotency key sent");
      return false;
    }
  }

  async releasePendingForRetry(params: {
    key: string;
    error?: string;
    deliveryJobId?: string;
    ttlSeconds?: number;
  }): Promise<boolean> {
    const rawKey = normalizeKey(params.key);
    if (!rawKey) return false;

    const ttlSeconds = resolveTtlSeconds(params.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const owner = normalizeOwner(params.deliveryJobId);

    try {
      const updated = await db
        .update(avaOutboundIdempotency)
        .set({
          state: "pending",
          ...(owner ? { deliveryJobId: owner } : {}),
          lastError: params.error?.slice(0, 2000) || null,
          expiresAt,
        })
        .where(
          owner
            ? and(
                eq(avaOutboundIdempotency.idempotencyKey, rawKey),
                or(
                  eq(avaOutboundIdempotency.deliveryJobId, owner),
                  isNull(avaOutboundIdempotency.deliveryJobId),
                ),
              )
            : eq(avaOutboundIdempotency.idempotencyKey, rawKey),
        )
        .returning({ idempotencyKey: avaOutboundIdempotency.idempotencyKey });

      if (updated.length === 0) {
        log.warn(
          { key: rawKey, owner },
          "Skipped idempotency retry release because reservation owner did not match",
        );
      }
      return updated.length > 0;
    } catch (error) {
      log.error(
        { err: error, key: rawKey },
        "Failed to release pending idempotency key for retry",
      );
      return false;
    }
  }

  async isAlreadySent(params: { key: string }): Promise<boolean> {
    const rawKey = normalizeKey(params.key);
    if (!rawKey) return false;

    try {
      await this.deleteExpired(rawKey, new Date());

      const [row] = await db
        .select({ state: avaOutboundIdempotency.state })
        .from(avaOutboundIdempotency)
        .where(eq(avaOutboundIdempotency.idempotencyKey, rawKey))
        .limit(1);

      return row?.state === "sent";
    } catch (error) {
      log.error(
        { err: error, key: rawKey },
        "Failed to read outbound idempotency state",
      );
      return false;
    }
  }

  // Backward-compatible helper used in existing direct paths.
  async recordOrDetectDuplicate(
    params: OutboundIdempotencyParams,
  ): Promise<{ duplicate: boolean }> {
    const result = await this.reservePending(params);
    return {
      duplicate:
        result.status === "already-sent" || result.status === "inflight",
    };
  }

  async cleanupExpired(): Promise<number> {
    try {
      const now = new Date();
      const deleted = await db
        .delete(avaOutboundIdempotency)
        .where(lt(avaOutboundIdempotency.expiresAt, now))
        .returning({ idempotencyKey: avaOutboundIdempotency.idempotencyKey });
      return deleted.length;
    } catch (error) {
      log.error({ err: error }, "Failed outbound idempotency cleanup");
      return 0;
    }
  }
}

export const outboundIdempotencyService = new OutboundIdempotencyService();
