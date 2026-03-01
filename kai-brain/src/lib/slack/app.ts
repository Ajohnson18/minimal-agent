/**
 * Slack App singleton
 * Adapted from somethings-api/src/lib/slack/bolt-app.ts
 */
import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";

let slackApp: App | null = null;
let webClient: WebClient | null = null;

export function getSlackApp(): App {
  if (!slackApp) {
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
      throw new Error("SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be set");
    }

    slackApp = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: !!process.env.SLACK_APP_TOKEN,
      logLevel: LogLevel.INFO,
    });
  }

  return slackApp;
}

/**
 * Get the Slack WebClient for direct API calls.
 */
export function getSlackClient(): WebClient {
  if (!webClient) {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error("SLACK_BOT_TOKEN must be set");
    }
    webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return webClient;
}

/**
 * Lazy-initialized Slack client for convenience.
 * Use this for quick access, but handle errors if Slack isn't configured.
 */
export const slackClient = {
  chat: {
    postMessage: async (params: {
      channel: string;
      thread_ts?: string;
      text: string;
    }) => {
      return getSlackClient().chat.postMessage(params);
    },
  },
};

/**
 * Check if Slack is configured
 */
export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
}
