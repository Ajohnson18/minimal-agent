import { Router, type Request, type Response } from "express";
import {
  isOnboarded,
  setOnboardingAnswer,
  getOnboardingAnswers,
  getOnboardingQuestions,
  setSetting,
  getSkillTreeNodes,
  updateSkillTreeNode,
  unlockBranchChildren,
  seedSelectedIntegrations,
} from "../../services/settings.service.js";
import { db } from "../../db/client.js";
import { avaSessions } from "../../db/schema/sessions.js";
import { sessionKeyResolverService } from "../../services/session-key-resolver.service.js";
import { queueService } from "../../gateway/services/queue.js";
import { requireHttpAuth } from "../../middlewares/auth.js";
import { createLogger } from "../../lib/logger.js";

export const setupRouter: ReturnType<typeof Router> = Router();
const log = createLogger("web", { route: "setup" });

// ── Status (public) ──────────────────────────────────────────

setupRouter.get("/setup/status", async (_req: Request, res: Response) => {
  try {
    const onboarded = await isOnboarded();
    return res.json({ onboarded });
  } catch (err) {
    log.error({ err }, "Error checking onboarding status");
    return res.json({ onboarded: false });
  }
});

// ── Onboarding answers ───────────────────────────────────────

setupRouter.put("/setup/questions/:key", async (req: Request, res: Response) => {
  const key = req.params.key as string;
  const { answer } = req.body;
  if (typeof answer !== "string") {
    return res.status(400).json({ error: "answer is required" });
  }
  try {
    const updated = await setOnboardingAnswer(key, answer);
    if (!updated) return res.status(404).json({ error: "Question not found" });
    return res.json({ saved: key });
  } catch (err) {
    log.error({ err, key }, "Error saving onboarding answer");
    return res.status(500).json({ error: "Failed to save answer" });
  }
});

// ── Skill Tree ───────────────────────────────────────────────

setupRouter.get("/setup/skill-tree", async (_req: Request, res: Response) => {
  try {
    const nodes = await getSkillTreeNodes();
    return res.json({ nodes });
  } catch (err) {
    log.error({ err }, "Error fetching skill tree");
    return res.status(500).json({ error: "Failed to fetch skill tree" });
  }
});

setupRouter.patch("/setup/skill-tree/:id", requireHttpAuth, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { status, setupTasks } = req.body;
  try {
    const updates: Record<string, unknown> = {};
    if (status) updates.status = status;
    if (setupTasks) updates.setupTasks = setupTasks;

    await updateSkillTreeNode(id, updates);

    // Activating brain → kick off async workspace write, return sessionKey for streaming
    if (id === "brain" && status === "active") {
      const userId = req.auth!.userId;
      const sessionKey = await startBrainWorkspace(userId);
      return res.json({ updated: id, sessionKey });
    }

    // Activating a branch → unlock its integration children
    if (id !== "brain" && status === "active") {
      await unlockBranchChildren(id);
    }

    return res.json({ updated: id });
  } catch (err) {
    log.error({ err, id }, "Error updating node");
    return res.status(500).json({ error: "Failed to update node" });
  }
});

// ── Helpers ──────────────────────────────────────────────────

/**
 * Creates a session, fires the workspace-writing agent run in the background,
 * and returns the sessionKey so the frontend can subscribe via WebSocket.
 */
async function startBrainWorkspace(userId: string): Promise<string> {
  const answers = await getOnboardingAnswers();

  const selectedTools: string[] = answers.team_tools ? JSON.parse(answers.team_tools) : [];
  await seedSelectedIntegrations(selectedTools);

  const [session] = await db
    .insert(avaSessions)
    .values({ userId, title: "Initial Setup", source: "setup", status: "active" })
    .returning();

  const identity = await sessionKeyResolverService.ensureBoundIdentity({
    sessionId: session.id,
    agentId: "main",
    scope: "web",
  });

  const questions = await getOnboardingQuestions();
  const contextLines = questions
    .filter((q) => answers[q.questionKey])
    .map((q) => `- ${q.label}: ${answers[q.questionKey]}`);

  const prompt = [
    "You are being initialized for the first time. Here is what the admin told you during setup:",
    "",
    ...contextLines,
    "",
    "Using this information, write your TEAM.md and IDENTITY.md workspace files now.",
    "Make them genuinely useful — capture the context in your own voice, not just fill-in-the-blank.",
    "Do not ask questions. Just write the files.",
  ].join("\n");

  // Enqueue in isolated mode — uses the same queue-processor pipeline
  // that handles runtime.broadcast natively (agent.chunk, agent.completed, etc.)
  await queueService.enqueue(session.id, userId, prompt, {
    source: "setup",
    mode: "isolated",
  });

  // Mark onboarded immediately — workspace files will be written by the queue run
  setSetting("onboarded", "true").catch((err) => log.error({ err }, "Failed to set onboarded"));

  return identity?.sessionKey ?? session.id;
}
