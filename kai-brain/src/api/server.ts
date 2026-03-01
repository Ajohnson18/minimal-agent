import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import { getConfig } from "../lib/config-loader.js";
import { chatRouter } from "./routes/chat.js";
import { sessionsRouter } from "./routes/sessions.js";
import { credentialsRouter } from "./routes/credentials.js";
import { setupRouter } from "./routes/setup.js";
import { healthRouter } from "./routes/health.js";
import { powersRouter } from "./routes/powers.js";
import { memoriesRouter } from "./routes/memories.js";
import { slackRouter } from "./routes/slack.js";
import { isSlackConfigured } from "../lib/slack/app.js";
import { requireHttpAuth } from "../middlewares/auth.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("web", { component: "api-server" });

export function createServer(): Express {
  const app = express();

  // CORS middleware (before body parsing)
  app.use(
    cors({
      origin: getConfig().server.allowedOrigins,
      credentials: true,
    }),
  );

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Skip health check
    if (req.path === "/health") {
      next();
      return;
    }
    log.debug({ method: req.method, path: req.path }, "Incoming request");
    next();
  });

  // @todo - Future enhancement: Find better, more readable way to do this
  // Slack route with raw body capture (must be before express.json())
  // Slack signature verification requires the raw body
  // Handles both JSON (events) and urlencoded (slash commands)
  app.use(
    `${getConfig().server.apiPrefix}/slack`,
    express.raw({
      type: ["application/json", "application/x-www-form-urlencoded"],
    }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        req.rawBody = req.body.toString("utf-8");
        const contentType = req.headers["content-type"] || "";
        if (contentType.includes("application/json")) {
          try {
            req.body = JSON.parse(req.rawBody);
          } catch {
            // Keep raw body if JSON parsing fails
          }
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          // Parse urlencoded body (slash commands)
          const params = new URLSearchParams(req.rawBody);
          req.body = Object.fromEntries(params.entries());
        }
      }
      next();
    },
    slackRouter,
  );

  // JSON parsing for other routes
  app.use(express.json({ limit: "10mb" }));

  // Routes
  app.use("/health", healthRouter);

  const apiPrefix = getConfig().server.apiPrefix;

  app.use(`${apiPrefix}/health`, healthRouter);

  // Setup routes — /setup/status is public, rest requires JWT
  app.use(`${apiPrefix}`, setupRouter);

  app.use(`${apiPrefix}/chat`, requireHttpAuth, chatRouter);
  app.use(`${apiPrefix}/powers`, requireHttpAuth, powersRouter);
  app.use(`${apiPrefix}/memories`, requireHttpAuth, memoriesRouter);
  app.use(`${apiPrefix}/sessions`, requireHttpAuth, sessionsRouter);
  app.use(`${apiPrefix}`, requireHttpAuth, credentialsRouter);

  // Log Slack configuration status
  if (isSlackConfigured()) {
    // Slack router is already mounted above, if configured
    log.info({ path: `${apiPrefix}/slack/events` }, "Slack integration enabled");
  } else {
    log.warn(
      "Slack integration not configured (missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET)",
    );
  }

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, "Unhandled API error");
    res.status(500).json({
      error: process.env.NODE_ENV === "development" ? err.message : "Internal server error",
    });
  });

  return app;
}
