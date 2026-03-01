/**
 * Tool Converter for Pi-Agent
 *
 * Provides access to pi-coding-agent's built-in tools (minus bash, replaced by exec)
 * and registers all custom AVA tools.
 */
import { Type } from "@sinclair/typebox";
import {
  codingTools,
  readOnlyTools,
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
  createFindTool,
  createGrepTool,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { createSpawnSubagentTool } from "./tools/subagent.tool.js";
import { createCronTool } from "./tools/cron.tool.js";
import { createBrowserTool } from "./tools/browser.tool.js";
import { createPythonTool } from "./tools/python.tool.js";
import { createExecTool } from "./tools/exec.tool.js";
import { createProcessTool } from "./tools/process.tool.js";
import { createWebSearchTool } from "./tools/web-search.tool.js";
import { createWebFetchTool } from "./tools/web-fetch.tool.js";
import { createSlackActionsTool } from "./tools/slack-actions.tool.js";
import { createSlackMessageTool } from "./tools/slack-message.tool.js";
import { createMemoryTool } from "./tools/memory.tool.js";
import { createSqlTool } from "./tools/sql.tool.js";
import { createImageTool } from "./tools/image.tool.js";
import { createSessionStatusTool } from "./tools/session-status.tool.js";
import { createSessionsTool } from "./tools/sessions.tool.js";
import { createSessionsSendTool } from "./tools/sessions-send.tool.js";
import { createTtsTool } from "./tools/tts.tool.js";
import { createUserManageTool } from "./tools/user-manage.tool.js";
import { createSkillTreeTool } from "./tools/skill-tree.tool.js";
import { createPowerResultTool } from "./tools/power-result.tool.js";
import { createPinToDashboardTool } from "./tools/pin-to-dashboard.tool.js";
import { createManagePowerTool } from "./tools/manage-power.tool.js";
import { evaluateToolPolicy } from "./tools/tool-policy.js";
import type { UserContext } from "./user-context.js";
import { getConfig } from "../lib/config-loader.js";
import { createDockerOperations } from "../sandbox/docker-operations.js";

type BuiltInTool = (typeof codingTools)[number];

/**
 * Get pi-coding-agent's built-in tools, filtering out bash (replaced by exec).
 * When sandboxContainer is provided, uses Docker-backed operations for file tools.
 */
export function getBuiltInTools(options?: {
  cwd?: string;
  readOnly?: boolean;
  sandboxContainer?: string;
}): BuiltInTool[] {
  if (options?.sandboxContainer) {
    const cwd = options.cwd || process.cwd();
    const ops = createDockerOperations(options.sandboxContainer);
    const tools: BuiltInTool[] = [
      createReadTool(cwd, { operations: ops.read }),
      createLsTool(cwd, { operations: ops.ls }),
      createFindTool(cwd, { operations: ops.find }),
      createGrepTool(cwd, { operations: ops.grep }),
    ];
    if (!options.readOnly) {
      tools.push(
        createWriteTool(cwd, { operations: ops.write }),
        createEditTool(cwd, { operations: ops.edit }),
      );
    }
    return tools;
  }
  const tools = options?.readOnly ? readOnlyTools : codingTools;
  return tools.filter((t) => t.name !== "bash");
}

/**
 * Create all custom tools for pi-agent.
 */
export function createCustomTools(options: {
  userId: string;
  sessionId: string;
  externalId?: string;
  userContext?: UserContext;
  sandboxContainer?: string;
  sessionSource?: string | null;
  subagentDepth?: number;
  deliveryContext?: {
    externalId: string;
  };
}): ToolDefinition[] {
  const { userId, sessionId } = options;

  const tools: ToolDefinition[] = [
    // Shell execution (replaces built-in bash)
    createExecTool({
      userId,
      sessionId,
      userCredentials: options.userContext?.credentials,
      sandboxContainer: options.sandboxContainer,
      execHost: getConfig().tools.exec.host as "sandbox" | "gateway" | "node",
      execSecurity: getConfig().tools.exec.security as "deny" | "allowlist" | "full",
      execAsk: getConfig().tools.exec.ask as "off" | "on-miss" | "always",
      execAskFallback: getConfig().tools.exec.askFallback as "deny" | "allowlist" | "full",
      execAllowlist: getConfig().tools.exec.allowlist,
      execNode: getConfig().tools.exec.node,
      execPathPrepend: getConfig().tools.exec.pathPrepend,
      execSafeBins: getConfig().tools.exec.safeBins,
      execSafeBinTrustedDirs: getConfig().tools.exec.safeBinTrustedDirs,
      execBackgroundMs: getConfig().tools.exec.backgroundMs,
      execTimeoutSec: getConfig().tools.exec.timeoutSec,
      deliveryExternalId: options.externalId,
      approvalRunningNoticeMs: getConfig().tools.exec.approvalRunningNoticeMs,
    }),
    createProcessTool(),

    // Web search & fetch
    createWebSearchTool(),
    createWebFetchTool(),

    // Browser automation
    createBrowserTool(),

    // Python sandbox
    createPythonTool({
      sandboxContainer: options.sandboxContainer,
      userCredentials: options.userContext?.credentials,
    }),

    // Slack integrations
    createSlackActionsTool({ userId, sessionId }),
    createSlackMessageTool({ userId, sessionId }),

    // Memory
    createMemoryTool({ userId, sessionId }),

    // SQL
    createSqlTool(),

    // Image analysis
    createImageTool(),

    // Session management
    createSessionStatusTool({ userId, sessionId }),
    createSessionsTool({ userId, sessionId }),
    createSessionsSendTool(),

    // TTS
    createTtsTool(),

    // Power result recording
    createPowerResultTool({ sessionId }),

    // Dashboard artifacts
    createPinToDashboardTool({ sessionId }),

    // Power management
    createManagePowerTool({ sessionId }),

    // Subagent & scheduling
    createSpawnSubagentTool({
      userId,
      sessionId,
      externalId: options.externalId,
      sandboxContainer: options.sandboxContainer,
      sessionSource: options.sessionSource,
      currentDepth: options.subagentDepth,
      deliveryContext: options.deliveryContext,
      userContext: options.userContext,
    }),
    createCronTool({ userId, sessionId }),

    // Utilities
    {
      name: "get_current_time",
      label: "Get Time",
      description: "Get the current date and time",
      parameters: Type.Object({
        timezone: Type.Optional(
          Type.String({
            description:
              'Timezone (e.g., "America/New_York"). Defaults to UTC.',
          })
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { timezone?: string },
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback,
        _ctx?: unknown
      ): Promise<AgentToolResult<unknown>> => {
        const now = new Date();
        const formatOptions: Intl.DateTimeFormatOptions = {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: params.timezone || "UTC",
        };
        const result = {
          timestamp: now.toISOString(),
          formatted: now.toLocaleString("en-US", formatOptions),
          timezone: params.timezone || "UTC",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },

    {
      name: "get_session_info",
      label: "Session Info",
      description: "Get information about the current session",
      parameters: Type.Object({}),
      execute: async (
        _toolCallId: string,
        _params: Record<string, never>,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback,
        _ctx?: unknown
      ): Promise<AgentToolResult<unknown>> => {
        const result = {
          sessionId,
          userId,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
  ];

  if (options.userContext) {
    tools.push(
      createUserManageTool({
        userId: options.userContext.id,
        userRole: options.userContext.role,
      }),
    );
  }

  tools.push(createSkillTreeTool());

  return tools.map((tool) => wrapToolWithPolicy(tool, options));
}

function wrapToolWithPolicy(
  tool: ToolDefinition,
  options: {
    sessionId: string;
    sessionSource?: string | null;
  },
): ToolDefinition {
  const originalExecute = tool.execute;
  if (!originalExecute) {
    return tool;
  }
  const executeAny = originalExecute as (...args: unknown[]) => Promise<AgentToolResult<unknown>>;

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      ctx?: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const decision = evaluateToolPolicy({
        toolName: tool.name,
        sessionId: options.sessionId,
        sessionSource: options.sessionSource,
        args: params,
      });

      if (!decision.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `Tool blocked by policy: ${decision.reason ?? "not allowed"}`,
            },
          ],
          details: {
            error: "tool_policy_blocked",
            reason: decision.reason,
            tool: tool.name,
          },
        };
      }

      return executeAny(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * Get all tools for a session, applying per-user tool policy when role enforcement is enabled.
 */
export function getPiTools(options: {
  userId: string;
  sessionId: string;
  cwd?: string;
  readOnly?: boolean;
  externalId?: string;
  userContext?: UserContext;
  sandboxContainer?: string;
  sessionSource?: string | null;
}): {
  builtInTools: BuiltInTool[];
  customTools: ToolDefinition[];
} {
  const builtIn = getBuiltInTools({
    cwd: options.cwd,
    readOnly: options.readOnly,
    sandboxContainer: options.sandboxContainer,
  });
  let custom = createCustomTools({
    userId: options.userId,
    sessionId: options.sessionId,
    externalId: options.externalId,
    userContext: options.userContext,
    sandboxContainer: options.sandboxContainer,
    sessionSource: options.sessionSource,
  });

  const policy = options.userContext?.config?.toolPolicy;
  const enforceRoles = getConfig().users.enforceRoles;

  if (enforceRoles && policy) {
    if (policy.allowed && policy.allowed.length > 0) {
      const allowSet = new Set(policy.allowed);
      custom = custom.filter((t) => allowSet.has(t.name));
    }
    if (policy.denied && policy.denied.length > 0) {
      const denySet = new Set(policy.denied);
      custom = custom.filter((t) => !denySet.has(t.name));
    }
  }

  return { builtInTools: builtIn, customTools: custom };
}

export function createTextResult(
  text: string,
  details?: unknown
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function createJsonResult(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function createErrorResult(
  error: string | Error
): AgentToolResult<unknown> {
  const message = error instanceof Error ? error.message : error;
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message },
  };
}
