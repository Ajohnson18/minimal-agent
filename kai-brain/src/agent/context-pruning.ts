/**
 * Context Pruning for Pi-Agent
 *
 * Implements Tier 1 of context management: pruning old tool results
 * to reduce context size while preserving conversation flow.
 */
import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
} from "@mariozechner/pi-ai";
import { getConfig } from "../lib/config-loader.js";

export type ContextPruningMode = "off" | "adaptive" | "aggressive";

export interface ContextPruningConfig {
  /** Pruning mode: off, adaptive, or aggressive */
  mode: ContextPruningMode;
  /** Number of recent assistant messages to always keep intact */
  keepLastAssistants: number;
  /** Start soft-trimming when context exceeds this ratio of context window */
  softTrimRatio: number;
  /** Start hard-clearing when context exceeds this ratio of context window */
  hardClearRatio: number;
  /** Minimum total prunable characters before pruning kicks in */
  minPrunableToolChars: number;
  /** Tool names to always prune (allowlist) */
  toolsAllowlist?: string[];
  /** Tool names to never prune (denylist) */
  toolsDenylist?: string[];
  /** Soft trim settings */
  softTrim: {
    /** Maximum characters to keep per tool result */
    maxChars: number;
    /** Characters to keep from the beginning */
    headChars: number;
    /** Characters to keep from the end */
    tailChars: number;
  };
  /** Hard clear settings */
  hardClear: {
    /** Whether to enable hard clearing */
    enabled: boolean;
    /** Placeholder text to replace cleared content */
    placeholder: string;
  };
}

/** Marker prefix added by semantic compression service */
export const SEMANTIC_COMPRESSED_MARKER = "[Semantically compressed from ";

export const DEFAULT_PRUNING_CONFIG: ContextPruningConfig = {
  mode: "adaptive",
  keepLastAssistants: 5,
  softTrimRatio: 0.7,
  hardClearRatio: 0.9,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 6_000,
    headChars: 2_000,
    tailChars: 2_000,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Content cleared to reduce context size]",
  },
};

/**
 * Build context pruning config from global config settings.
 * Merges global config with default pruning settings.
 */
export function buildPruningConfig(): ContextPruningConfig {
  const cfg = getConfig();
  const pruningCfg = cfg.agent.contextPruning;

  // Map mode strings to ContextPruningMode
  const mode: ContextPruningMode =
    pruningCfg.mode === "off"
      ? "off"
      : pruningCfg.mode === "aggressive"
        ? "aggressive"
        : pruningCfg.mode === "cache-ttl"
          ? "adaptive"
          : "adaptive";

  return {
    ...DEFAULT_PRUNING_CONFIG,
    mode,
    keepLastAssistants: pruningCfg.keepLastAssistants,
    softTrimRatio: pruningCfg.softTrimRatio,
    hardClearRatio: pruningCfg.hardClearRatio,
  };
}

export interface PruneResult {
  /** The pruned messages */
  messages: Message[];
  /** Whether any pruning was performed */
  pruned: boolean;
  /** Number of characters removed */
  charsRemoved: number;
  /** Number of tool results pruned */
  toolResultsPruned: number;
}

/**
 * Estimate tokens from character count.
 * Conservative estimate: 1 token per 4 characters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a message.
 */
export function estimateMessageTokens(msg: Message): number {
  if (msg.role === "user") {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c) => c.type === "text")
            .map((c) => (c as TextContent).text)
            .join("");
    return estimateTokens(content);
  }

  if (msg.role === "assistant") {
    const assistantMsg = msg as AssistantMessage;
    const text = assistantMsg.content
      .filter((c) => c.type === "text")
      .map((c) => (c as TextContent).text)
      .join("");
    return estimateTokens(text);
  }

  if (msg.role === "toolResult") {
    const toolMsg = msg as ToolResultMessage;
    const text = toolMsg.content
      .filter((c) => c.type === "text")
      .map((c) => (c as TextContent).text)
      .join("");
    return estimateTokens(text);
  }

  return 0;
}

/**
 * Estimate total tokens for all messages.
 */
export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Check if a tool should be pruned based on allowlist/denylist.
 */
function isToolPrunable(
  toolName: string,
  config: ContextPruningConfig,
): boolean {
  // If denylist is specified and tool is in it, don't prune
  if (config.toolsDenylist?.includes(toolName)) {
    return false;
  }

  // If allowlist is specified, only prune tools in it
  if (config.toolsAllowlist && config.toolsAllowlist.length > 0) {
    return config.toolsAllowlist.includes(toolName);
  }

  // Default: all tools are prunable
  return true;
}

/**
 * Check if a tool result was already semantically compressed.
 */
function isSemanticCompressed(msg: ToolResultMessage): boolean {
  const textContent = msg.content.find((c) => c.type === "text") as
    | TextContent
    | undefined;
  return !!textContent?.text.startsWith(SEMANTIC_COMPRESSED_MARKER);
}

/**
 * Soft-trim a tool result: keep head and tail, remove middle.
 * Skips content that was already semantically compressed.
 */
function softTrimToolResult(
  msg: ToolResultMessage,
  config: ContextPruningConfig,
): ToolResultMessage {
  const textContent = msg.content.find((c) => c.type === "text") as
    | TextContent
    | undefined;
  if (!textContent) return msg;

  // Skip re-trimming semantically compressed content — it's already dense
  if (isSemanticCompressed(msg)) {
    return msg;
  }

  const text = textContent.text;
  const { maxChars, headChars, tailChars } = config.softTrim;

  if (text.length <= maxChars) {
    return msg;
  }

  // Trim to head + ellipsis + tail
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const trimmed = `${head}\n\n... [${text.length - headChars - tailChars} characters trimmed] ...\n\n${tail}`;

  return {
    ...msg,
    content: [{ type: "text", text: trimmed }],
  };
}

/**
 * Hard-clear a tool result: replace with placeholder.
 */
function hardClearToolResult(
  msg: ToolResultMessage,
  config: ContextPruningConfig,
): ToolResultMessage {
  return {
    ...msg,
    content: [{ type: "text", text: config.hardClear.placeholder }],
  };
}

/**
 * Find the index where we should start keeping messages intact.
 * We keep the last N assistant messages and everything after.
 */
function findKeepIntactIndex(
  messages: Message[],
  keepLastAssistants: number,
): number {
  let assistantCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= keepLastAssistants) {
        return i;
      }
    }
  }

  return 0;
}

/**
 * Calculate total prunable characters in tool results.
 */
function calculatePrunableChars(
  messages: Message[],
  keepIntactIndex: number,
  config: ContextPruningConfig,
): number {
  let total = 0;

  for (let i = 0; i < keepIntactIndex; i++) {
    const msg = messages[i];
    if (
      msg.role === "toolResult" &&
      isToolPrunable((msg as ToolResultMessage).toolName, config)
    ) {
      const textContent = (msg as ToolResultMessage).content.find(
        (c) => c.type === "text",
      ) as TextContent | undefined;
      if (textContent) {
        total += textContent.text.length;
      }
    }
  }

  return total;
}

/**
 * Prune context to reduce token usage.
 *
 * Two-tier approach:
 * 1. Soft-trim: Truncate old tool results (keep head/tail)
 * 2. Hard-clear: Replace old tool results with placeholder
 */
export function pruneContext(
  messages: Message[],
  contextWindowTokens: number,
  config: ContextPruningConfig = DEFAULT_PRUNING_CONFIG,
): PruneResult {
  if (config.mode === "off") {
    return { messages, pruned: false, charsRemoved: 0, toolResultsPruned: 0 };
  }

  const currentTokens = estimateTotalTokens(messages);
  const softTrimThreshold = contextWindowTokens * config.softTrimRatio;
  const hardClearThreshold = contextWindowTokens * config.hardClearRatio;

  // Find where to start keeping messages intact
  const keepIntactIndex = findKeepIntactIndex(
    messages,
    config.keepLastAssistants,
  );

  // Calculate total prunable characters
  const prunableChars = calculatePrunableChars(
    messages,
    keepIntactIndex,
    config,
  );

  // Check if we have enough prunable content
  if (prunableChars < config.minPrunableToolChars) {
    return { messages, pruned: false, charsRemoved: 0, toolResultsPruned: 0 };
  }

  // Determine pruning level
  const needsSoftTrim = currentTokens > softTrimThreshold;
  const needsHardClear =
    currentTokens > hardClearThreshold && config.hardClear.enabled;

  if (!needsSoftTrim && config.mode !== "aggressive") {
    return { messages, pruned: false, charsRemoved: 0, toolResultsPruned: 0 };
  }

  // Clone and prune messages
  let charsRemoved = 0;
  let toolResultsPruned = 0;
  const prunedMessages = messages.map((msg, idx) => {
    // Keep recent messages intact
    if (idx >= keepIntactIndex) {
      return msg;
    }

    // Only prune tool results
    if (msg.role !== "toolResult") {
      return msg;
    }

    const toolMsg = msg as ToolResultMessage;

    // Check if this tool should be pruned
    if (!isToolPrunable(toolMsg.toolName, config)) {
      return msg;
    }

    const textContent = toolMsg.content.find((c) => c.type === "text") as
      | TextContent
      | undefined;
    if (!textContent) {
      return msg;
    }

    const originalLength = textContent.text.length;

    // Apply appropriate pruning
    let pruned: ToolResultMessage;
    if (needsHardClear) {
      pruned = hardClearToolResult(toolMsg, config);
    } else {
      pruned = softTrimToolResult(toolMsg, config);
    }

    // Track changes
    const newTextContent = pruned.content.find((c) => c.type === "text") as
      | TextContent
      | undefined;
    const newLength = newTextContent?.text.length || 0;

    if (newLength < originalLength) {
      charsRemoved += originalLength - newLength;
      toolResultsPruned++;
    }

    return pruned;
  });

  return {
    messages: prunedMessages,
    pruned: charsRemoved > 0,
    charsRemoved,
    toolResultsPruned,
  };
}

/**
 * Check if context should be compacted (Tier 2).
 * Returns true if even after pruning, context is too large.
 */
export function shouldCompact(
  messages: Message[],
  contextWindowTokens: number,
  compactionThreshold: number = 0.7,
): boolean {
  const currentTokens = estimateTotalTokens(messages);
  return currentTokens > contextWindowTokens * compactionThreshold;
}
