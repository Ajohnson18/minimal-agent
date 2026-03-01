import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { db } from "../../db/client.js";
import { kaiPowerRuns } from "../../db/schema/power-runs.js";
import type { PowerResponse } from "../../powers/types.js";

const PowerResultSchema = Type.Object({
  power_id: Type.String({ description: "The ID of the power that was executed" }),
  power_name: Type.String({ description: "The display name of the power" }),
  response_type: Type.String({
    description: 'Result type: "text", "report", "code", "pr", "table", "links"',
  }),
  content: Type.String({
    description: "The main result content as markdown text",
  }),
  title: Type.Optional(Type.String({ description: "Title for report-type results" })),
  summary: Type.Optional(Type.String({ description: "Brief summary for report-type results" })),
  score: Type.Optional(Type.Number({ description: "Score 0-100 for report-type results" })),
});

type PowerResultArgs = Static<typeof PowerResultSchema>;

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}

export function createPowerResultTool(context: {
  sessionId: string;
}): ToolDefinition {
  return {
    name: "power_result",
    label: "Power Result",
    description:
      "Record the result of a power execution. Call this ONCE at the end of executing a power to save the structured result. " +
      "This persists the result so users can view it later in the Command Center.",
    parameters: PowerResultSchema,
    execute: async (
      _toolCallId: string,
      args: PowerResultArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const result = buildResult(args);

        await db
          .insert(kaiPowerRuns)
          .values({
            id: crypto.randomUUID(),
            powerId: args.power_id,
            powerName: args.power_name,
            runId: context.sessionId,
            sessionId: context.sessionId,
            status: "completed",
            completedAt: new Date(),
            result,
          });

        return text(`Power result recorded (${args.response_type}).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`Failed to record power result: ${msg}`);
      }
    },
  };
}

function buildResult(args: PowerResultArgs): PowerResponse {
  switch (args.response_type) {
    case "report":
      return {
        type: "report",
        title: args.title || args.power_name,
        summary: args.summary || "",
        sections: parseSections(args.content),
        score: args.score,
      };
    case "code":
      return {
        type: "code",
        files: parseCodeBlocks(args.content),
      };
    case "pr":
      return {
        type: "pr",
        prs: parsePRs(args.content),
      };
    case "table":
      return {
        type: "table",
        columns: [],
        rows: [],
        title: args.title,
      };
    case "links":
      return {
        type: "links",
        links: parseLinks(args.content),
      };
    default:
      return { type: "text", content: args.content };
  }
}

function parseSections(content: string): Array<{ heading: string; content: string; severity?: "info" | "warning" | "critical" }> {
  const sections: Array<{ heading: string; content: string; severity?: "info" | "warning" | "critical" }> = [];
  const parts = content.split(/^#{1,3}\s+/m).filter(Boolean);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = newline > -1 ? part.slice(0, newline).trim() : part.trim();
    const body = newline > -1 ? part.slice(newline + 1).trim() : "";
    const lower = heading.toLowerCase();
    const severity = lower.includes("critical") || lower.includes("error") || lower.includes("high")
      ? "critical" as const
      : lower.includes("warning") || lower.includes("medium")
        ? "warning" as const
        : lower.includes("info") || lower.includes("low")
          ? "info" as const
          : undefined;
    sections.push({ heading, content: body, severity });
  }
  if (sections.length === 0) sections.push({ heading: "Result", content });
  return sections;
}

function parseCodeBlocks(content: string): Array<{ path: string; language: string; content: string }> {
  const blocks: Array<{ path: string; language: string; content: string }> = [];
  const re = /```(\w+)?(?:\s+([^\n]*))?\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    blocks.push({ language: match[1] || "text", path: match[2]?.trim() || "", content: match[3] });
  }
  if (blocks.length === 0) blocks.push({ path: "", language: "text", content });
  return blocks;
}

function parsePRs(content: string): Array<{ repo: string; number: number; title: string; url: string; status: "open" | "merged" | "closed" }> {
  const prs: Array<{ repo: string; number: number; title: string; url: string; status: "open" | "merged" | "closed" }> = [];
  const re = /https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/g;
  const seen = new Set<string>();
  let match;
  while ((match = re.exec(content)) !== null) {
    const key = `${match[1]}#${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push({ repo: match[1], number: parseInt(match[2], 10), title: `PR #${match[2]}`, url: match[0], status: "open" });
  }
  return prs;
}

function parseLinks(content: string): Array<{ url: string; label: string; description?: string }> {
  const links: Array<{ url: string; label: string; description?: string }> = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    links.push({ url: match[2], label: match[1] });
  }
  return links;
}
