/**
 * Cron Tool
 *
 * Allows the agent to create and manage scheduled tasks.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { cronService, type ScheduleKind } from "../../gateway/services/cron.js";

const CronActionSchema = Type.Object({
  action: Type.Unsafe<"list" | "add" | "update" | "remove" | "run">({
    type: "string",
    enum: ["list", "add", "update", "remove", "run"],
    description: "Action to perform: list, add, update, remove, or run",
  }),

  // For add action
  name: Type.Optional(
    Type.String({
      description: "Name of the scheduled task (required for add)",
    })
  ),
  description: Type.Optional(
    Type.String({ description: "Description of what the task does" })
  ),
  scheduleKind: Type.Optional(
    Type.Unsafe<ScheduleKind>({
      type: "string",
      enum: ["at", "every", "cron"],
      description:
        'Type of schedule: "at" for one-time at specific time, "every" for interval, "cron" for cron expression',
    })
  ),
  scheduleValue: Type.Optional(
    Type.String({
      description:
        'Schedule value: ISO timestamp or epoch ms for "at", interval in ms for "every", cron expression for "cron"',
    })
  ),
  timezone: Type.Optional(
    Type.String({ description: "Timezone for cron expressions (default: UTC)" })
  ),
  payload: Type.Optional(
    Type.String({
      description:
        "Self-contained instruction for the agent when the task fires. " +
        "The agent will have NO conversation history, so include everything needed: " +
        "what action to take, who/where to deliver, and any message content.",
    })
  ),
  deleteAfterRun: Type.Optional(
    Type.Boolean({
      description:
        'Delete the job after it runs once (default: false, auto-true for "at" schedules)',
    })
  ),

  // For update/remove/run actions
  jobId: Type.Optional(
    Type.String({ description: "Job ID (required for update, remove, run)" })
  ),

  // For update action
  enabled: Type.Optional(
    Type.Boolean({ description: "Enable or disable the job" })
  ),

  // For list action
  includeDisabled: Type.Optional(
    Type.Boolean({
      description: "Include disabled jobs in list (default: false)",
    })
  ),
});

type CronAction = Static<typeof CronActionSchema>;

export function createCronTool(context: {
  userId: string;
  sessionId: string;
}): ToolDefinition {
  return {
    name: "schedule",
    label: "Schedule",
    description: `Manage scheduled tasks and reminders. Use this to:
- Schedule one-time reminders ("at" schedule with ISO timestamp)
- Set up recurring tasks ("every" schedule with ms interval, e.g., 3600000 for hourly)
- Create cron jobs ("cron" schedule with cron expression, e.g., "0 9 * * 1-5" for 9am weekdays)

Payloads must be self-contained (no conversation history is available when they fire).

Examples:
- Reminder: action="add", scheduleKind="at", scheduleValue="<ISO timestamp>", payload="Remind the user about their upcoming meeting — post in the current channel"
- Daily check-in: action="add", scheduleKind="cron", scheduleValue="0 9 * * 1-5", payload="Post a good morning check-in message to the user in this channel"
- Periodic task: action="add", scheduleKind="every", scheduleValue="1800000", payload="Check for new updates and notify the user if any are found"`,
    parameters: CronActionSchema,
    execute: async (
      _toolCallId: string,
      args: CronAction,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const result = await executeCronAction(args, context);
        return {
          content: [{ type: "text", text: result }],
          details: { result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

async function executeCronAction(
  args: CronAction,
  context: { userId: string; sessionId: string }
): Promise<string> {
  switch (args.action) {
    case "list": {
      const jobs = await cronService.listJobs(
        context.sessionId,
        args.includeDisabled
      );
      if (jobs.length === 0) {
        return "No scheduled tasks found for this session.";
      }
      const lines = jobs.map((job) => {
        const next = job.nextRunAt
          ? new Date(job.nextRunAt).toISOString()
          : "never";
        const status = job.enabled ? "enabled" : "disabled";
        return `- ${job.name} (${job.id}): ${job.scheduleKind}="${job.scheduleValue}", next: ${next}, ${status}`;
      });
      return `Scheduled tasks:\n${lines.join("\n")}`;
    }

    case "add": {
      if (
        !args.name ||
        !args.scheduleKind ||
        !args.scheduleValue ||
        !args.payload
      ) {
        return "Error: name, scheduleKind, scheduleValue, and payload are required for add action.";
      }

      const job = await cronService.createJob({
        sessionId: context.sessionId,
        userId: context.userId,
        name: args.name,
        description: args.description,
        scheduleKind: args.scheduleKind,
        scheduleValue: args.scheduleValue,
        timezone: args.timezone,
        payload: args.payload,
        deleteAfterRun: args.deleteAfterRun ?? args.scheduleKind === "at",
        source: "agent",
      });

      const nextRun = job.nextRunAt
        ? new Date(job.nextRunAt).toISOString()
        : "could not compute";

      return `Created scheduled task "${job.name}" (${job.id}). Next run: ${nextRun}`;
    }

    case "update": {
      if (!args.jobId) {
        return "Error: jobId is required for update action.";
      }

      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.scheduleKind !== undefined)
        updates.scheduleKind = args.scheduleKind;
      if (args.scheduleValue !== undefined)
        updates.scheduleValue = args.scheduleValue;
      if (args.timezone !== undefined) updates.timezone = args.timezone;
      if (args.payload !== undefined) updates.payload = args.payload;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.deleteAfterRun !== undefined)
        updates.deleteAfterRun = args.deleteAfterRun;

      const job = await cronService.updateJob(args.jobId, updates);
      if (!job) {
        return `Error: Job ${args.jobId} not found.`;
      }

      return `Updated scheduled task "${job.name}" (${job.id}).`;
    }

    case "remove": {
      if (!args.jobId) {
        return "Error: jobId is required for remove action.";
      }

      const deleted = await cronService.deleteJob(args.jobId);
      if (!deleted) {
        return `Error: Job ${args.jobId} not found.`;
      }

      return `Deleted scheduled task ${args.jobId}.`;
    }

    case "run": {
      if (!args.jobId) {
        return "Error: jobId is required for run action.";
      }

      const triggered = await cronService.triggerJob(args.jobId);
      if (!triggered) {
        return `Error: Job ${args.jobId} not found.`;
      }

      return `Triggered scheduled task ${args.jobId}. The task message has been queued.`;
    }

    default:
      return `Unknown action: ${args.action}`;
  }
}
