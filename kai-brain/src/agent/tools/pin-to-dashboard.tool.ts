import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { db } from "../../db/client.js";
import { kaiDashboardArtifacts } from "../../db/schema/dashboard-artifacts.js";
import type { ArtifactData } from "../../db/schema/dashboard-artifacts.js";
import { and, eq } from "drizzle-orm";

const PinToDashboardSchema = Type.Object({
  action: Type.Optional(Type.String({
    description: 'Action: "pin" (default — create or update an artifact), "remove" (delete by power_id + key), "list" (list artifacts for a power)',
  })),
  power_id: Type.String({ description: "The ID of the power" }),
  power_name: Type.Optional(Type.String({ description: "Display name of the power (required for pin)" })),
  key: Type.Optional(Type.String({ description: "Stable unique key for this artifact within the power. Same power_id + key = upsert. Required for pin and remove." })),
  label: Type.Optional(Type.String({ description: "Human-readable title shown on the dashboard card (required for pin)" })),
  artifact_type: Type.Optional(Type.String({
    description: 'Artifact type: "number", "text", "table", "chart", "image", "links", "report" (required for pin)',
  })),
  data: Type.Optional(Type.String({
    description: "JSON string of the artifact payload (required for pin). number: {value,unit?}. text: {content}. table: {columns,rows}. chart: {chartType:bar|line|area|pie|stacked-bar, labels:[...], series:[{name,values,color?}]}. image: {url,alt?}. links: {items:[{url,label,description?}]}. report: {summary,sections:[{heading,content,severity?}]}"
  })),
  icon: Type.Optional(Type.String({ description: "Optional emoji icon for the card" })),
});

type PinToDashboardArgs = Static<typeof PinToDashboardSchema>;

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}

export function createPinToDashboardTool(context: {
  sessionId: string;
}): ToolDefinition {
  return {
    name: "pin_to_dashboard",
    label: "Pin to Dashboard",
    description:
      "Manage dashboard artifacts. Actions: " +
      "pin (default) — create or update a rich artifact on the dashboard; " +
      "remove — delete an artifact by power_id + key; " +
      "list — show all artifacts for a power.",
    parameters: PinToDashboardSchema,
    execute: async (
      _toolCallId: string,
      args: PinToDashboardArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const action = args.action || "pin";

      try {
        switch (action) {
          case "pin": {
            if (!args.key || !args.label || !args.artifact_type || !args.data || !args.power_name) {
              return text("Failed: key, label, artifact_type, data, and power_name are required for pin.");
            }

            let data: ArtifactData;
            try {
              data = JSON.parse(args.data) as ArtifactData;
            } catch {
              return text("Failed: 'data' must be a valid JSON string.");
            }

            const existing = await db
              .select({ id: kaiDashboardArtifacts.id })
              .from(kaiDashboardArtifacts)
              .where(and(
                eq(kaiDashboardArtifacts.powerId, args.power_id),
                eq(kaiDashboardArtifacts.key, args.key),
              ))
              .limit(1);

            if (existing.length > 0) {
              await db
                .update(kaiDashboardArtifacts)
                .set({
                  powerName: args.power_name,
                  label: args.label,
                  artifactType: args.artifact_type,
                  data,
                  icon: args.icon ?? null,
                  lastRunId: context.sessionId,
                  updatedAt: new Date(),
                })
                .where(eq(kaiDashboardArtifacts.id, existing[0].id));
            } else {
              await db.insert(kaiDashboardArtifacts).values({
                id: crypto.randomUUID(),
                powerId: args.power_id,
                powerName: args.power_name,
                key: args.key,
                label: args.label,
                artifactType: args.artifact_type,
                data,
                icon: args.icon ?? null,
                lastRunId: context.sessionId,
              });
            }

            const verb = existing.length > 0 ? "updated" : "pinned";
            return text(`Artifact "${args.label}" ${verb} on dashboard.`);
          }

          case "remove": {
            if (!args.key) {
              return text("Failed: key is required for remove.");
            }

            const target = await db
              .select({ id: kaiDashboardArtifacts.id, label: kaiDashboardArtifacts.label })
              .from(kaiDashboardArtifacts)
              .where(and(
                eq(kaiDashboardArtifacts.powerId, args.power_id),
                eq(kaiDashboardArtifacts.key, args.key),
              ))
              .limit(1);

            if (target.length === 0) {
              return text(`No artifact found with power_id="${args.power_id}" key="${args.key}".`);
            }

            await db.delete(kaiDashboardArtifacts).where(eq(kaiDashboardArtifacts.id, target[0].id));
            return text(`Artifact "${target[0].label}" removed from dashboard.`);
          }

          case "list": {
            const rows = await db
              .select({
                key: kaiDashboardArtifacts.key,
                label: kaiDashboardArtifacts.label,
                artifactType: kaiDashboardArtifacts.artifactType,
              })
              .from(kaiDashboardArtifacts)
              .where(eq(kaiDashboardArtifacts.powerId, args.power_id));

            if (rows.length === 0) {
              return text(`No dashboard artifacts for power "${args.power_id}".`);
            }

            const listing = rows.map((r) => `- ${r.key}: "${r.label}" (${r.artifactType})`).join("\n");
            return text(`Artifacts for "${args.power_id}":\n${listing}`);
          }

          default:
            return text(`Unknown action "${action}". Use "pin", "remove", or "list".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`Failed: ${msg}`);
      }
    },
  };
}
