import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { db } from "../../db/client.js";
import { kaiDashboardMetrics } from "../../db/schema/dashboard-metrics.js";
import { and, eq } from "drizzle-orm";

const LogMetricSchema = Type.Object({
  power_id: Type.String({ description: "The ID of the power logging this metric" }),
  power_name: Type.String({ description: "The display name of the power" }),
  key: Type.String({ description: "Unique key for this metric within the power (e.g. 'active_users', 'build_time')" }),
  label: Type.String({ description: "Human-readable label shown on the dashboard (e.g. 'Active Git Users')" }),
  value: Type.String({ description: "The metric value as a string (e.g. '42', '98.5%', 'Healthy')" }),
  unit: Type.Optional(Type.String({ description: "Optional unit (e.g. 'users', 'ms', '%', 'commits')" })),
  type: Type.Optional(Type.String({ description: 'Metric display type: "number", "text", or "percentage". Defaults to "number".' })),
  icon: Type.Optional(Type.String({ description: "Optional emoji icon for the metric card (e.g. '👥', '⏱️')" })),
});

type LogMetricArgs = Static<typeof LogMetricSchema>;

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}

export function createLogMetricTool(context: {
  sessionId: string;
}): ToolDefinition {
  return {
    name: "log_metric",
    label: "Log Metric",
    description:
      "Log a metric to the dashboard. Metrics are displayed as cards on the Command Center. " +
      "Use this to persist key numbers, stats, or status values that the user wants to track over time. " +
      "If a metric with the same power_id + key already exists, it will be updated.",
    parameters: LogMetricSchema,
    execute: async (
      _toolCallId: string,
      args: LogMetricArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const metricType = args.type || "number";

        const existing = await db
          .select({ id: kaiDashboardMetrics.id })
          .from(kaiDashboardMetrics)
          .where(
            and(
              eq(kaiDashboardMetrics.powerId, args.power_id),
              eq(kaiDashboardMetrics.key, args.key),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(kaiDashboardMetrics)
            .set({
              powerName: args.power_name,
              label: args.label,
              value: args.value,
              unit: args.unit ?? null,
              type: metricType,
              icon: args.icon ?? null,
              lastRunId: context.sessionId,
              updatedAt: new Date(),
            })
            .where(eq(kaiDashboardMetrics.id, existing[0].id));
        } else {
          await db.insert(kaiDashboardMetrics).values({
            id: crypto.randomUUID(),
            powerId: args.power_id,
            powerName: args.power_name,
            key: args.key,
            label: args.label,
            value: args.value,
            unit: args.unit ?? null,
            type: metricType,
            icon: args.icon ?? null,
            lastRunId: context.sessionId,
          });
        }

        return text(`Metric "${args.label}" logged to dashboard (${args.value}${args.unit ? " " + args.unit : ""}).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`Failed to log metric: ${msg}`);
      }
    },
  };
}
