/**
 * Slack Events Router
 *
 * Ingress shim only:
 * - signature verification/challenge handling
 * - immediate Slack ACK responses
 * - forwarding payloads into monitor provider
 */
import { Router, type Request, type Response } from "express";
import {
  handleSlackChallenge,
  verifySlackSignature,
} from "../../middlewares/slack.js";
import { createLogger } from "../../lib/logger.js";
import {
  getSlackMonitorProvider,
} from "../../slack/monitor/provider.js";
import type {
  SlackEventEnvelope,
  SlackInteractionPayload,
} from "../../slack/types.js";

export const slackRouter: ReturnType<typeof Router> = Router();

const log = createLogger("slack", { component: "slack-router" });
const monitor = getSlackMonitorProvider();

/**
 * POST /api/ava/slack/events
 */
slackRouter.post(
  "/events",
  verifySlackSignature,
  handleSlackChallenge,
  async (req: Request, res: Response) => {
    const body = req.body as SlackEventEnvelope;

    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as { type?: string }).type === "url_verification"
    ) {
      return res.json({ challenge: (body as { challenge?: string }).challenge });
    }

    res.status(200).send("OK");

    void monitor.handleEvent(body).catch((error) => {
      log.warn({ err: error }, "Slack event processing failed");
    });
  },
);

/**
 * POST /api/ava/slack/interactions
 */
slackRouter.post(
  "/interactions",
  verifySlackSignature,
  async (req: Request, res: Response) => {
    const payloadRaw =
      typeof req.body?.payload === "string" ? req.body.payload : null;
    if (!payloadRaw) {
      res.status(400).send("Missing payload");
      return;
    }

    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(payloadRaw) as SlackInteractionPayload;
    } catch {
      res.status(400).send("Invalid payload");
      return;
    }

    res.status(200).send("OK");

    void monitor.handleInteraction(payload).catch((error) => {
      log.warn({ err: error }, "Slack interaction processing failed");
    });
  },
);

/**
 * POST /api/ava/slack/commands
 */
slackRouter.post(
  "/commands",
  verifySlackSignature,
  async (req: Request, res: Response) => {
    res.status(200).json({ response_type: "ephemeral", text: "Processing..." });

    void monitor
      .handleCommand(req.body)
      .catch((error) => log.warn({ err: error }, "Slack command processing failed"));
  },
);

/**
 * GET /api/ava/slack/health
 */
slackRouter.get("/health", (_req: Request, res: Response) => {
  const hasToken = !!process.env.SLACK_BOT_TOKEN;
  const hasSecret = !!process.env.SLACK_SIGNING_SECRET;

  res.json({
    status: hasToken && hasSecret ? "configured" : "not_configured",
    hasToken,
    hasSecret,
    hasAppToken: !!process.env.SLACK_APP_TOKEN,
  });
});
