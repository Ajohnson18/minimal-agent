import { Router, type Request, type Response } from "express";
import { getAvailablePowers, getPowerById } from "../../powers/registry.js";
import { executeAgentWithPi, type AgentEvent } from "../../agent/executor-pi.js";
import { resolveUserContext } from "../../agent/user-context.js";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { sessionKeyResolverService } from "../../services/session-key-resolver.service.js";
import { createLogger } from "../../lib/logger.js";
import type { PowerDefinition } from "../../powers/types.js";

export const powersRouter: ReturnType<typeof Router> = Router();
const log = createLogger("web", { route: "powers" });

function buildPromptFromPower(
  power: PowerDefinition,
  params: Record<string, string>,
): string {
  let prompt = power.prompt;
  for (const [key, value] of Object.entries(params)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  const sections: string[] = [
    `You are executing the **${power.name}** power.`,
    "",
  ];
  if (power.skills.length > 0) {
    sections.push(`**Required skills:** ${power.skills.join(", ")}`);
  }
  if (power.tools.length > 0) {
    sections.push(`**Use these tools:** ${power.tools.join(", ")}`);
  }
  if (power.output) {
    sections.push(`**Expected output:** ${power.output}`);
  }
  sections.push("", prompt);
  return sections.join("\n");
}

function requireAuthenticatedUserId(req: Request, res: Response): string | null {
  const userId = req.auth?.userId?.trim();
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

powersRouter.get("/", async (req: Request, res: Response) => {
  const userId = requireAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const powers = await getAvailablePowers();
    return res.json({ powers });
  } catch (error) {
    log.error({ err: error }, "Failed to list powers");
    return res.status(500).json({ error: "Failed to list powers" });
  }
});

powersRouter.post("/:id/execute", async (req: Request, res: Response) => {
  const userId = requireAuthenticatedUserId(req, res);
  if (!userId) return;

  const id = req.params.id as string;
  const params = (req.body?.params as Record<string, string>) || {};

  const power = await getPowerById(id);
  if (!power) {
    return res.status(404).json({ error: `Power "${id}" not found` });
  }

  const prompt = buildPromptFromPower(power, params);

  try {
    const [session] = await db
      .insert(avaSessions)
      .values({
        userId,
        title: `Power: ${power.name}`,
        status: "active",
      })
      .returning();

    await sessionKeyResolverService.ensureBoundIdentity({
      sessionId: session.id,
      agentId: "main",
      scope: "web",
    });

    const userContext = await resolveUserContext("web", userId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    let clientDisconnected = false;
    res.on("close", () => {
      clientDisconnected = true;
    });

    const handleEvent = (event: AgentEvent) => {
      if (clientDisconnected || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        clientDisconnected = true;
      }
    };

    const result = await executeAgentWithPi({
      sessionId: session.id,
      userId,
      userContext,
      prompt,
      onEvent: handleEvent,
    });

    if (!clientDisconnected && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          session_id: session.id,
          content: result.content,
          usage: result.usage,
        })}\n\n`,
      );
    }
  } catch (error) {
    log.error({ err: error, powerId: id }, "Power execution error");
    if (!res.headersSent) {
      return res.status(500).json({ error: "Power execution failed" });
    }
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Power execution failed",
        })}\n\n`,
      );
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
});
