import { runtime } from "../runtime.js";
import {
  executeAgentWithPi,
  type AgentEvent,
  resolveSandboxContext,
} from "../../agent/executor-pi.js";
import { getContextSummary } from "../../agent/compaction.js";
import { resolveUserContext } from "../../agent/user-context.js";
import { getAvailablePowers, getPowerById, deletePower, installCommunityPower, reloadPowers, getPowerVersions } from "../../powers/registry.js";
import { getWritablePowersDir } from "../../powers/config.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMUNITY_POWERS } from "../../powers/community-catalog.js";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import { getCatalogEntry } from "../../lib/tool-catalog.js";
import { getConfig } from "../../lib/config-loader.js";
import {
  SANDBOX_UNAVAILABLE_CODE,
  isSandboxUnavailableError,
} from "../../sandbox/errors.js";
import { resolveGatewaySessionIdentityForUser } from "../services/session-identity.js";
import { db } from "../../db/client.js";
import { kaiPowerRuns } from "../../db/schema/power-runs.js";
import { avaMessages } from "../../db/schema/messages.js";
import { eq, desc, asc, and } from "drizzle-orm";
import type {
  PowersListParams,
  PowersListResult,
  PowersGetDetailParams,
  PowersGetDetailResult,
  PowersExecuteParams,
  PowersExecuteResult,
  PowersCreateParams,
  PowersCreateResult,
  PowersUpdateParams,
  PowersUpdateResult,
  PowersDeleteParams,
  PowersDeleteResult,
  PowersInstallParams,
  PowersInstallResult,
  PowersCommunityParams,
  PowersCommunityResult,
  PowersRunsParams,
  PowersRunsResult,
  PowersCreateFromChatParams,
  PowersCreateFromChatResult,
} from "../protocol/methods.js";
import type {} from "../protocol/events.js";
import type { PowerDefinition } from "../../powers/types.js";
import { parseResponse } from "../../powers/response-parser.js";

function buildPromptFromPower(
  power: PowerDefinition,
  params: Record<string, string>,
): string {
  let prompt = power.prompt;

  for (const [key, value] of Object.entries(params)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }

  const outputType = power.output || "text";
  const sections: string[] = [
    `You are executing the **${power.name}** power (id: \`${power.id}\`).`,
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

  if (power.refinements) {
    sections.push(
      "",
      "---",
      "",
      "**Learnings from previous runs** (use these to do a better job):",
      "",
      power.refinements,
    );
  }

  if (power.artifacts && power.artifacts.length > 0) {
    sections.push(
      "",
      "---",
      "",
      "**Dashboard Artifacts:** You MUST call `pin_to_dashboard` for each of the following artifacts:",
      "",
    );
    for (const artifact of power.artifacts) {
      sections.push(`- key: \`${artifact.key}\`, label: "${artifact.label}", artifact_type: \`${artifact.type}\``);
    }
    sections.push(
      "",
      `Pass \`power_id\`: \`${power.id}\` and \`power_name\`: \`${power.name}\` for each call.`,
      "The `data` parameter must be a JSON string matching the schema for the artifact type.",
    );
  }

  sections.push(
    "",
    "---",
    "",
    "**IMPORTANT:** When you have completed this power, you MUST call the `power_result` tool to record your findings. Pass:",
    `- \`power_id\`: \`${power.id}\``,
    `- \`power_name\`: \`${power.name}\``,
    `- \`response_type\`: \`${outputType}\``,
    "- `content`: Your complete result as markdown",
    "- `title` and `summary` if the response_type is \"report\"",
    "",
    "Do NOT skip this step. The result will be lost if you don't call `power_result`.",
  );

  return sections.join("\n");
}

export async function powersList(
  _params: PowersListParams,
  _authUserId?: string,
): Promise<PowersListResult | RpcError> {
  try {
    const powers = await getAvailablePowers();
    return { powers };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list powers");
  }
}

export async function powersGetDetail(
  params: PowersGetDetailParams,
  _authUserId?: string,
): Promise<PowersGetDetailResult | RpcError> {
  const { powerId } = params;
  if (!powerId) {
    return createError(ErrorCodes.INVALID_PARAMS, "powerId is required");
  }

  const power = await getPowerById(powerId);
  if (!power) {
    return createError(ErrorCodes.NOT_FOUND, `Power "${powerId}" not found`);
  }

  const powers = await getAvailablePowers();
  const info = powers.find((p) => p.id === powerId);
  if (!info) {
    return createError(ErrorCodes.NOT_FOUND, `Power "${powerId}" not found`);
  }

  const versions = await getPowerVersions(powerId);

  return {
    power: {
      ...info,
      prompt: power.prompt,
      locked: power.locked,
    },
    versions,
  };
}

export async function powersExecute(
  params: PowersExecuteParams,
  authUserId?: string,
): Promise<PowersExecuteResult | RpcError> {
  const { powerId, sessionKey, params: powerParams = {} } = params;
  const userId = authUserId ?? "gateway-user";

  if (!powerId || !sessionKey) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "powerId and sessionKey are required",
    );
  }

  const power = await getPowerById(powerId);
  if (!power) {
    return createError(ErrorCodes.NOT_FOUND, `Power "${powerId}" not found`);
  }

  if (power.dependsOn && power.dependsOn.length > 0) {
    const userContext = await resolveUserContext("web", userId);
    const userKeys = new Set(
      (userContext.credentials?.custom ?? []).map((c) => c.key),
    );
    const missing: string[] = [];
    for (const integrationId of power.dependsOn) {
      const entry = getCatalogEntry(integrationId);
      const credKey = entry?.credentialKey ?? integrationId;
      if (!userKeys.has(credKey)) {
        missing.push(credKey);
      }
    }
    if (missing.length > 0) {
      return createError(
        ErrorCodes.INVALID_PARAMS,
        `Missing required credentials: ${missing.join(", ")}. Add them in Settings before running this power.`,
      );
    }
  }

  let sessionId: string | undefined;
  let resolvedSessionKey: string | undefined;
  if (authUserId) {
    const identity = await resolveGatewaySessionIdentityForUser({
      userId: authUserId,
      sessionKey,
    });
    if (!identity) {
      return createError(ErrorCodes.NOT_FOUND, `Session ${sessionKey} not found`);
    }
    sessionId = identity.sessionId;
    resolvedSessionKey = identity.sessionKey;
  }

  if (!sessionId || !resolvedSessionKey) {
    return createError(ErrorCodes.NOT_FOUND, "Session not found");
  }

  try {
    await resolveSandboxContext({ sessionId, userId, config: getConfig() });
  } catch (error) {
    if (isSandboxUnavailableError(error)) {
      return createError(ErrorCodes.SANDBOX_UNAVAILABLE, error.message, {
        code: SANDBOX_UNAVAILABLE_CODE,
      });
    }
    throw error;
  }

  const run = runtime.createRun(sessionId, userId);
  const prompt = buildPromptFromPower(power, powerParams);

  const powerRunId = crypto.randomUUID();
  try {
    await db.insert(kaiPowerRuns).values({
      id: powerRunId,
      powerId: powerId,
      powerName: power.name,
      runId: run.runId,
      sessionId,
      status: "running",
    });
  } catch {}

  executeAgentForPower(
    run.runId,
    sessionId,
    resolvedSessionKey,
    userId,
    prompt,
    powerRunId,
    power.output,
    powerId,
  );

  return {
    runId: run.runId,
    status: "accepted",
    acceptedAt: Date.now(),
  };
}

async function executeAgentForPower(
  runId: string,
  sessionId: string,
  sessionKey: string,
  userId: string,
  prompt: string,
  powerRunId?: string,
  outputHint?: string,
  powerId?: string,
): Promise<void> {
  const emitter = createPowerEventEmitter(runId, sessionId, sessionKey);
  try {
    runtime.updateRun(runId, { status: "running" });

    const contextSummary = await getContextSummary(sessionId);
    const run = runtime.getRun(runId);
    if (!run || run.status === "cancelled") return;

    const userContext = await resolveUserContext("web", userId);

    const result = await executeAgentWithPi({
      sessionId,
      userId,
      userContext,
      prompt,
      contextSummary: contextSummary || undefined,
      abortSignal: run.abortController?.signal,
      onEvent: (event: AgentEvent) => {
        emitter.handleEvent(event);
      },
    });

    const latestRun = runtime.getRun(runId);
    if (!latestRun || latestRun.status === "cancelled") return;

    runtime.updateRun(runId, {
      status: "completed",
      completedAt: Date.now(),
      content: result.content,
      usage: result.usage,
    });

    if (powerRunId) {
      try {
        const parsed = parseResponse(result.content, outputHint);
        await db.update(kaiPowerRuns).set({ status: "completed", completedAt: new Date(), result: parsed }).where(eq(kaiPowerRuns.id, powerRunId));
      } catch {}
    }

    if (powerId) {
      refinePowerAfterRun(powerId, sessionId, userId, result.content || "").catch(() => {});
    }

    emitter.emitFinal(result.content);
  } catch (error) {
    const latestRun = runtime.getRun(runId);
    if (latestRun?.status === "cancelled") return;

    const errorMessage =
      error instanceof Error ? error.message : String(error);

    runtime.updateRun(runId, {
      status: "error",
      completedAt: Date.now(),
      error: errorMessage,
    });

    if (powerRunId) {
      try {
        await db.update(kaiPowerRuns).set({ status: "error", completedAt: new Date(), error: errorMessage }).where(eq(kaiPowerRuns.id, powerRunId));
      } catch {}
    }

    emitter.emitError(errorMessage);
  }
}

function createPowerEventEmitter(runId: string, sessionId: string, sessionKey: string) {
  let chatSeq = 0;
  let agentSeq = 0;

  return {
    handleEvent(event: AgentEvent): void {
      switch (event.type) {
        case "thinking":
          agentSeq += 1;
          runtime.broadcast({
            event: "agent",
            payload: { runId, sessionKey, stream: "thinking", seq: agentSeq, ts: Date.now() },
          } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
          break;
        case "text_delta":
          if (event.text) {
            chatSeq += 1;
            runtime.broadcast({
              event: "chat",
              payload: { runId, sessionKey, seq: chatSeq, state: "delta" as const, message: [{ type: "text", text: event.text }] },
            } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
          }
          break;
        case "tool_call":
          if (event.call) {
            agentSeq += 1;
            runtime.broadcast({
              event: "agent",
              payload: {
                runId, sessionKey, stream: "tool", seq: agentSeq, ts: Date.now(),
                data: { phase: "call", toolName: event.call.name, args: event.call.args },
              },
            } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
          }
          break;
        case "tool_result":
          if (event.result) {
            agentSeq += 1;
            runtime.broadcast({
              event: "agent",
              payload: {
                runId, sessionKey, stream: "tool", seq: agentSeq, ts: Date.now(),
                data: { phase: "result", toolName: event.result.name, result: event.result.result },
              },
            } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
          }
          break;
      }
    },
    emitFinal(content: string) {
      chatSeq += 1;
      runtime.broadcast({
        event: "chat",
        payload: { runId, sessionKey, seq: chatSeq, state: "final" as const, message: [{ type: "text", text: content }] },
      } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
    },
    emitError(errorMessage: string) {
      chatSeq += 1;
      runtime.broadcast({
        event: "chat",
        payload: { runId, sessionKey, seq: chatSeq, state: "error" as const, errorMessage },
      } as unknown as Parameters<typeof runtime.broadcast>[0], sessionId);
    },
  };
}

export async function powersCreate(
  params: PowersCreateParams,
  _authUserId?: string,
): Promise<PowersCreateResult | RpcError> {
  const { name, description, icon, category, dependsOn, skills, tools, steps, output } = params;
  if (!name || !description) {
    return createError(ErrorCodes.INVALID_PARAMS, "name and description are required");
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (!id) {
    return createError(ErrorCodes.INVALID_PARAMS, "Invalid power name");
  }

  try {
    // Write the POWER.md file — source of truth
    const powersDir = getWritablePowersDir();
    const dir = join(powersDir, id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const fm: string[] = ["---"];
    fm.push(`id: ${id}`);
    fm.push(`name: ${name}`);
    fm.push(`description: ${description}`);
    if (icon) fm.push(`icon: ${icon}`);
    if (category) fm.push(`category: ${category}`);
    if (dependsOn?.length) fm.push(`integrations: ${dependsOn.join(", ")}`);
    if (skills?.length) fm.push(`skills: ${skills.join(", ")}`);
    if (tools?.length) fm.push(`tools: ${tools.join(", ")}`);
    if (output) fm.push(`output: ${output}`);
    if (steps?.length) {
      fm.push("steps:");
      for (const s of steps) fm.push(`  - ${s}`);
    }
    fm.push("---");

    const promptBody = (steps || []).map((s, i) => `## Step ${i + 1}: ${s}\n\n(instructions here)`).join("\n\n");
    writeFileSync(join(dir, "POWER.md"), `${fm.join("\n")}\n\n${promptBody}\n`, "utf-8");

    reloadPowers();
    const powers = await getAvailablePowers();
    const power = powers.find((p) => p.id === id);
    if (!power) {
      return createError(ErrorCodes.INTERNAL_ERROR, "Power file written but not discovered");
    }
    return { power };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createError(ErrorCodes.INTERNAL_ERROR, `Failed to create power: ${msg}`);
  }
}

export async function powersUpdate(
  params: PowersUpdateParams,
  _authUserId?: string,
): Promise<PowersUpdateResult | RpcError> {
  const { powerId, ...updates } = params;
  if (!powerId) {
    return createError(ErrorCodes.INVALID_PARAMS, "powerId is required");
  }

  const existing = await getPowerById(powerId);
  if (!existing) {
    return createError(ErrorCodes.NOT_FOUND, `Power "${powerId}" not found`);
  }

  try {
    // Rewrite the POWER.md with merged fields
    if (existing.filePath && existsSync(existing.filePath)) {
      const content = readFileSync(existing.filePath, "utf-8");
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const oldBody = content.slice(fmMatch[0].length).trim();
        const newBody = updates.prompt ?? oldBody;
        // Rebuild frontmatter with merged values
        const fm: string[] = ["---"];
        fm.push(`id: ${existing.id}`);
        fm.push(`name: ${updates.name ?? existing.name}`);
        fm.push(`description: ${updates.description ?? existing.description}`);
        fm.push(`icon: ${updates.icon ?? existing.icon}`);
        fm.push(`category: ${updates.category ?? existing.category}`);
        const deps = updates.dependsOn ?? existing.dependsOn;
        if (deps.length) fm.push(`integrations: ${deps.join(", ")}`);
        const sk = updates.skills ?? existing.skills;
        if (sk.length) fm.push(`skills: ${sk.join(", ")}`);
        const tl = updates.tools ?? existing.tools;
        if (tl.length) fm.push(`tools: ${tl.join(", ")}`);
        const out = updates.output ?? existing.output;
        if (out) fm.push(`output: ${out}`);
        const st = updates.steps ?? existing.steps;
        if (st.length) {
          fm.push("steps:");
          for (const s of st) fm.push(`  - ${s}`);
        }
        const ar = updates.artifacts ?? existing.artifacts;
        if (ar.length) {
          fm.push("artifacts:");
          for (const a of ar) {
            fm.push(`  - key: ${a.key}`);
            fm.push(`    label: ${a.label}`);
            fm.push(`    type: ${a.type}`);
          }
        }
        fm.push("---");
        writeFileSync(existing.filePath, `${fm.join("\n")}\n\n${newBody}\n`, "utf-8");
      }
    }

    reloadPowers();
    const powers = await getAvailablePowers();
    const powerInfo = powers.find((p) => p.id === powerId);
    if (!powerInfo) {
      return createError(ErrorCodes.INTERNAL_ERROR, "Power updated but not found in list");
    }
    return { power: powerInfo };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to update power");
  }
}

export async function powersDelete(
  params: PowersDeleteParams,
  _authUserId?: string,
): Promise<PowersDeleteResult | RpcError> {
  const { powerId } = params;
  if (!powerId) {
    return createError(ErrorCodes.INVALID_PARAMS, "powerId is required");
  }

  try {
    const deleted = await deletePower(powerId);
    if (!deleted) {
      return createError(ErrorCodes.NOT_FOUND, `Power "${powerId}" not found`);
    }
    return { deleted: true };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to delete power");
  }
}

export async function powersInstall(
  params: PowersInstallParams,
  _authUserId?: string,
): Promise<PowersInstallResult | RpcError> {
  const { powerId } = params;
  if (!powerId) {
    return createError(ErrorCodes.INVALID_PARAMS, "powerId is required");
  }

  const catalogPower = COMMUNITY_POWERS.find((p) => p.id === powerId);
  if (!catalogPower) {
    return createError(ErrorCodes.NOT_FOUND, `Community power "${powerId}" not found`);
  }

  try {
    const power = await installCommunityPower(catalogPower);
    return { power };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to install power");
  }
}

export async function powersCommunity(
  _params: PowersCommunityParams,
  _authUserId?: string,
): Promise<PowersCommunityResult | RpcError> {
  try {
    const installed = await getAvailablePowers();
    const installedIds = new Set(installed.map((p) => p.id));

    return {
      powers: COMMUNITY_POWERS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        icon: p.icon,
        category: p.category,
        dependsOn: p.dependsOn,
        steps: p.steps,
        installed: installedIds.has(p.id),
      })),
    };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list community powers");
  }
}

export async function powersRuns(
  params: PowersRunsParams,
  _authUserId?: string,
): Promise<PowersRunsResult | RpcError> {
  const limit = Math.min(params.limit ?? 20, 50);
  try {
    let query = db.select().from(kaiPowerRuns).orderBy(desc(kaiPowerRuns.startedAt)).limit(limit);
    if (params.powerId) {
      query = query.where(eq(kaiPowerRuns.powerId, params.powerId)) as typeof query;
    }
    const rows = await query;
    return {
      runs: rows.map((r) => ({
        id: r.id,
        powerId: r.powerId,
        powerName: r.powerName,
        runId: r.runId,
        status: r.status,
        startedAt: r.startedAt.getTime(),
        completedAt: r.completedAt?.getTime() ?? null,
        error: r.error,
        result: r.result ?? null,
      })),
    };
  } catch {
    return createError(ErrorCodes.INTERNAL_ERROR, "Failed to list power runs");
  }
}

async function refinePowerAfterRun(
  powerId: string,
  sessionId: string,
  userId: string,
  runOutput: string,
): Promise<void> {
  const power = await getPowerById(powerId);
  if (!power) return;
  if (power.locked) return;
  if (!power.filePath) return;

  // Snapshot current version before any rewrite
  try {
    const { kaiPowerVersions } = await import("../../db/schema/power-versions.js");
    await db.insert(kaiPowerVersions).values({
      id: crypto.randomUUID(),
      powerId,
      prompt: power.prompt,
      changeNote: "Before auto-rewrite",
    });
  } catch {}

  const outputSnippet = runOutput.slice(0, 6000);

  const refinementMessage =
    `You just finished running the "${power.name}" power (id: ${power.id}). ` +
    `Review the run output below and improve the POWER.md so the next run works better.\n\n` +
    `**Power file:** ${power.filePath}\n\n` +
    `**Run output (truncated):**\n\`\`\`\n${outputSnippet}\n\`\`\`\n\n` +
    `**Instructions:**\n` +
    `1. Read the current POWER.md at the path above\n` +
    `2. Identify what went wrong, what was inefficient, or what could be more specific\n` +
    `3. Rewrite the prompt body (below the \`---\` frontmatter) to fix those issues\n` +
    `4. Keep the same frontmatter (id, name, steps, artifacts) — only improve the instructions\n` +
    `5. Preserve any {{variable}} placeholders exactly\n` +
    `6. Write the updated file using the write tool\n` +
    `7. Call manage_power(action: "reload") to pick up changes\n\n` +
    `If the run was perfect and nothing needs improving, say so and skip the rewrite.`;

  try {
    await executeAgentWithPi({
      sessionId,
      userId,
      prompt: refinementMessage,
    });
  } catch {}
}

export async function powersCreateFromChat(
  params: PowersCreateFromChatParams,
  authUserId?: string,
): Promise<PowersCreateFromChatResult | RpcError> {
  const userId = authUserId ?? "gateway-user";
  const { sessionKey } = params;

  if (!sessionKey) {
    return createError(ErrorCodes.INVALID_PARAMS, "sessionKey is required");
  }

  const identity = await resolveGatewaySessionIdentityForUser({ userId, sessionKey });
  if (!identity) {
    return createError(ErrorCodes.NOT_FOUND, "Session not found");
  }

  const messages = await db
    .select({
      role: avaMessages.role,
      content: avaMessages.content,
      toolCalls: avaMessages.toolCalls,
      name: avaMessages.name,
    })
    .from(avaMessages)
    .where(and(eq(avaMessages.sessionId, identity.sessionId), eq(avaMessages.isCompacted, false)))
    .orderBy(asc(avaMessages.createdAt));

  if (messages.length === 0) {
    return createError(ErrorCodes.INVALID_PARAMS, "Session has no messages");
  }

  const toolNames = new Set<string>();
  const condensed: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const prefix = msg.role === "user" ? "USER" : "ASSISTANT";
      const text = (msg.content ?? "").slice(0, 600);
      if (text.trim()) condensed.push(`${prefix}: ${text}`);
    }

    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls as Array<{ type: string; function?: { name: string } }>) {
        if (tc.function?.name) toolNames.add(tc.function.name);
      }
    }

    if (msg.role === "tool" && msg.name) {
      toolNames.add(msg.name);
    }
  }

  const conversationText = condensed.join("\n");
  const toolList = Array.from(toolNames).join(", ");

  const analysisPrompt = `Analyze this conversation and extract a reusable power definition. A "power" is an automated workflow that can be re-run.

CONVERSATION:
${conversationText}

TOOLS USED: ${toolList || "none"}

Respond with ONLY valid JSON (no markdown fences):
{
  "name": "short descriptive name (2-5 words)",
  "description": "1-2 sentence description of what this power does",
  "category": "one of: general, security, quality, ops, analysis",
  "skills": ["skill ids used, e.g. coding-agent, summarize — omit if none"],
  "tools": ["tool names used, e.g. exec, read, web_search"],
  "dependsOn": ["integration ids required, e.g. github, slack — omit if none"],
  "steps": ["step 1 description", "step 2 description", "..."],
  "output": "one of: text, report, code, pr, table, links"
}

Rules:
- name should capture the core task, not reference the conversation
- steps should be generalized (not referencing specific files/URLs from the conversation)
- only include integrations that are actually needed
- skills array should only contain skill names if the conversation used skills from the skills/ directory
- choose the output type that best matches what the conversation produced`;

  try {
    const result = await executeAgentWithPi({
      sessionId: identity.sessionId,
      userId,
      prompt: analysisPrompt,
      skipHistory: true,
    });

    const text = result.content?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createError(ErrorCodes.INTERNAL_ERROR, "Failed to analyze conversation");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      name: string;
      description: string;
      category?: string;
      skills?: string[];
      tools?: string[];
      dependsOn?: string[];
      steps?: string[];
      output?: string;
    };

    if (!parsed.name || !parsed.description) {
      return createError(ErrorCodes.INTERNAL_ERROR, "AI produced incomplete power definition");
    }

    const id = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!id) {
      return createError(ErrorCodes.INTERNAL_ERROR, "Could not derive power id from name");
    }

    // Write POWER.md file
    const powersDir = getWritablePowersDir();
    const dir = join(powersDir, id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const pSteps = parsed.steps || [];
    const pTools = parsed.tools || Array.from(toolNames);
    const fm: string[] = ["---"];
    fm.push(`id: ${id}`);
    fm.push(`name: ${parsed.name}`);
    fm.push(`description: ${parsed.description}`);
    fm.push(`icon: ⚡`);
    fm.push(`category: ${parsed.category || "general"}`);
    if (parsed.dependsOn?.length) fm.push(`integrations: ${parsed.dependsOn.join(", ")}`);
    if (pTools.length) fm.push(`tools: ${pTools.join(", ")}`);
    if (parsed.output) fm.push(`output: ${parsed.output}`);
    if (pSteps.length) {
      fm.push("steps:");
      for (const s of pSteps) fm.push(`  - ${s}`);
    }
    fm.push("---");
    const promptBody = pSteps.map((s, i) => `## Step ${i + 1}: ${s}`).join("\n\n");
    writeFileSync(join(dir, "POWER.md"), `${fm.join("\n")}\n\n${promptBody}\n`, "utf-8");

    reloadPowers();
    const powers = await getAvailablePowers();
    const power = powers.find((p) => p.id === id);
    if (!power) {
      return createError(ErrorCodes.INTERNAL_ERROR, "Power created but not discovered");
    }
    return { power };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createError(ErrorCodes.INTERNAL_ERROR, `Failed to create power from chat: ${msg}`);
  }
}
