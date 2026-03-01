import { beforeEach, describe, expect, test } from "vitest";

import { eq } from "drizzle-orm";
import { db } from "../../../src/db/client.js";
import { avaOutboundIdempotency } from "../../../src/db/schema/outbound-idempotency.js";
import { outboundIdempotencyService } from "../../../src/services/outbound-idempotency.service.js";
import { isTestDatabaseReady, uniqueId } from "../../helpers/db.js";
import { truncateReliabilityTables } from "../../helpers/reliability-db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: outbound idempotency service", () => {
  beforeEach(async () => {
    await truncateReliabilityTables();
  });

  test("reserve -> markSent -> isAlreadySent", async () => {
    const key = uniqueId("idem");

    const reserved = await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "job-1",
    });
    expect(reserved.status).toBe("reserved");

    const marked = await outboundIdempotencyService.markSent({
      key,
      deliveryJobId: "job-1",
    });
    expect(marked).toBe(true);

    const alreadySent = await outboundIdempotencyService.isAlreadySent({ key });
    expect(alreadySent).toBe(true);
  });

  test("reservePending returns inflight when owner differs", async () => {
    const key = uniqueId("idem-inflight");

    const first = await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "job-owner-a",
    });
    expect(first.status).toBe("reserved");

    const second = await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "job-owner-b",
    });
    expect(second.status).toBe("inflight");
    expect(second.owner).toBe("job-owner-a");
  });

  test("releasePendingForRetry keeps row pending and updates lastError", async () => {
    const key = uniqueId("idem-retry");

    await outboundIdempotencyService.reservePending({
      key,
      deliveryJobId: "job-retry",
    });

    const released = await outboundIdempotencyService.releasePendingForRetry({
      key,
      deliveryJobId: "job-retry",
      error: "transient-slack-error",
    });

    expect(released).toBe(true);

    const [stored] = await db
      .select()
      .from(avaOutboundIdempotency)
      .where(eq(avaOutboundIdempotency.idempotencyKey, key))
      .limit(1);

    expect(stored?.state).toBe("pending");
    expect(stored?.deliveryJobId).toBe("job-retry");
    expect(stored?.lastError).toBe("transient-slack-error");
  });

  test("cleanupExpired removes past-expiry rows", async () => {
    const key = uniqueId("idem-expired");

    await db.insert(avaOutboundIdempotency).values({
      idempotencyKey: key,
      state: "pending",
      deliveryJobId: "job-expired",
      expiresAt: new Date(Date.now() - 5_000),
    });

    const deleted = await outboundIdempotencyService.cleanupExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const [stillThere] = await db
      .select({ idempotencyKey: avaOutboundIdempotency.idempotencyKey })
      .from(avaOutboundIdempotency)
      .where(eq(avaOutboundIdempotency.idempotencyKey, key))
      .limit(1);

    expect(stillThere).toBeUndefined();
  });
});
