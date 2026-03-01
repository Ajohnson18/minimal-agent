import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/index.js";
import { getConfig } from "../../lib/config-loader.js";
import type { SlackSlashCommandPayload } from "../types.js";
import { handleSlackMessage } from "./runtime.js";

async function respondEphemeral(responseUrl: string | undefined, message: string): Promise<void> {
  if (!responseUrl) {
    return;
  }
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text: message }),
    });
  } catch {
    // Non-fatal: Slack already got immediate 200 from command route.
  }
}

export async function handleSlackCommand(
  body: SlackSlashCommandPayload,
): Promise<void> {
  const { text, user_id: userId, response_url: responseUrl, channel_id: channelId } = body;

  const subcommand = (text || "").trim().toLowerCase();
  const parts = subcommand.split(/\s+/);
  const action = parts[0];
  const arg = parts.slice(1).join(" ");

  if (!userId) {
    await respondEphemeral(responseUrl, "Missing Slack user id.");
    return;
  }

  switch (action) {
    case "think": {
      const level = arg || "high";
      const valid = ["off", "minimal", "low", "medium", "high"];
      if (!valid.includes(level)) {
        await respondEphemeral(responseUrl, `Invalid level. Valid: ${valid.join(", ")}`);
        return;
      }
      const sessions = await db
        .select()
        .from(avaSessions)
        .where(eq(avaSessions.userId, userId))
        .orderBy(avaSessions.lastMessageAt)
        .limit(1);
      if (sessions.length > 0) {
        const metadata = (sessions[0].metadata || {}) as Record<string, unknown>;
        metadata.thinkingLevel = level;
        await db.update(avaSessions).set({ metadata }).where(eq(avaSessions.id, sessions[0].id));
        await respondEphemeral(responseUrl, `Thinking level set to: *${level}*`);
      } else {
        await respondEphemeral(responseUrl, "No active session.");
      }
      return;
    }

    case "model": {
      if (!arg) {
        await respondEphemeral(
          responseUrl,
          "Usage: `/ava model <model-id>`. Example: `/ava model gemini-2.5-pro`",
        );
        return;
      }
      const sessions = await db
        .select()
        .from(avaSessions)
        .where(eq(avaSessions.userId, userId))
        .orderBy(avaSessions.lastMessageAt)
        .limit(1);
      if (sessions.length > 0) {
        const metadata = (sessions[0].metadata || {}) as Record<string, unknown>;
        metadata.modelOverride = arg;
        await db.update(avaSessions).set({ metadata }).where(eq(avaSessions.id, sessions[0].id));
        await respondEphemeral(responseUrl, `Model set to *${arg}* for current session.`);
      } else {
        await respondEphemeral(responseUrl, "No active session.");
      }
      return;
    }

    case "status": {
      const sessions = await db
        .select()
        .from(avaSessions)
        .where(eq(avaSessions.userId, userId))
        .orderBy(avaSessions.lastMessageAt)
        .limit(1);
      if (sessions.length > 0) {
        const session = sessions[0];
        const meta = (session.metadata || {}) as Record<string, unknown>;
        await respondEphemeral(
          responseUrl,
          [
            `*Session:* \`${session.id}\``,
            `*Model:* ${(meta.modelOverride as string) || getConfig().agent.model.primary || "default"}`,
            `*Thinking:* ${(meta.thinkingLevel as string) || "off"}`,
            `*Tokens:* ${session.tokenCount}`,
            `*Created:* ${session.createdAt?.toISOString()}`,
            `*Last active:* ${session.lastMessageAt?.toISOString() || "never"}`,
          ].join("\n"),
        );
      } else {
        await respondEphemeral(responseUrl, "No active session.");
      }
      return;
    }

    case "new":
    case "reset": {
      await respondEphemeral(responseUrl, "Session reset. Start a new conversation by mentioning @Kai.");
      return;
    }

    case "stop": {
      await respondEphemeral(responseUrl, "Use `/stop` in the thread to abort an active run.");
      return;
    }

    case "verbose": {
      await respondEphemeral(
        responseUrl,
        "Use `/verbose on` or `/verbose off` in the thread to toggle streaming.",
      );
      return;
    }

    case "help":
    case "": {
      await respondEphemeral(
        responseUrl,
        [
          "*Kai Slash Commands:*",
          "• `/ava status` — Current session info",
          "• `/ava think <off|minimal|low|medium|high>` — Set thinking level",
          "• `/ava model <model-id>` — Change model for this session",
          "• `/ava new` — Reset session",
          "• `/ava help` — Show this help",
          "",
          "*In-thread commands:*",
          "• `/stop` — Abort current run",
          "• `/verbose on|off` — Toggle streaming",
          "• `/compact` — Compress conversation history",
          "• `/model <name>` — Switch model",
          "• `/queue` / `/queue clear` — Queue management",
          "• `/bash <cmd>` — Run shell command (if enabled)",
        ].join("\n"),
      );
      return;
    }

    default: {
      if (channelId) {
        await handleSlackMessage(
          channelId,
          channelId,
          userId,
          text || "",
          Date.now().toString(),
          "",
        );
        await respondEphemeral(responseUrl, "Processing your request...");
        return;
      }
      await respondEphemeral(responseUrl, "Unknown command. Try `/ava help` for available commands.");
    }
  }
}
