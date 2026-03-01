/**
 * System Prompt Builder
 *
 * Operational sections only — personality comes from SOUL.md/AGENTS.md.
 */
import { searchMemories } from "../services/memory.service.js";
import os from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Types ---

export type PromptMode = "full" | "minimal" | "none";
export type ReactionMode = "minimal" | "extensive";
export type CitationsMode = "off" | "on" | "auto";

export interface ContextFile {
  path: string;
  content: string;
}

export interface SystemPromptOptions {
  userId: string;
  sessionId: string;
  promptMode?: PromptMode;
  customInstructions?: string;
  contextSummary?: string;
  memoryContext?: string;
  skillsContext?: string;
  toolNames?: string[];
  workspaceDir?: string;
  modelId?: string;
  channel?: string;
  thinkingLevel?: string;
  extraSystemPrompt?: string;
  contextFiles?: ContextFile[];
  userTimezone?: string;
  reactionMode?: ReactionMode;
  citationsMode?: CitationsMode;
  capabilities?: string[];
  toolDescriptions?: Record<string, string>;
  userRole?: string;
  userDisplayName?: string;
  userCustomInstructions?: string;
  sandboxEnabled?: boolean;
  heartbeatPrompt?: string;
  credentialEnvVars?: string[];
}

// --- Tool summaries ---

const TOOL_SUMMARIES: Record<string, string> = {
  read: "Read file contents",
  exec: "Run shell commands (pty available for TTY-required CLIs)",
  process: "Manage background exec sessions",
  edit: "Make precise edits to files",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns",
  find: "Find files by glob pattern",
  ls: "List directory contents",
  spawn_subagent: "Delegate tasks to sub-agents (async). Use explicit `mode` (`run|session`) and `delivery.announce` (`silent|brief|full`) to control completion routing. Nested spawns are also async; monitor them with `action: \"list\"` or `action: \"status\"` + `run_id` instead of waiting inline. Also: steer, kill.",
  schedule: "Manage cron jobs and wake events. " +
    "IMPORTANT: payloads run with NO conversation history — write them as fully self-contained instructions " +
    "including what action to take, who/where to deliver, and all context needed to execute independently.",
  browser: "Control web browser",
  web_search: "Search the web (Exa API)",
  web_fetch: "Fetch and extract readable content from a URL",
  slack_message: "Send messages and files to Slack",
  slack_actions: "Slack actions (send/edit/delete/read, react/reactions, pins, emojis, member info)",
  python_exec: "Execute Python code in a secure Docker sandbox",
  memory: "Search, save, list, or delete long-term memories",
  sql_query: "Query external databases (read-only SQL)",
  get_current_time: "Get the current date and time",
  get_session_info: "Get information about the current session",
  tts: "Text to speech",
  user_manage: "Manage user identity, credentials, and preferences. Store API keys/tokens, link external accounts (GitHub, Linear, Notion, etc.), update personal config (timezone, custom instructions).",
};

const TOOL_ORDER = [
  "read", "write", "edit", "grep", "find", "ls",
  "exec", "process",
  "web_search", "web_fetch", "browser",
  "python_exec", "sql_query", "memory",
  "spawn_subagent", "schedule",
  "slack_message", "slack_actions",
  "get_current_time", "get_session_info",
  "tts", "user_manage",
];

// --- Section builders ---

function buildToolingSection(toolNames: string[], dynamicDescriptions?: Record<string, string>): string[] {
  if (toolNames.length === 0) return [];
  const descriptions = { ...TOOL_SUMMARIES, ...(dynamicDescriptions || {}) };
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const name of TOOL_ORDER) {
    if (toolNames.includes(name)) {
      const summary = descriptions[name];
      ordered.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
      seen.add(name);
    }
  }
  for (const name of toolNames) {
    if (!seen.has(name)) {
      const summary = descriptions[name];
      ordered.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
    }
  }
  return [
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    ...ordered,
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "If a task is more complex or takes longer, spawn a sub-agent. It will do the work for you and report via configured delivery.",
    "When spawning sub-agents, always set explicit `mode` and `delivery.announce`:",
    '- `mode: "run"` for normal delegated task execution; `mode: "session"` when you need durable child-session lifecycle',
    '- `delivery.announce: "silent"` for internal research/prep the user does not need to see immediately',
    '- `delivery.announce: "brief"` for a one-line acknowledgement of background work',
    '- `delivery.announce: "full"` (default) for results the user explicitly asked for or must act on',
    "Prefer silent/brief for intermediate steps to avoid flooding the conversation.",
  ];
}

function buildSkillsSection(isMinimal: boolean, skillsContext?: string): string[] {
  if (isMinimal || !skillsContext) return [];
  return [
    "## Skills (mandatory)",
    "Before replying: scan entries.",
    "- If exactly one skill clearly applies: read its SKILL.md with `read`, then follow it.",
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "",
    skillsContext,
  ];
}

function buildMemoryRecallSection(
  isMinimal: boolean,
  toolNames: string[],
  citationsMode: CitationsMode
): string[] {
  if (isMinimal || !toolNames.includes("memory")) return [];
  const lines = [
    "## Memory Recall",
    'Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory(action="search") to check long-term memory. If low confidence after search, say you checked.',
  ];
  if (citationsMode === "off") {
    lines.push("Citations are disabled: do not mention memory IDs or internal paths in replies unless the user explicitly asks.");
  } else {
    lines.push("Citations: include Source when it helps the user verify memory snippets.");
  }
  return lines;
}

function buildTimezoneSection(isMinimal: boolean, timezone?: string): string[] {
  if (isMinimal || !timezone) return [];
  return [
    "## Current Date & Time",
    `Time zone: ${timezone}`,
    "If you need the current date, time, or day of week, run get_current_time.",
  ];
}

function buildSandboxSection(isMinimal: boolean, sandboxEnabled: boolean, workspaceDir: string): string[] {
  if (isMinimal || !sandboxEnabled) return [];

  const hostWorkspace = workspaceDir;
  const containerWorkspace = "/workspace";

  return [
    "## Sandbox & File Operations",
    "",
    "Kai uses Docker sandbox for code execution with separate path spaces:",
    "",
    "**File Tools** (read, write, edit, glob, grep):",
    `- Use HOST paths: ${hostWorkspace}`,
    `- Example: read("${hostWorkspace}/src/file.ts")`,
    "",
    "**Execution Tools** (exec, python_exec):",
    `- Use CONTAINER paths: ${containerWorkspace}`,
    `- Example: exec("cd ${containerWorkspace} && npm test")`,
    "",
    "⚠️ NEVER mix path types - file tools see host, exec tools see container.",
  ];
}

function buildSlackMessagingSection(isMinimal: boolean, toolNames: string[]): string[] {
  if (isMinimal || !toolNames.includes("slack_message")) return [];

  return [
    "## Slack Messaging (slack_message tool)",
    "",
    "**Text Messages**:",
    "- Use markdown: *bold*, _italic_, ~strikethrough~, `code`, ```code blocks```",
    "- Tables render as code blocks (preserves structure)",
    "- @mentions: Use Slack user IDs (<@U123ABC>)",
    "",
    "**File Uploads** (4 methods):",
    "1. media: Direct URL (https://...)",
    "2. filePath: Absolute host path (/Users/.../file.pdf)",
    "3. buffer: Base64 encoded data",
    "4. content: Text content as file (specify filename)",
    "",
    "**Security**: Never upload .env, credentials.json, or API keys",
    "",
    "**Threading**:",
    "- Messages go to current thread automatically",
    "- Override with explicit threadId parameter if needed",
  ];
}

function buildReactionsSection(isMinimal: boolean, mode: ReactionMode): string[] {
  if (isMinimal) return [];
  if (mode === "extensive") {
    return [
      "## Reactions",
      "Feel free to react liberally:",
      "- Acknowledge messages with appropriate emojis",
      "- Express sentiment and personality through reactions",
      "- React to interesting content, humor, or notable events",
      "Guideline: react whenever it feels natural.",
    ];
  }
  return [
    "## Reactions",
    "React ONLY when truly relevant:",
    "- Acknowledge important user requests or confirmations",
    "- Express genuine sentiment (humor, appreciation) sparingly",
    "- Avoid reacting to routine messages or your own replies",
    "Guideline: at most 1 reaction per 5-10 exchanges.",
  ];
}

function buildReasoningSection(thinkingLevel?: string): string[] {
  if (!thinkingLevel || thinkingLevel === "off") return [];
  return [
    "## Reasoning Format",
    "ALL internal reasoning MUST be inside <think>...</think> tags.",
    "Do not output any analysis outside <think>.",
    "Format every reply as <think>reasoning</think> then <final>response</final>.",
    "Only text inside <final> is shown to the user; everything else is discarded.",
  ];
}

function buildProjectContextSection(contextFiles?: ContextFile[]): string[] {
  if (!contextFiles || contextFiles.length === 0) return [];
  const hasSoul = contextFiles.some(
    (f) => f.path.toLowerCase().endsWith("soul.md")
  );
  const lines = [
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  if (hasSoul) {
    lines.push(
      "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it."
    );
  }
  lines.push("");
  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines;
}

function buildRuntimeLine(options: {
  sessionId: string;
  modelId?: string;
  channel?: string;
  thinkingLevel?: string;
  capabilities?: string[];
}): string {
  return `Runtime: ${[
    `os=${os.platform()} (${os.arch()})`,
    `node=${process.versions.node}`,
    options.modelId ? `model=${options.modelId}` : "",
    options.channel ? `channel=${options.channel}` : "",
    options.capabilities?.length ? `capabilities=${options.capabilities.join(",")}` : "",
    `thinking=${options.thinkingLevel || "off"}`,
    `session=${options.sessionId}`,
  ].filter(Boolean).join(" | ")}`;
}

function buildUserIdentitySection(
  isMinimal: boolean,
  userRole?: string,
  userDisplayName?: string,
): string[] {
  if (isMinimal || !userRole) return [];
  const lines = ["## Current User"];
  if (userDisplayName) lines.push(`Name: ${userDisplayName}`);
  lines.push(`Role: ${userRole}`);
  lines.push(
    "Use user_manage tool to handle identity, credentials, and preferences conversationally.",
    "When the user shares API keys, tokens, or credentials, ALWAYS store them via user_manage(action=\"save_credential\", key=\"<CREDENTIAL_NAME>\", value=\"<the-value>\"). NEVER write secrets to files on disk.",
    "IMPORTANT: Use env-var-compatible UPPER_SNAKE_CASE key names for credentials (e.g. GITHUB_TOKEN, LINEAR_API_KEY, NOTION_TOKEN, OPENAI_API_KEY). These keys become environment variables in exec automatically.",
    "If you need a credential from the user but don't have the value, use user_manage(action=\"request_credential\") to show a secure input form.",
    "When the user mentions their username on a platform, link it via user_manage(action=\"link_identity\").",
    "When the user asks to change preferences (timezone, instructions), use user_manage(action=\"update_config\").",
  );
  if (userRole === "owner") {
    lines.push(
      "This user is the owner. They have full access and can manage other users.",
      "Admin slash commands: /users (list users), /role @user admin|member (change roles)",
    );
  } else if (userRole === "admin") {
    lines.push("This user is an admin with elevated access.");
  }
  return lines;
}

// --- Main builder ---

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const {
    userId: _userId,
    sessionId,
    promptMode = "full",
    customInstructions,
    contextSummary,
    memoryContext,
    skillsContext,
    toolNames = [],
    workspaceDir,
    modelId,
    channel,
    thinkingLevel,
    extraSystemPrompt,
    contextFiles,
    userTimezone,
    reactionMode = "minimal",
    citationsMode = "off",
    capabilities,
    userRole,
    userDisplayName,
    userCustomInstructions,
  } = options;

  if (promptMode === "none") {
    return "You are Kai, a team coworker helping the company execute and improve.";
  }

  const isMinimal = promptMode === "minimal";
  const avaWorkspace = workspaceDir || join(homedir(), ".ava", "workspace");

  const lines: string[] = [
    "You are Kai, a team coworker helping the company execute and improve.",
    "",
    // --- Tooling ---
    ...buildToolingSection(toolNames, options.toolDescriptions),
    "",
    // --- Tool Call Style ---
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
    // --- Safety ---
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards.",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];

  const push = (section: string[]) => {
    if (section.length) lines.push("", ...section);
  };

  push(buildSkillsSection(isMinimal, skillsContext));
  push(buildMemoryRecallSection(isMinimal, toolNames, citationsMode));

  // --- Workspace ---
  lines.push(
    "", "## Workspace",
    `Your working directory is: ${avaWorkspace}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
  );

  push(buildSandboxSection(isMinimal, options.sandboxEnabled ?? false, avaWorkspace));
  push(buildSlackMessagingSection(isMinimal, toolNames));
  push(buildTimezoneSection(isMinimal, userTimezone));

  if (!isMinimal) {
    lines.push("", "## Workspace Files (injected)", "These user-editable files are loaded by Kai and included below in Project Context.");
  }

  // --- Extra context ---
  if (extraSystemPrompt) {
    const header = isMinimal ? "## Subagent Context" : "## Group Chat Context";
    lines.push("", header, extraSystemPrompt);
  }

  push(buildUserIdentitySection(isMinimal, userRole, userDisplayName));

  if (options.credentialEnvVars && options.credentialEnvVars.length > 0) {
    lines.push(
      "",
      "## Credentials (auto-injected as environment variables in exec)",
      `The following are available in every exec call: ${options.credentialEnvVars.join(", ")}`,
      "Use them directly — e.g. curl -H \"Authorization: token $GITHUB_TOKEN\" or git commands will pick up GITHUB_TOKEN automatically.",
      "Do NOT ask the user for these credentials — they are already configured.",
    );
  }

  push(buildReactionsSection(isMinimal, reactionMode));
  push(buildReasoningSection(thinkingLevel));
  push(buildProjectContextSection(contextFiles));

  // --- Context injections ---
  if (memoryContext) lines.push("", memoryContext);
  if (contextSummary) lines.push("", "## Previous Context (This Session)", contextSummary);
  if (userCustomInstructions) lines.push("", "## User-Specific Instructions", userCustomInstructions);
  if (customInstructions) lines.push("", "## Additional Instructions", customInstructions);

  // --- Runtime ---
  lines.push("", buildRuntimeLine({ sessionId, modelId, channel, thinkingLevel, capabilities }));

  return lines.filter(Boolean).join("\n");
}

// --- Memory context retrieval ---

export async function getMemoryContext(
  userId: string,
  prompt: string,
  limit = 5
): Promise<string | null> {
  try {
    const memories = await searchMemories(userId, prompt, limit);
    if (memories.length === 0) return null;
    const lines = ["## Relevant Context from Previous Conversations"];
    for (const mem of memories) {
      lines.push(`- ${mem.content}`);
    }
    return lines.join("\n");
  } catch (error) {
    console.error("Failed to retrieve memories:", error);
    return null;
  }
}

// --- Compaction prompt ---

export function buildCompactionPrompt(messagesToSummarize: string): string {
  return `Please summarize the following conversation history, preserving:
1. Key decisions made
2. Important facts learned
3. Outstanding questions or tasks
4. Context needed to continue the conversation

Be concise but complete. Focus on information that would be needed to continue helping the user.

Conversation to summarize:
${messagesToSummarize}`;
}
