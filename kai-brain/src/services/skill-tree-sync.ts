import { db } from "../db/client.js";
import { kaiSkillTreeNodes } from "../db/schema/settings.js";
import { getBuiltInTools, createCustomTools } from "../agent/pi-converter.js";
import { getSkills } from "../skills/watcher.js";
import { executeAgentWithPi } from "../agent/executor-pi.js";
import { avaSessions } from "../db/schema/sessions.js";
import { sessionKeyResolverService } from "../services/session-key-resolver.service.js";
import { createLogger } from "../lib/logger.js";
import { getSelectedToolIds } from "./settings.service.js";

const log = createLogger("agent", { component: "skill-tree-sync" });

export async function syncSkillTree() {
  const existing = await db.select({ id: kaiSkillTreeNodes.id }).from(kaiSkillTreeNodes);
  const existingIds = new Set(existing.map((n) => n.id));

  const builtInTools = getBuiltInTools();
  const customTools = createCustomTools({ userId: "sync", sessionId: "sync" });
  const { skills } = await getSkills();

  const capabilities: string[] = [];

  for (const t of builtInTools) {
    if (!existingIds.has(`tool:${t.name}`))
      capabilities.push(`tool:${t.name} — ${(t as { description?: string }).description || t.name}`);
  }
  for (const t of customTools) {
    if (!existingIds.has(`tool:${t.name}`))
      capabilities.push(`tool:${t.name} — ${t.description || t.name}`);
  }
  for (const s of skills) {
    if (!existingIds.has(`skill:${s.name}`))
      capabilities.push(`skill:${s.name} — ${s.description || s.name}`);
  }

  if (capabilities.length === 0) {
    log.info("Skill tree in sync — no new capabilities to add");
    return;
  }

  log.info({ count: capabilities.length }, "New capabilities found — asking AI to categorize");

  const [session] = await db
    .insert(avaSessions)
    .values({ userId: "system", title: "Skill Tree Sync", source: "setup", status: "active" })
    .returning();

  await sessionKeyResolverService.ensureBoundIdentity({
    sessionId: session.id,
    agentId: "main",
    scope: "web",
  });

  const capList = capabilities.join("\n");

  const prompt = `You are populating the skill tree UI. There are 4 branches: "engineering", "design", "product", "general". And 3 node types: "tool", "skill", "integration".

DEFINITIONS:
- tool: a built-in agent capability (exec, read, write, python_exec, etc.)
- skill: a higher-level learned workflow from the skills/ directory (summarize, coding-agent, etc.)
- integration: ANY external 3rd-party service that requires an API key to function. An integration is NOT a tool — it is a service the tools/skills connect to.

Here are NEW capabilities to categorize:
${capList}

For each capability:
1. Assign type "tool" or "skill" (items prefixed "tool:" are tools, "skill:" are skills)
2. Assign exactly ONE branch
3. If the tool/skill REQUIRES an external API key to work, set "requires_integration" to the integration id
4. If the tool/skill works without any API key, set "requires_integration" to null

Also identify all INTEGRATIONS — external services that need API keys. Look at the tools/skills to determine what integrations are needed. An integration is anything that needs a credential to connect: GitHub (needs PAT), Slack (needs bot token), Notion (needs API key), Linear, Figma, OpenAI, Anthropic, Exa, ElevenLabs, external databases, etc.

Respond with ONLY valid JSON, no markdown:
{
  "nodes": [
    {"id": "tool:exec", "label": "Shell", "description": "Run shell commands", "type": "tool", "branch": "engineering", "requires_integration": null},
    {"id": "tool:web_search", "label": "Web Search", "description": "Search the web", "type": "tool", "branch": "product", "requires_integration": "exa"},
    {"id": "skill:coding-agent", "label": "Coding Agent", "description": "Autonomous coding", "type": "skill", "branch": "engineering", "requires_integration": "github"}
  ],
  "integrations": [
    {"id": "github", "label": "GitHub", "description": "Repository access, PRs, issues", "branch": "engineering", "credential_key": "github_token", "logo_char": "GH"},
    {"id": "exa", "label": "Exa", "description": "Web search API", "branch": "product", "credential_key": "exa_api_key", "logo_char": "Ex"}
  ]
}

Branches:
- general: core/general purpose (memory, time, session info, user management)
- engineering: code, files, shell, databases, CI/CD, testing, deployment
- design: UI, visual, screenshots, Figma, browser automation
- product: communication, search, research, project management, docs, scheduling

Rules:
- Each node gets exactly ONE branch
- requires_integration must reference an integration id from the integrations array, or null
- Tools/skills that require an integration should have status "locked" until that integration is connected
- Tools/skills that need no API key should have status "active"
- logo_char: 1-2 chars for the integration icon
- Do NOT include integrations that none of your tools/skills actually use`;

  try {
    const result = await executeAgentWithPi({
      sessionId: session.id,
      userId: "system",
      prompt,
      skipHistory: true,
    });

    const text = result.content?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ response: text.slice(0, 300) }, "AI response did not contain valid JSON — skipping sync");
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      nodes: Array<{ id: string; label: string; description: string; type: "tool" | "skill"; branch: string; requires_integration: string | null }>;
      integrations: Array<{ id: string; label: string; description: string; branch: string; credential_key: string; logo_char?: string }>;
    };

    const toInsert: Array<typeof kaiSkillTreeNodes.$inferInsert> = [];

    // Resolve which integrations are allowed:
    // 1. User-selected tools from onboarding
    // 2. Base integrations required by built-in tools
    // 3. Already-existing integrations in the DB
    const selectedToolIds = new Set(await getSelectedToolIds());
    const baseIntegrationIds = new Set<string>();
    for (const n of parsed.nodes || []) {
      if (n.id.startsWith("tool:") && n.requires_integration) {
        baseIntegrationIds.add(n.requires_integration);
      }
    }
    const allowedIntegrations = new Set([...selectedToolIds, ...baseIntegrationIds, ...existingIds]);

    // Insert integrations first — only user-selected or base ones
    for (const i of parsed.integrations || []) {
      if (existingIds.has(i.id)) continue;
      if (!allowedIntegrations.has(i.id)) continue;
      toInsert.push({
        id: i.id,
        label: i.label,
        description: i.description,
        nodeType: "integration",
        status: "locked",
        branch: i.branch,
        parentId: i.branch,
        credentialKey: i.credential_key,
        sortOrder: 10,
      });
    }

    // Insert tools/skills — link to integration only if it's allowed
    for (const n of parsed.nodes || []) {
      if (existingIds.has(n.id)) continue;
      const integrationAllowed = !n.requires_integration || allowedIntegrations.has(n.requires_integration);
      toInsert.push({
        id: n.id,
        label: n.label,
        description: n.description,
        nodeType: n.type,
        status: integrationAllowed && n.requires_integration ? "locked" : "active",
        branch: n.branch,
        parentId: n.branch,
        requiresIntegration: integrationAllowed ? n.requires_integration : null,
        sortOrder: n.type === "tool" ? 100 : 200,
      });
    }

    if (toInsert.length > 0) {
      await db.insert(kaiSkillTreeNodes).values(toInsert).onConflictDoNothing();
      log.info({
        nodes: parsed.nodes?.length ?? 0,
        integrations: parsed.integrations?.length ?? 0,
      }, "AI populated skill tree");
    }
  } catch (err) {
    log.error({ err }, "Failed to sync skill tree via AI");
  }

  await generateIntegrationSubCapabilities(session.id);
}

async function generateIntegrationSubCapabilities(sessionId: string) {
  const allNodes = await db.select().from(kaiSkillTreeNodes);
  const integrations = allNodes.filter((n) => n.nodeType === "integration");

  const sparse = integrations.filter((i) => {
    const childCount = allNodes.filter((n) => n.requiresIntegration === i.id).length;
    return childCount < 3;
  });

  if (sparse.length === 0) return;

  const integrationList = sparse
    .map((i) => `- ${i.id} (${i.label}): ${i.description}`)
    .join("\n");

  const existingChildren = new Map<string, string[]>();
  for (const i of sparse) {
    existingChildren.set(
      i.id,
      allNodes.filter((n) => n.requiresIntegration === i.id).map((n) => n.label),
    );
  }

  const existingDetail = sparse
    .map((i) => {
      const kids = existingChildren.get(i.id) ?? [];
      return `- ${i.id}: existing children = [${kids.join(", ") || "none"}]`;
    })
    .join("\n");

  const prompt = `You are expanding the skill tree UI with sub-capabilities for integrations.

These integrations need more child nodes to show what they unlock:
${integrationList}

Existing children (do NOT duplicate these):
${existingDetail}

For each integration, generate 3-5 BROAD capability categories that become available when connected. These must be general-purpose — things an AI assistant would do repeatedly, not one-off tasks.

GOOD (broad, reusable): "PR Review", "Issue Management", "Notifications", "Schema Inspect", "Data Export"
BAD (too narrow/specific): "Lambda Deploy", "S3 Upload", "Create Jira Sprint", "Merge Dependabot PR"

Think: what are the top-level CATEGORIES of work this integration enables?

Respond with ONLY valid JSON, no markdown:
{
  "nodes": [
    {"id": "task:pr-review", "label": "PR Review", "description": "Review and comment on pull requests", "type": "task", "branch": "engineering", "requires_integration": "github"},
    {"id": "task:issue-mgmt", "label": "Issue Management", "description": "Create, triage, and close issues", "type": "task", "branch": "engineering", "requires_integration": "github"}
  ]
}

Rules:
- type is always "task"
- id format: "task:<kebab-name>"
- Each node must reference one of the integrations above via requires_integration
- branch must match the integration's branch
- Do NOT duplicate any existing children listed above
- Keep labels short (1-3 words), general enough to cover many tasks
- Keep descriptions under 10 words`;

  try {
    const result = await executeAgentWithPi({
      sessionId,
      userId: "system",
      prompt,
      skipHistory: true,
    });

    const text = result.content?.trim() || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("Sub-capability response did not contain valid JSON — skipping");
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      nodes: Array<{
        id: string;
        label: string;
        description: string;
        type: "task";
        branch: string;
        requires_integration: string;
      }>;
    };

    const existingIds = new Set(allNodes.map((n) => n.id));
    const toInsert: Array<typeof kaiSkillTreeNodes.$inferInsert> = [];

    for (const n of parsed.nodes ?? []) {
      if (existingIds.has(n.id)) continue;
      toInsert.push({
        id: n.id,
        label: n.label,
        description: n.description,
        nodeType: "task",
        status: "locked",
        branch: n.branch,
        parentId: n.branch,
        requiresIntegration: n.requires_integration,
        sortOrder: 300,
      });
    }

    if (toInsert.length > 0) {
      await db.insert(kaiSkillTreeNodes).values(toInsert).onConflictDoNothing();
      log.info({ count: toInsert.length }, "Generated integration sub-capabilities");
    }
  } catch (err) {
    log.error({ err }, "Failed to generate integration sub-capabilities");
  }
}
