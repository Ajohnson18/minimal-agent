import { createServer } from "./api/server.js";
import { createGatewayServer } from "./gateway/index.js";
import {
  checkDatabaseConnection,
  closeDatabaseConnection,
  db,
  pool,
} from "./db/client.js";
import { env } from "./config/env.js";
import { getConfig } from "./lib/config-loader.js";
import { hookRegistry } from "./hooks/index.js";
import { startEventCleanup, stopEventCleanup } from "./services/event-cleanup.service.js";
import { dropExpiredSystemEvents } from "./gateway/services/system-events.js";
import { outboundDeliveryQueueService } from "./services/outbound-delivery-queue.service.js";
import {
  wakeOutboundPump,
  waitForOutboundPumpIdle,
} from "./gateway/services/outbound-delivery-pump.js";
import { waitForDispatchersIdle } from "./lib/slack/dispatcher-registry.js";
import {
  initRegistry,
  waitForRegistryReady,
} from "./agent/tools/subagent-registry.js";
import { runtime } from "./gateway/runtime.js";
import {
  isDockerAvailable,
  isSandboxExecImageBuilt,
  verifySandboxImageCapabilities,
} from "./sandbox/container-manager.js";
import { syncSkillTree } from "./services/skill-tree-sync.js";
import { createLogger } from "./lib/logger.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const log = createLogger("agent", { component: "startup" });

async function validateSandboxRuntime(): Promise<void> {
  const sandbox = getConfig().sandbox;
  if (sandbox.mode === "off") {
    return;
  }

  log.info(
    {
      mode: sandbox.mode,
      scope: sandbox.scope,
      image: sandbox.image,
      network: sandbox.network,
    },
    "Validating sandbox runtime",
  );

  const dockerReady = await isDockerAvailable();
  if (!dockerReady) {
    throw new Error(
      "Sandbox mode is enabled but Docker is unavailable. Disable sandbox or start Docker.",
    );
  }

  const imageReady = await isSandboxExecImageBuilt(sandbox.image);
  if (!imageReady) {
    throw new Error(
      `Sandbox image '${sandbox.image}' is missing. Build it before starting AVA.`,
    );
  }

  await verifySandboxImageCapabilities(sandbox.image);
  log.info({ image: sandbox.image }, "Sandbox image capability check passed");
}

async function main() {
  log.info("Starting AVA Agent Service...");
  log.info(`Environment: ${env.NODE_ENV}`);

  await validateSandboxRuntime();

  // Check database connection
  log.info("Checking database connection...");
  const dbConnected = await checkDatabaseConnection();
  if (!dbConnected) {
    log.error("Failed to connect to database. Exiting.");
    process.exit(1);
  }
  log.info("Database connection successful.");

  // Ensure pgvector extension exists before migrations
  log.info("Ensuring pgvector extension...");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  // Run migrations
  log.info("Running database migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  log.info("Database migrations complete.");

  await syncSkillTree();

  // Resume persisted subagent lifecycle state before accepting traffic.
  initRegistry();
  await waitForRegistryReady();

  // Startup hygiene for stale async artifacts.
  const droppedExpiredEvents = await dropExpiredSystemEvents();
  if (droppedExpiredEvents > 0) {
    log.info({ droppedExpiredEvents }, "Dropped expired system events on startup");
  }
  const recoveredOutboundJobs = await outboundDeliveryQueueService.recoverStuckJobs(
    `startup:${process.pid}`,
  );
  if (recoveredOutboundJobs > 0) {
    log.info({ recoveredOutboundJobs }, "Recovered stale outbound delivery jobs");
  }
  await outboundDeliveryQueueService.dropExpiredJobs();
  wakeOutboundPump("startup", 0);

  // Initialize hooks system
  log.info("Initializing hooks system...");
  await hookRegistry.initialize();

  // Start event cleanup scheduler
  log.info("Starting event cleanup scheduler...");
  startEventCleanup();

  // Create and start HTTP server
  const app = createServer();
  const serverCfg = getConfig().server;
  const server = app.listen(serverCfg.port, () => {
    log.info(`AVA HTTP API running on port ${serverCfg.port}`);
    log.info(`API prefix: ${serverCfg.apiPrefix}`);
  });

  // Create and start Gateway WebSocket server
  const gateway = createGatewayServer({
    port: serverCfg.gatewayPort,
    path: serverCfg.gatewayPath,
  });

  log.info(
    `AVA Gateway WebSocket running on port ${serverCfg.gatewayPort}${serverCfg.gatewayPath}`
  );

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`Received ${signal}. Shutting down gracefully...`);

    const forceTimer = setTimeout(() => {
      log.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10000);
    forceTimer.unref?.();

    // Stop event cleanup scheduler
    stopEventCleanup();

    // Drain outbound delivery and reply dispatch chains.
    const [dispatchersDrained, outboundDrained, runsDrained] = await Promise.all([
      waitForDispatchersIdle({ timeoutMs: 5000 }),
      waitForOutboundPumpIdle({ timeoutMs: 5000 }),
      runtime.waitForRunsIdle({ timeoutMs: 5000 }),
    ]);
    if (!dispatchersDrained) {
      log.warn("Timed out waiting for reply dispatchers to become idle");
    }
    if (!outboundDrained) {
      log.warn("Timed out waiting for outbound delivery pump to become idle");
    }
    if (!runsDrained) {
      log.warn("Timed out waiting for active gateway runs to become idle");
    }

    // Close gateway first
    await new Promise<void>((resolve) => {
      gateway.close(() => {
        log.info("Gateway WebSocket server closed.");
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      server.close(() => {
        log.info("HTTP server closed.");
        resolve();
      });
    });

    await closeDatabaseConnection();
    log.info("Database connection closed.");
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  log.error({ err: error }, "Fatal error");
  process.exit(1);
});
