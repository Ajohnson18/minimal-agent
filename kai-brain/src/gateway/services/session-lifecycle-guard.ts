import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { runtime } from "../runtime.js";
import { stopSessionHeartbeat } from "./heartbeat-lifecycle.js";
import { queueService } from "./queue.js";
import { clearSystemEvents } from "./system-events.js";
import { killAllForParent } from "../../agent/tools/subagent-registry.js";
import { outboundDeliveryQueueService } from "../../services/outbound-delivery-queue.service.js";
import { sessionBindingService } from "../../services/session-binding.service.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("gateway", { component: "session-lifecycle" });
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionLifecycleState = "active" | "archiving" | "archived" | "deleted";

function isDeliverable(state: {
  status?: string | null;
  lifecycleState?: string | null;
}): boolean {
  const lifecycle = (state.lifecycleState || "active").toLowerCase();
  const status = (state.status || "active").toLowerCase();
  if (lifecycle === "archived" || lifecycle === "deleted") return false;
  if (status === "archived" || status === "deleted") return false;
  return true;
}

async function terminateSessionWork(sessionId: string): Promise<void> {
  stopSessionHeartbeat(sessionId);
  for (const run of runtime.getRunsBySession(sessionId)) {
    runtime.cancelRun(run.runId);
  }
  await queueService.cancelPending(sessionId);
  killAllForParent(sessionId);
  await clearSystemEvents(sessionId);
  await outboundDeliveryQueueService.cancelPendingForSession(sessionId);
  await sessionBindingService.invalidateBinding(sessionId);
}

export async function canDeliverToSession(sessionId: string): Promise<boolean> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return false;
  if (!UUID_RE.test(normalizedSessionId)) return true;

  try {
    const [session] = await db
      .select({
        status: avaSessions.status,
        lifecycleState: avaSessions.lifecycleState,
      })
      .from(avaSessions)
      .where(eq(avaSessions.id, normalizedSessionId))
      .limit(1);

    if (!session) return false;
    return isDeliverable(session);
  } catch (error) {
    log.error(
      { err: error, sessionId: normalizedSessionId },
      "Failed to read session lifecycle state; blocking delivery",
    );
    return false;
  }
}

export async function archiveSessionAndTerminateWork(
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return false;

  const now = new Date();
  const [session] = await db
    .update(avaSessions)
    .set({
      status: "archived",
      lifecycleState: "archived" satisfies SessionLifecycleState,
      archivedAt: now,
      archivedByReason: reason.slice(0, 1000),
      updatedAt: now,
    })
    .where(eq(avaSessions.id, normalizedSessionId))
    .returning({ id: avaSessions.id });

  if (!session) return false;

  await terminateSessionWork(normalizedSessionId);
  log.info({ sessionId: normalizedSessionId, reason }, "Session archived and work terminated");
  return true;
}

export async function deleteSessionAndTerminateWork(
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return false;

  const now = new Date();
  const [session] = await db
    .update(avaSessions)
    .set({
      status: "deleted",
      lifecycleState: "deleted" satisfies SessionLifecycleState,
      deletedAt: now,
      archivedByReason: reason.slice(0, 1000),
      updatedAt: now,
    })
    .where(eq(avaSessions.id, normalizedSessionId))
    .returning({ id: avaSessions.id });

  if (!session) return false;

  await terminateSessionWork(normalizedSessionId);
  log.info({ sessionId: normalizedSessionId, reason }, "Session deleted and work terminated");
  return true;
}
