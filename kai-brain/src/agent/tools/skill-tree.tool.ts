import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { streamSimple, getPiModel, getDefaultProvider } from "../pi-provider.js";
import { db } from "../../db/client.js";
import { kaiSkillTreeNodes } from "../../db/schema/settings.js";
import { runtime } from "../../gateway/runtime.js";
import type { SkillTreeUpdatedEvent } from "../../gateway/protocol/events.js";

const CLASSIFY_MODEL = "gemini-2.0-flash";
const CLASSIFY_TIMEOUT_MS = 15_000;

const BRANCHES = ["engineering", "design", "product", "general"] as const;
type Branch = (typeof BRANCHES)[number];

const SkillTreeSchema = Type.Object({
  action: Type.String({
    description: 'Action: "register"',
  }),
  name: Type.String({
    description: "Skill name (lowercase, hyphens only, e.g. 'gh-pr-review')",
  }),
  description: Type.String({
    description: "Short description of what the skill does",
  }),
});

type SkillTreeArgs = Static<typeof SkillTreeSchema>;

async function classifyBranch(name: string, description: string): Promise<{ branch: Branch; parentId: string }> {
  const prompt = `Classify this skill into exactly ONE branch. Respond with ONLY the branch name, nothing else.

Branches:
- engineering: code, files, shell, databases, CI/CD, testing, deployment
- design: UI, visual, screenshots, Figma, browser automation
- product: communication, search, research, project management, docs, scheduling
- general: core/general purpose (memory, time, session info, user management)

Skill: "${name}" — ${description}`;

  try {
    const model = getPiModel(getDefaultProvider(), CLASSIFY_MODEL);
    const stream = streamSimple(model, {
      systemPrompt: "You are a classifier. Respond with exactly one word.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });

    const result = await Promise.race([
      (async () => {
        let text = "";
        for await (const event of stream) {
          if (event.type === "done") {
            const tc = event.message.content.find((c) => c.type === "text") as TextContent | undefined;
            if (tc) text = tc.text;
          }
        }
        return text.trim().toLowerCase();
      })(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("classify timeout")), CLASSIFY_TIMEOUT_MS),
      ),
    ]);

    const branch = BRANCHES.find((b) => result.includes(b)) ?? "general";
    return { branch, parentId: branch };
  } catch {
    return { branch: "general", parentId: "general" };
  }
}

export function createSkillTreeTool(): ToolDefinition {
  return {
    name: "skill_tree",
    label: "Skill Tree",
    description:
      "Register new skills in the skill tree. Use after creating a skill's SKILL.md file to make it visible in the UI.",
    parameters: SkillTreeSchema,
    execute: async (
      _toolCallId: string,
      args: SkillTreeArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        switch (args.action) {
          case "register": {
            const { branch, parentId } = await classifyBranch(args.name, args.description);
            await db
              .insert(kaiSkillTreeNodes)
              .values({
                id: `skill:${args.name}`,
                label: args.name,
                description: args.description,
                nodeType: "skill",
                status: "active",
                branch,
                parentId,
                sortOrder: 200,
              })
              .onConflictDoNothing();
            const event: SkillTreeUpdatedEvent = {
              event: "skill-tree.updated",
              payload: { nodeId: `skill:${args.name}`, action: "registered" },
            };
            runtime.broadcast(event);
            return text(`Registered skill:${args.name} in skill tree (branch: ${branch}).`);
          }
          default:
            return text(`Unknown action: ${args.action}. Valid: register`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text(`Skill tree error: ${msg}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
