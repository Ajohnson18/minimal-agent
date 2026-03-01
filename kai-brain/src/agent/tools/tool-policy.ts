export interface ToolPolicyContext {
  toolName: string;
  sessionId: string;
  sessionSource?: string | null;
  args?: unknown;
}

export interface ToolPolicyResult {
  allowed: boolean;
  reason?: string;
}

const SUBAGENT_DENY_ALWAYS = new Set<string>([
  "schedule",
  "session_status",
  "sessions",
]);

function hasExplicitSlackTarget(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const candidate = (args as Record<string, unknown>).target;
  return typeof candidate === "string" && candidate.trim().length > 0;
}

export function evaluateToolPolicy(ctx: ToolPolicyContext): ToolPolicyResult {
  const toolName = ctx.toolName.trim();
  const source = (ctx.sessionSource || "").trim().toLowerCase();
  const isSubagent = source === "subagent";

  if (isSubagent && SUBAGENT_DENY_ALWAYS.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is disabled in subagent sessions.`,
    };
  }

  if (isSubagent && toolName === "slack_message" && !hasExplicitSlackTarget(ctx.args)) {
    return {
      allowed: false,
      reason:
        "Subagent sessions must provide an explicit Slack target to send outbound messages.",
    };
  }

  return { allowed: true };
}
