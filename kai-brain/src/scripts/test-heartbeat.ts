/**
 * Heartbeat smoke script.
 *
 * Kept for manual debugging. For CI/PR confidence, use the formal Vitest suites.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  queueSystemEvent,
  peekSystemEvents,
  removeSystemEvent,
  getEventStats,
} from "../gateway/services/system-events.js";
import {
  startHeartbeat,
  stopHeartbeat,
  getHeartbeatStats,
} from "../gateway/services/heartbeat.service.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(): Promise<void> {
  console.log("=== Heartbeat Component Tests ===\n");

  const sessionId = `test-session-${Date.now()}`;

  console.log("Test 1: System Event Queueing");
  try {
    const event1 = await queueSystemEvent({
      sessionId,
      kind: "exec.completion",
      payload: {
        text: 'Background process "curl https://api.example.com" completed with exit code 0.',
      },
      eventKey: `exec:${sessionId}`,
    });

    if (!event1) {
      console.log("✗ Event queue returned null (deduped or failed)");
    } else {
      console.log("✓ Event queued:", event1.id);

      const events = await peekSystemEvents(sessionId);
      console.log("✓ Events retrieved:", events.length);

      const stats = await getEventStats();
      console.log("✓ Event stats:", JSON.stringify(stats));

      const removed = await removeSystemEvent(sessionId, event1.id);
      console.log("✓ Event removed:", removed);
    }
  } catch (error) {
    console.log("✗ System Events test failed:", toMessage(error));
  }

  console.log("\nTest 2: Heartbeat Service Lifecycle");
  const heartbeatSessionId = `${sessionId}-heartbeat`;
  try {
    console.log("Starting heartbeat...");
    startHeartbeat({
      enabled: true,
      intervalMs: 5 * 60 * 1000,
      workspaceDir: process.cwd(),
      userId: "test-user",
      sessionId: heartbeatSessionId,
    });
    console.log("✓ Heartbeat started");

    const hbStats = getHeartbeatStats();
    console.log("✓ Active heartbeats:", hbStats.activeHeartbeats);

    console.log("Stopping heartbeat...");
    stopHeartbeat(heartbeatSessionId);
    console.log("✓ Heartbeat stopped");

    const hbStatsAfter = getHeartbeatStats();
    console.log("✓ Active heartbeats after stop:", hbStatsAfter.activeHeartbeats);
  } catch (error) {
    console.log("✗ Heartbeat service test failed:", toMessage(error));
  }

  console.log("\nTest 3: HEARTBEAT.md Template");
  try {
    const templatePath = join(process.cwd(), "workspace-templates", "HEARTBEAT.md");
    const template = await readFile(templatePath, "utf-8");
    console.log("✓ Template exists:", template.split("\n").length, "lines");
    console.log("  First line:", template.split("\n")[0]);
  } catch (error) {
    console.log("✗ Template not found:", toMessage(error));
  }

  console.log("\n=== All Component Tests Complete ===");
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Unexpected heartbeat smoke failure:", toMessage(error));
    process.exit(1);
  });
