/**
 * Config Loader
 *
 * Single source of truth for all non-secret configuration.
 * Loads from ./config.json (or AVA_CONFIG_PATH), merges with env var overrides.
 * Secrets (API keys, tokens, DB URLs) stay in env vars / .env only.
 *
 * Sync on first load (readFileSync) so module-level constants work.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Schema ──────────────────────────────────────────────────────────

const ConfigSchema = Type.Object({
  version: Type.Optional(Type.String()),

  agent: Type.Optional(
    Type.Object({
      model: Type.Optional(
        Type.Object({
          primary: Type.Optional(Type.String()),
          fallback: Type.Optional(Type.String()),
          provider: Type.Optional(Type.String()),
          embedding: Type.Optional(Type.String()),
        }),
      ),
      routing: Type.Optional(
        Type.Object({
          simple: Type.Optional(Type.String()),
          medium: Type.Optional(Type.String()),
          complex: Type.Optional(Type.String()),
          vision: Type.Optional(Type.String()),
        }),
      ),
      context: Type.Optional(
        Type.Object({
          maxTokens: Type.Optional(Type.Number()),
          compactionThreshold: Type.Optional(Type.Number()),
          maxMessagesPerSession: Type.Optional(Type.Number()),
          keepRecentMessages: Type.Optional(Type.Number()),
        }),
      ),
      timeoutMs: Type.Optional(Type.Number()),
      thinking: Type.Optional(
        Type.Object({
          default: Type.Optional(Type.String()),
          allowModelOverride: Type.Optional(Type.Boolean()),
        }),
      ),
      contextPruning: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.String()),
          keepLastAssistants: Type.Optional(Type.Number()),
          softTrimRatio: Type.Optional(Type.Number()),
          hardClearRatio: Type.Optional(Type.Number()),
        }),
      ),
      models: Type.Optional(
        Type.Object({}, { additionalProperties: true }),
      ),
      memory: Type.Optional(
        Type.Object({
          searchLimit: Type.Optional(Type.Number()),
          minScore: Type.Optional(Type.Number()),
        }),
      ),
      workspace: Type.Optional(Type.String()),
      userTimezone: Type.Optional(Type.String()),
    }),
  ),

  subagents: Type.Optional(
    Type.Object({
      models: Type.Optional(
        Type.Object({
          research: Type.Optional(Type.String()),
          analyze: Type.Optional(Type.String()),
          code: Type.Optional(Type.String()),
          general: Type.Optional(Type.String()),
        }),
      ),
      orchestration: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.String()),
          allowSessionOverride: Type.Optional(Type.Boolean()),
          supervisor: Type.Optional(
            Type.Object({
              maxAttempts: Type.Optional(Type.Number()),
              baseBackoffMs: Type.Optional(Type.Number()),
              maxBackoffMs: Type.Optional(Type.Number()),
              maxWorkflowMs: Type.Optional(Type.Number()),
              statusUpdateMs: Type.Optional(Type.Number()),
            }),
          ),
        }),
      ),
      maxDepth: Type.Optional(Type.Number()),
      maxChildren: Type.Optional(Type.Number()),
      defaultTimeoutMs: Type.Optional(Type.Number()),
      maxConcurrent: Type.Optional(Type.Number()),
      maxArchived: Type.Optional(Type.Number()),
      defaultModel: Type.Optional(Type.String()),
    }),
  ),

  slack: Type.Optional(
    Type.Object({
      ackEmoji: Type.Optional(Type.String()),
      ackReactionScope: Type.Optional(Type.String()),
      reactionNotifications: Type.Optional(Type.String()),
      defaultRequireMention: Type.Optional(Type.Boolean()),
      blockStreamingBreak: Type.Optional(Type.Boolean()),
      coalesceMinChars: Type.Optional(Type.Number()),
      coalesceIdleMs: Type.Optional(Type.Number()),
      chunkMode: Type.Optional(Type.String()),
      humanDelay: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.String()),
          minMs: Type.Optional(Type.Number()),
          maxMs: Type.Optional(Type.Number()),
        }),
      ),
      threadHistoryLimit: Type.Optional(Type.Number()),
      maxConcurrentRuns: Type.Optional(Type.Number()),
      bashEnabled: Type.Optional(Type.Boolean()),
      replyToMode: Type.Optional(Type.String()),
      queueMode: Type.Optional(Type.String()),
      inboundDebounceMs: Type.Optional(Type.Number()),
      inboundDedupeTtlMs: Type.Optional(Type.Number()),
      inboundDedupeMaxSize: Type.Optional(Type.Number()),
      interactionDedupeTtlMs: Type.Optional(Type.Number()),
      interactionDedupeMaxSize: Type.Optional(Type.Number()),
      missingThreadCacheTtlMs: Type.Optional(Type.Number()),
      missingThreadCacheMaxSize: Type.Optional(Type.Number()),
      threadHistoryScope: Type.Optional(Type.String()),
      mentionGatingMode: Type.Optional(Type.String()),
      mentionPatterns: Type.Optional(Type.Array(Type.String())),
      ttsMode: Type.Optional(Type.String()),
      nativeStreaming: Type.Optional(Type.Boolean()),
      typing: Type.Optional(
        Type.Object({
          keepaliveMs: Type.Optional(Type.Number()),
          maxDurationMs: Type.Optional(Type.Number()),
        }),
      ),
    }),
  ),

  tools: Type.Optional(
    Type.Object({
      exec: Type.Optional(
        Type.Object({
          host: Type.Optional(Type.String()),
          security: Type.Optional(Type.String()),
          ask: Type.Optional(Type.String()),
          askFallback: Type.Optional(Type.String()),
          allowlist: Type.Optional(Type.Array(Type.String())),
          node: Type.Optional(Type.String()),
          pathPrepend: Type.Optional(Type.Array(Type.String())),
          safeBins: Type.Optional(Type.Array(Type.String())),
          backgroundMs: Type.Optional(Type.Number()),
          timeoutSec: Type.Optional(Type.Number()),
          approvalRunningNoticeMs: Type.Optional(Type.Number()),
          yieldMs: Type.Optional(Type.Number()),
          maxOutputChars: Type.Optional(Type.Number()),
          jobTtlMs: Type.Optional(Type.Number()),
          maxRunning: Type.Optional(Type.Number()),
          maxFinished: Type.Optional(Type.Number()),
          safeBinTrustedDirs: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      sql: Type.Optional(
        Type.Object({
          maxRows: Type.Optional(Type.Number()),
          queryTimeoutMs: Type.Optional(Type.Number()),
        }),
      ),
      browser: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.String()),
          cdpUrl: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),

  tts: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.String()),
      voice: Type.Optional(Type.String()),
      elevenLabsVoiceId: Type.Optional(Type.String()),
    }),
  ),

  server: Type.Optional(
    Type.Object({
      port: Type.Optional(Type.Number()),
      gatewayPort: Type.Optional(Type.Number()),
      gatewayPath: Type.Optional(Type.String()),
      apiPrefix: Type.Optional(Type.String()),
      allowedOrigins: Type.Optional(Type.Array(Type.String())),
      auth: Type.Optional(
        Type.Object({
          required: Type.Optional(Type.Boolean()),
          wsAllowQueryToken: Type.Optional(Type.Boolean()),
          issuer: Type.Optional(Type.String()),
          audience: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),

  gateway: Type.Optional(
    Type.Object({
      maxBufferedBytes: Type.Optional(Type.Number()),
      chat: Type.Optional(
        Type.Object({
          toolEventMaxBytes: Type.Optional(Type.Number()),
          thinking: Type.Optional(
            Type.Object({
              streamMinIntervalMs: Type.Optional(Type.Number()),
              textMaxChars: Type.Optional(Type.Number()),
              includeText: Type.Optional(Type.Boolean()),
            }),
          ),
          attachments: Type.Optional(
            Type.Object({
              maxCount: Type.Optional(Type.Number()),
              maxBytesPerAttachment: Type.Optional(Type.Number()),
              maxTotalBytes: Type.Optional(Type.Number()),
              maxDocumentChars: Type.Optional(Type.Number()),
            }),
          ),
        }),
      ),
    }),
  ),

  heartbeat: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      intervalMs: Type.Optional(Type.Number()),
      target: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
    }),
  ),

  cron: Type.Optional(
    Type.Object({
      maxConcurrentRuns: Type.Optional(Type.Number()),
    }),
  ),

  logging: Type.Optional(
    Type.Object({
      level: Type.Optional(Type.String()),
    }),
  ),

  vertex: Type.Optional(
    Type.Object({
      location: Type.Optional(Type.String()),
      anthropicLocation: Type.Optional(Type.String()),
    }),
  ),

  users: Type.Optional(
    Type.Object({
      enforceRoles: Type.Optional(Type.Boolean()),
    }),
  ),

  sandbox: Type.Optional(
    Type.Object({
      mode: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      image: Type.Optional(Type.String()),
      memory: Type.Optional(Type.String()),
      cpus: Type.Optional(Type.String()),
      network: Type.Optional(Type.String()),
      workdir: Type.Optional(Type.String()),
      idleTimeoutMs: Type.Optional(Type.Number()),
      exec: Type.Optional(
        Type.Object({
          security: Type.Optional(Type.String()),
          allowlist: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
  ),
});

// ── Resolved config type (all defaults applied, no undefined) ───────

export interface ResolvedConfig {
  version: string;
  agent: {
    model: {
      primary: string;
      fallback: string;
      provider: string;
      embedding: string;
    };
    routing: {
      simple: string;
      medium: string;
      complex: string;
      vision: string;
    };
    context: {
      maxTokens: number;
      compactionThreshold: number;
      maxMessagesPerSession: number;
      keepRecentMessages: number;
    };
    timeoutMs: number;
    thinking: {
      default: string;
      allowModelOverride: boolean;
    };
    contextPruning: {
      mode: string;
      keepLastAssistants: number;
      softTrimRatio: number;
      hardClearRatio: number;
    };
    models: Record<string, { params?: Record<string, unknown> }>;
    memory: { searchLimit: number; minScore: number };
    workspace: string;
    userTimezone: string;
  };
  subagents: {
    models: {
      research: string;
      analyze: string;
      code: string;
      general: string;
    };
    orchestration: {
      mode: "async" | "supervisor";
      allowSessionOverride: boolean;
      supervisor: {
        maxAttempts: number;
        baseBackoffMs: number;
        maxBackoffMs: number;
        maxWorkflowMs: number;
        statusUpdateMs: number;
      };
    };
    maxDepth: number;
    maxChildren: number;
    defaultTimeoutMs: number;
    maxConcurrent: number;
    maxArchived: number;
    defaultModel: string;
  };
  slack: {
    ackEmoji: string;
    ackReactionScope: string;
    reactionNotifications: string;
    defaultRequireMention: boolean;
    blockStreamingBreak: boolean;
    coalesceMinChars: number;
    coalesceIdleMs: number;
    chunkMode: string;
    humanDelay: { mode: string; minMs: number; maxMs: number };
    threadHistoryLimit: number;
    maxConcurrentRuns: number;
    bashEnabled: boolean;
    replyToMode: string;
    queueMode: string;
    inboundDebounceMs: number;
    inboundDedupeTtlMs: number;
    inboundDedupeMaxSize: number;
    interactionDedupeTtlMs: number;
    interactionDedupeMaxSize: number;
    missingThreadCacheTtlMs: number;
    missingThreadCacheMaxSize: number;
    threadHistoryScope: "thread" | "channel";
    mentionGatingMode: string;
    mentionPatterns: string[];
    ttsMode: string;
    nativeStreaming: boolean;
    typing: {
      keepaliveMs: number;
      maxDurationMs: number;
    };
  };
  tools: {
    exec: {
      host: string;
      security: string;
      ask: string;
      askFallback: string;
      allowlist: string[];
      node: string;
      pathPrepend: string[];
      safeBins: string[];
      backgroundMs: number;
      timeoutSec: number;
      approvalRunningNoticeMs: number;
      yieldMs: number;
      maxOutputChars: number;
      jobTtlMs: number;
      maxRunning: number;
      maxFinished: number;
      safeBinTrustedDirs: string[];
    };
    sql: { maxRows: number; queryTimeoutMs: number };
    browser: { mode: string; cdpUrl: string };
  };
  tts: { provider: string; voice: string; elevenLabsVoiceId: string };
  server: {
    port: number;
    gatewayPort: number;
    gatewayPath: string;
    apiPrefix: string;
    allowedOrigins: string[];
    auth: {
      required: boolean;
      wsAllowQueryToken: boolean;
      issuer: string;
      audience: string;
    };
  };
  gateway: {
    maxBufferedBytes: number;
    chat: {
      toolEventMaxBytes: number;
      thinking: {
        streamMinIntervalMs: number;
        textMaxChars: number;
        includeText: boolean;
      };
      attachments: {
        maxCount: number;
        maxBytesPerAttachment: number;
        maxTotalBytes: number;
        maxDocumentChars: number;
      };
    };
  };
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
    target: string;
    to: string;
    accountId: string;
  };
  cron: {
    maxConcurrentRuns: number;
  };
  logging: { level: string };
  vertex: { location: string; anthropicLocation: string };
  users: { enforceRoles: boolean };
  sandbox: {
    mode: string;
    scope: string;
    image: string;
    memory: string;
    cpus: string;
    network: string;
    workdir: string;
    idleTimeoutMs: number;
    exec: {
      security: string;
      allowlist: string[];
    };
  };
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: ResolvedConfig = {
  version: "1.0",
  agent: {
    model: {
      primary: "claude-sonnet-4-5@20250929",
      fallback: "gemini-2.5-flash",
      provider: "vertex",
      embedding: "text-embedding-004",
    },
    routing: {
      simple: "gemini-2.5-flash",
      medium: "claude-sonnet-4-5@20250929",
      complex: "claude-sonnet-4-5@20250929",
      vision: "gemini-2.5-flash",
    },
    context: {
      maxTokens: 100_000,
      compactionThreshold: 50,
      maxMessagesPerSession: 500,
      keepRecentMessages: 20,
    },
    timeoutMs: 0,
    thinking: {
      default: "off",
      allowModelOverride: false,
    },
    contextPruning: {
      mode: "cache-ttl",
      keepLastAssistants: 5,
      softTrimRatio: 0.7,
      hardClearRatio: 0.9,
    },
    models: {
      "gemini-1.5-pro": {
        params: {
          temperature: 0.7,
          topP: 0.95,
        },
      },
      "gemini-2.0-flash-thinking-exp": {
        params: {
          thinking_mode: "enabled",
        },
      },
    },
    memory: { searchLimit: 10, minScore: 0.7 },
    workspace: "",
    userTimezone: "",
  },
  subagents: {
    models: {
      research: "gemini-2.5-flash",
      analyze: "gemini-2.5-pro",
      code: "gemini-2.5-flash",
      general: "gemini-2.5-flash",
    },
    orchestration: {
      mode: "async",
      allowSessionOverride: true,
      supervisor: {
        maxAttempts: 3,
        baseBackoffMs: 5_000,
        maxBackoffMs: 60_000,
        maxWorkflowMs: 3_600_000,
        statusUpdateMs: 30_000,
      },
    },
    maxDepth: 2,
    maxChildren: 5,
    defaultTimeoutMs: 0,
    maxConcurrent: 8,
    maxArchived: 100,
    defaultModel: "",
  },
  slack: {
    ackEmoji: "eyes",
    ackReactionScope: "all",
    reactionNotifications: "off",
    defaultRequireMention: true,
    blockStreamingBreak: false,
    coalesceMinChars: 1500,
    coalesceIdleMs: 1500,
    chunkMode: "",
    humanDelay: { mode: "on", minMs: 800, maxMs: 2500 },
    threadHistoryLimit: 20,
    maxConcurrentRuns: 5,
    bashEnabled: false,
    replyToMode: "all",
    queueMode: "steer-backlog",
    inboundDebounceMs: 1_500,
    inboundDedupeTtlMs: 60_000,
    inboundDedupeMaxSize: 500,
    interactionDedupeTtlMs: 300_000,
    interactionDedupeMaxSize: 1_000,
    missingThreadCacheTtlMs: 60_000,
    missingThreadCacheMaxSize: 500,
    threadHistoryScope: "thread",
    mentionGatingMode: "default",
    mentionPatterns: [],
    ttsMode: "off",
    nativeStreaming: false,
    typing: {
      keepaliveMs: 8_000,
      maxDurationMs: 600_000,
    },
  },
  tools: {
    exec: {
      host: "sandbox",
      security: "full",
      ask: "on-miss",
      askFallback: "deny",
      allowlist: [],
      node: "",
      pathPrepend: [],
      safeBins: [],
      backgroundMs: 10_000,
      timeoutSec: 1_800,
      approvalRunningNoticeMs: 10_000,
      yieldMs: 10_000,
      maxOutputChars: 200_000,
      jobTtlMs: 1_800_000,
      maxRunning: 50,
      maxFinished: 200,
      safeBinTrustedDirs: [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/sbin",
        "/usr/sbin",
      ],
    },
    sql: { maxRows: 100_000, queryTimeoutMs: 30_000 },
    browser: { mode: "local", cdpUrl: "http://localhost:9222" },
  },
  tts: {
    provider: "openai",
    voice: "alloy",
    elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
  },
  server: {
    port: 3001,
    gatewayPort: 18789,
    gatewayPath: "/ws",
    apiPrefix: "/api/ava",
    allowedOrigins: ["http://localhost:3000"],
    auth: {
      required: true,
      wsAllowQueryToken: true,
      issuer: "",
      audience: "",
    },
  },
  gateway: {
    maxBufferedBytes: 524_288,
    chat: {
      toolEventMaxBytes: 64 * 1024,
      thinking: {
        streamMinIntervalMs: 120,
        textMaxChars: 12_000,
        includeText: false,
      },
      attachments: {
        maxCount: 8,
        maxBytesPerAttachment: 5_000_000,
        maxTotalBytes: 15_000_000,
        maxDocumentChars: 12_000,
      },
    },
  },
  heartbeat: {
    enabled: true,
    intervalMs: 1_800_000,
    target: "last",
    to: "",
    accountId: "",
  },
  cron: {
    maxConcurrentRuns: 4,
  },
  logging: { level: "info" },
  vertex: { location: "us-central1", anthropicLocation: "us-east5" },
  users: { enforceRoles: false },
  sandbox: {
    mode: "off",
    scope: "user",
    image: "ava-sandbox-exec",
    memory: "512m",
    cpus: "1",
    network: "none",
    workdir: "/workspace",
    idleTimeoutMs: 1_800_000,
    exec: {
      security: "full",
      allowlist: [],
    },
  },
};

// ── Loading ─────────────────────────────────────────────────────────

let cachedConfig: ResolvedConfig | null = null;
const REMOVED_EXEC_CONFIG_KEYS = ["notifyOnExit", "notifyOnExitEmptySuccess"] as const;
const REMOVED_EXEC_ENV_KEYS = [
  "EXEC_NOTIFY_ON_EXIT",
  "EXEC_NOTIFY_ON_EXIT_EMPTY_SUCCESS",
] as const;

function getConfigPath(): string {
  if (process.env.AVA_CONFIG_PATH) return process.env.AVA_CONFIG_PATH;
  return join(process.cwd(), "config.json");
}

function assertNoRemovedExecEnvKeys(): void {
  for (const key of REMOVED_EXEC_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      throw new Error(
        `[config] ${key} has been removed. Use per-call exec completionPolicy (relay/relevance/reason) instead.`,
      );
    }
  }
}

function assertNoRemovedExecConfigKeys(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const root = raw as {
    tools?: {
      exec?: Record<string, unknown>;
    };
  };
  const execConfig = root.tools?.exec;
  if (!execConfig || typeof execConfig !== "object") return;

  for (const key of REMOVED_EXEC_CONFIG_KEYS) {
    if (key in execConfig) {
      throw new Error(
        `[config] tools.exec.${key} has been removed. Use per-call exec completionPolicy (relay/relevance/reason) instead.`,
      );
    }
  }
}

function loadConfigFromFile(): Static<typeof ConfigSchema> | null {
  const configPath = getConfigPath();
  try {
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    assertNoRemovedExecConfigKeys(parsed);
    if (!Value.Check(ConfigSchema, parsed)) {
      const errors = [...Value.Errors(ConfigSchema, parsed)];
      console.warn(
        "[config] Validation failed, using defaults:",
        errors.map((e) => `${e.path}: ${e.message}`).join(", "),
      );
      return null;
    }
    return parsed as Static<typeof ConfigSchema>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("has been removed")
    ) {
      throw error;
    }
    console.warn(
      "[config] Failed to load config file:",
      (error as Error).message,
    );
    return null;
  }
}

function intEnv(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function floatEnv(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

function boolEnv(key: string): boolean | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  return v === "true" || v === "1";
}

/** Read a string env var, stripping any inline comment (# …) and trimming whitespace. */
function strEnv(key: string): string | undefined {
  const val = process.env[key]?.split("#")[0].trim();
  return val || undefined;
}

function csvEnv(key: string): string[] | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeSubagentOrchestrationMode(value: string | undefined): "async" | "supervisor" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "supervisor") {
    return "supervisor";
  }
  return "async";
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value as number));
}

const warnedDeprecations = new Set<string>();

function warnDeprecationOnce(key: string, message: string): void {
  if (warnedDeprecations.has(key)) return;
  warnedDeprecations.add(key);
  console.warn(message);
}

function resolve(file: Static<typeof ConfigSchema> | null): ResolvedConfig {
  const f = file;
  const d = DEFAULTS;

  const agent = f?.agent;
  const sub = f?.subagents;
  const slack = f?.slack;
  const tools = f?.tools;
  const tts = f?.tts;
  const server = f?.server;
  const gateway = f?.gateway;
  const hb = f?.heartbeat;
  const crn = f?.cron;
  const log = f?.logging;
  const vtx = f?.vertex;
  const usr = f?.users;
  const sbx = f?.sandbox;
  const legacyExecSecurity = sbx?.exec?.security;
  const legacyExecAllowlist = sbx?.exec?.allowlist;
  const legacyExecConfigured =
    legacyExecSecurity !== undefined || legacyExecAllowlist !== undefined;
  const newExecPolicyConfigured =
    tools?.exec?.security !== undefined || tools?.exec?.allowlist !== undefined;

  if (legacyExecConfigured && !newExecPolicyConfigured) {
    warnDeprecationOnce(
      "sandbox.exec.policy",
      "[config] sandbox.exec.security/allowlist is deprecated; migrate to tools.exec.security/allowlist.",
    );
  }

  return {
    version: f?.version ?? d.version,
    agent: {
      model: {
        primary:
          strEnv("LLM_MODEL") ??
          agent?.model?.primary ??
          d.agent.model.primary,
        fallback:
          strEnv("LLM_FALLBACK_MODEL") ??
          agent?.model?.fallback ??
          d.agent.model.fallback,
        provider:
          strEnv("LLM_PROVIDER") ??
          agent?.model?.provider ??
          d.agent.model.provider,
        embedding:
          process.env.EMBEDDING_MODEL ??
          agent?.model?.embedding ??
          d.agent.model.embedding,
      },
      routing: {
        simple: agent?.routing?.simple ?? d.agent.routing.simple,
        medium: agent?.routing?.medium ?? d.agent.routing.medium,
        complex: agent?.routing?.complex ?? d.agent.routing.complex,
        vision: agent?.routing?.vision ?? d.agent.routing.vision,
      },
      context: {
        maxTokens:
          intEnv("MAX_CONTEXT_TOKENS") ??
          agent?.context?.maxTokens ??
          d.agent.context.maxTokens,
        compactionThreshold:
          intEnv("COMPACTION_THRESHOLD") ??
          agent?.context?.compactionThreshold ??
          d.agent.context.compactionThreshold,
        maxMessagesPerSession:
          intEnv("MAX_MESSAGES_PER_SESSION") ??
          agent?.context?.maxMessagesPerSession ??
          d.agent.context.maxMessagesPerSession,
        keepRecentMessages:
          intEnv("KEEP_RECENT_MESSAGES") ??
          agent?.context?.keepRecentMessages ??
          d.agent.context.keepRecentMessages,
      },
      timeoutMs: normalizeNonNegativeInt(
        intEnv("AGENT_TIMEOUT_MS") ??
          agent?.timeoutMs ??
          d.agent.timeoutMs,
        d.agent.timeoutMs,
      ),
      thinking: {
        default:
          process.env.THINKING_MODE ??
          agent?.thinking?.default ??
          d.agent.thinking.default,
        allowModelOverride:
          boolEnv("THINKING_ALLOW_OVERRIDE") ??
          agent?.thinking?.allowModelOverride ??
          d.agent.thinking.allowModelOverride,
      },
      contextPruning: {
        mode:
          process.env.CONTEXT_PRUNING_MODE ??
          agent?.contextPruning?.mode ??
          d.agent.contextPruning.mode,
        keepLastAssistants:
          intEnv("CONTEXT_KEEP_LAST_ASSISTANTS") ??
          agent?.contextPruning?.keepLastAssistants ??
          d.agent.contextPruning.keepLastAssistants,
        softTrimRatio:
          floatEnv("CONTEXT_SOFT_TRIM_RATIO") ??
          agent?.contextPruning?.softTrimRatio ??
          d.agent.contextPruning.softTrimRatio,
        hardClearRatio:
          floatEnv("CONTEXT_HARD_CLEAR_RATIO") ??
          agent?.contextPruning?.hardClearRatio ??
          d.agent.contextPruning.hardClearRatio,
      },
      models: (() => {
        const base = { ...d.agent.models, ...(agent?.models || {}) };
        // Parse MODEL_PARAMS_* env vars
        const envParams = Object.entries(process.env)
          .filter(([key]) => key.startsWith("MODEL_PARAMS_"))
          .reduce((acc, [key, value]) => {
            const modelId = key.replace("MODEL_PARAMS_", "").toLowerCase().replace(/_/g, "-");
            try {
              acc[modelId] = { params: JSON.parse(value || "{}") };
            } catch {
              console.warn(`[config] Invalid JSON in ${key}, ignoring`);
            }
            return acc;
          }, {} as Record<string, { params?: Record<string, unknown> }>);
        return { ...base, ...envParams };
      })(),
      memory: {
        searchLimit:
          intEnv("MEMORY_SEARCH_LIMIT") ??
          agent?.memory?.searchLimit ??
          d.agent.memory.searchLimit,
        minScore:
          floatEnv("MEMORY_MIN_SCORE") ??
          agent?.memory?.minScore ??
          d.agent.memory.minScore,
      },
      workspace:
        process.env.AVA_WORKSPACE_DIR ?? agent?.workspace ?? d.agent.workspace,
      userTimezone:
        process.env.USER_TIMEZONE ??
        agent?.userTimezone ??
        d.agent.userTimezone,
    },
    subagents: {
      models: {
        research: sub?.models?.research ?? d.subagents.models.research,
        analyze: sub?.models?.analyze ?? d.subagents.models.analyze,
        code: sub?.models?.code ?? d.subagents.models.code,
        general: sub?.models?.general ?? d.subagents.models.general,
      },
      orchestration: {
        mode: normalizeSubagentOrchestrationMode(
          process.env.SUBAGENT_ORCHESTRATION_MODE ??
            sub?.orchestration?.mode ??
            d.subagents.orchestration.mode,
        ),
        allowSessionOverride:
          boolEnv("SUBAGENT_ORCHESTRATION_ALLOW_SESSION_OVERRIDE") ??
          sub?.orchestration?.allowSessionOverride ??
          d.subagents.orchestration.allowSessionOverride,
        supervisor: {
          maxAttempts: Math.max(
            1,
            intEnv("SUBAGENT_SUPERVISOR_MAX_ATTEMPTS") ??
              sub?.orchestration?.supervisor?.maxAttempts ??
              d.subagents.orchestration.supervisor.maxAttempts,
          ),
          baseBackoffMs: Math.max(
            1_000,
            intEnv("SUBAGENT_SUPERVISOR_BASE_BACKOFF_MS") ??
              sub?.orchestration?.supervisor?.baseBackoffMs ??
              d.subagents.orchestration.supervisor.baseBackoffMs,
          ),
          maxBackoffMs: Math.max(
            1_000,
            intEnv("SUBAGENT_SUPERVISOR_MAX_BACKOFF_MS") ??
              sub?.orchestration?.supervisor?.maxBackoffMs ??
              d.subagents.orchestration.supervisor.maxBackoffMs,
          ),
          maxWorkflowMs: Math.max(
            60_000,
            intEnv("SUBAGENT_SUPERVISOR_MAX_WORKFLOW_MS") ??
              sub?.orchestration?.supervisor?.maxWorkflowMs ??
              d.subagents.orchestration.supervisor.maxWorkflowMs,
          ),
          statusUpdateMs: Math.max(
            5_000,
            intEnv("SUBAGENT_SUPERVISOR_STATUS_UPDATE_MS") ??
              sub?.orchestration?.supervisor?.statusUpdateMs ??
              d.subagents.orchestration.supervisor.statusUpdateMs,
          ),
        },
      },
      maxDepth:
        intEnv("SUBAGENT_MAX_DEPTH") ?? sub?.maxDepth ?? d.subagents.maxDepth,
      maxChildren:
        intEnv("SUBAGENT_MAX_CHILDREN") ??
        sub?.maxChildren ??
        d.subagents.maxChildren,
      defaultTimeoutMs:
        intEnv("SUBAGENT_DEFAULT_TIMEOUT_MS") ??
        sub?.defaultTimeoutMs ??
        d.subagents.defaultTimeoutMs,
      maxConcurrent:
        intEnv("SUBAGENT_MAX_CONCURRENT") ??
        sub?.maxConcurrent ??
        d.subagents.maxConcurrent,
      maxArchived:
        intEnv("SUBAGENT_MAX_ARCHIVED") ??
        sub?.maxArchived ??
        d.subagents.maxArchived,
      defaultModel:
        strEnv("SUBAGENT_DEFAULT_MODEL") ??
        sub?.defaultModel ??
        d.subagents.defaultModel,
    },
    slack: {
      ackEmoji:
        process.env.SLACK_ACK_EMOJI ?? slack?.ackEmoji ?? d.slack.ackEmoji,
      ackReactionScope:
        process.env.SLACK_ACK_REACTION_SCOPE ??
        slack?.ackReactionScope ??
        d.slack.ackReactionScope,
      reactionNotifications:
        process.env.SLACK_REACTION_NOTIFICATIONS ??
        slack?.reactionNotifications ??
        d.slack.reactionNotifications,
      defaultRequireMention:
        boolEnv("SLACK_REQUIRE_MENTION") ??
        slack?.defaultRequireMention ??
        d.slack.defaultRequireMention,
      blockStreamingBreak:
        boolEnv("SLACK_BLOCK_STREAMING_BREAK") ??
        slack?.blockStreamingBreak ??
        d.slack.blockStreamingBreak,
      coalesceMinChars:
        intEnv("SLACK_COALESCE_MIN_CHARS") ??
        slack?.coalesceMinChars ??
        d.slack.coalesceMinChars,
      coalesceIdleMs:
        intEnv("SLACK_COALESCE_IDLE_MS") ??
        slack?.coalesceIdleMs ??
        d.slack.coalesceIdleMs,
      chunkMode:
        process.env.SLACK_CHUNK_MODE ?? slack?.chunkMode ?? d.slack.chunkMode,
      humanDelay: {
        mode:
          process.env.SLACK_HUMAN_DELAY_MODE ??
          slack?.humanDelay?.mode ??
          d.slack.humanDelay.mode,
        minMs:
          intEnv("SLACK_HUMAN_DELAY_MIN_MS") ??
          slack?.humanDelay?.minMs ??
          d.slack.humanDelay.minMs,
        maxMs:
          intEnv("SLACK_HUMAN_DELAY_MAX_MS") ??
          slack?.humanDelay?.maxMs ??
          d.slack.humanDelay.maxMs,
      },
      threadHistoryLimit:
        intEnv("SLACK_THREAD_HISTORY_LIMIT") ??
        slack?.threadHistoryLimit ??
        d.slack.threadHistoryLimit,
      maxConcurrentRuns:
        intEnv("MAX_CONCURRENT_AGENT_RUNS") ??
        slack?.maxConcurrentRuns ??
        d.slack.maxConcurrentRuns,
      bashEnabled:
        boolEnv("SLACK_BASH_ENABLED") ??
        slack?.bashEnabled ??
        d.slack.bashEnabled,
      replyToMode:
        process.env.SLACK_REPLY_TO_MODE ??
        slack?.replyToMode ??
        d.slack.replyToMode,
      queueMode:
        process.env.SLACK_QUEUE_MODE ??
        slack?.queueMode ??
        d.slack.queueMode,
      inboundDebounceMs:
        intEnv("SLACK_INBOUND_DEBOUNCE_MS") ??
        slack?.inboundDebounceMs ??
        d.slack.inboundDebounceMs,
      inboundDedupeTtlMs:
        intEnv("SLACK_INBOUND_DEDUPE_TTL_MS") ??
        slack?.inboundDedupeTtlMs ??
        d.slack.inboundDedupeTtlMs,
      inboundDedupeMaxSize:
        intEnv("SLACK_INBOUND_DEDUPE_MAX_SIZE") ??
        slack?.inboundDedupeMaxSize ??
        d.slack.inboundDedupeMaxSize,
      interactionDedupeTtlMs:
        intEnv("SLACK_INTERACTION_DEDUPE_TTL_MS") ??
        slack?.interactionDedupeTtlMs ??
        d.slack.interactionDedupeTtlMs,
      interactionDedupeMaxSize:
        intEnv("SLACK_INTERACTION_DEDUPE_MAX_SIZE") ??
        slack?.interactionDedupeMaxSize ??
        d.slack.interactionDedupeMaxSize,
      missingThreadCacheTtlMs:
        intEnv("SLACK_MISSING_THREAD_CACHE_TTL_MS") ??
        slack?.missingThreadCacheTtlMs ??
        d.slack.missingThreadCacheTtlMs,
      missingThreadCacheMaxSize:
        intEnv("SLACK_MISSING_THREAD_CACHE_MAX_SIZE") ??
        slack?.missingThreadCacheMaxSize ??
        d.slack.missingThreadCacheMaxSize,
      threadHistoryScope:
        process.env.SLACK_THREAD_HISTORY_SCOPE === "channel"
          ? "channel"
          : process.env.SLACK_THREAD_HISTORY_SCOPE === "thread"
            ? "thread"
            : slack?.threadHistoryScope === "channel"
              ? "channel"
              : d.slack.threadHistoryScope,
      mentionGatingMode:
        process.env.SLACK_MENTION_GATING_MODE ??
        slack?.mentionGatingMode ??
        d.slack.mentionGatingMode,
      mentionPatterns: slack?.mentionPatterns ?? d.slack.mentionPatterns,
      ttsMode: process.env.SLACK_TTS_MODE ?? slack?.ttsMode ?? d.slack.ttsMode,
      nativeStreaming:
        boolEnv("SLACK_NATIVE_STREAMING") ??
        slack?.nativeStreaming ??
        d.slack.nativeStreaming,
      typing: {
        keepaliveMs:
          intEnv("SLACK_TYPING_KEEPALIVE_MS") ??
          slack?.typing?.keepaliveMs ??
          d.slack.typing.keepaliveMs,
        maxDurationMs:
          intEnv("SLACK_TYPING_MAX_DURATION_MS") ??
          slack?.typing?.maxDurationMs ??
          d.slack.typing.maxDurationMs,
      },
    },
    tools: {
      exec: {
        host:
          process.env.EXEC_HOST ??
          tools?.exec?.host ??
          d.tools.exec.host,
        security:
          process.env.EXEC_SECURITY ??
          tools?.exec?.security ??
          process.env.SANDBOX_EXEC_SECURITY ??
          legacyExecSecurity ??
          d.tools.exec.security,
        ask:
          process.env.EXEC_ASK ??
          tools?.exec?.ask ??
          d.tools.exec.ask,
        askFallback:
          process.env.EXEC_ASK_FALLBACK ??
          tools?.exec?.askFallback ??
          d.tools.exec.askFallback,
        allowlist:
          csvEnv("EXEC_ALLOWLIST") ??
          tools?.exec?.allowlist ??
          legacyExecAllowlist ??
          d.tools.exec.allowlist,
        node:
          process.env.EXEC_NODE ??
          tools?.exec?.node ??
          d.tools.exec.node,
        pathPrepend:
          csvEnv("EXEC_PATH_PREPEND") ??
          tools?.exec?.pathPrepend ??
          d.tools.exec.pathPrepend,
        safeBins:
          csvEnv("EXEC_SAFE_BINS") ??
          tools?.exec?.safeBins ??
          d.tools.exec.safeBins,
        backgroundMs:
          intEnv("EXEC_BACKGROUND_MS") ??
          tools?.exec?.backgroundMs ??
          d.tools.exec.backgroundMs,
        timeoutSec:
          intEnv("EXEC_TIMEOUT_SEC") ??
          tools?.exec?.timeoutSec ??
          d.tools.exec.timeoutSec,
        approvalRunningNoticeMs:
          intEnv("EXEC_APPROVAL_RUNNING_NOTICE_MS") ??
          tools?.exec?.approvalRunningNoticeMs ??
          d.tools.exec.approvalRunningNoticeMs,
        yieldMs:
          intEnv("EXEC_YIELD_MS") ??
          tools?.exec?.yieldMs ??
          d.tools.exec.yieldMs,
        maxOutputChars:
          intEnv("EXEC_MAX_OUTPUT_CHARS") ??
          tools?.exec?.maxOutputChars ??
          d.tools.exec.maxOutputChars,
        jobTtlMs:
          intEnv("PROCESS_JOB_TTL_MS") ??
          tools?.exec?.jobTtlMs ??
          d.tools.exec.jobTtlMs,
        maxRunning:
          intEnv("PROCESS_MAX_RUNNING") ??
          tools?.exec?.maxRunning ??
          d.tools.exec.maxRunning,
        maxFinished:
          intEnv("PROCESS_MAX_FINISHED") ??
          tools?.exec?.maxFinished ??
          d.tools.exec.maxFinished,
        safeBinTrustedDirs:
          csvEnv("EXEC_SAFE_BIN_TRUSTED_DIRS") ??
          tools?.exec?.safeBinTrustedDirs ??
          d.tools.exec.safeBinTrustedDirs,
      },
      sql: {
        maxRows:
          intEnv("SQL_MAX_ROWS") ?? tools?.sql?.maxRows ?? d.tools.sql.maxRows,
        queryTimeoutMs:
          intEnv("SQL_QUERY_TIMEOUT_MS") ??
          tools?.sql?.queryTimeoutMs ??
          d.tools.sql.queryTimeoutMs,
      },
      browser: {
        mode:
          process.env.BROWSER_MODE ??
          tools?.browser?.mode ??
          d.tools.browser.mode,
        cdpUrl:
          process.env.BROWSER_CDP_URL ??
          tools?.browser?.cdpUrl ??
          d.tools.browser.cdpUrl,
      },
    },
    tts: {
      provider: process.env.TTS_PROVIDER ?? tts?.provider ?? d.tts.provider,
      voice: process.env.TTS_VOICE ?? tts?.voice ?? d.tts.voice,
      elevenLabsVoiceId:
        process.env.ELEVENLABS_VOICE_ID ??
        tts?.elevenLabsVoiceId ??
        d.tts.elevenLabsVoiceId,
    },
    server: {
      port: intEnv("PORT") ?? server?.port ?? d.server.port,
      gatewayPort:
        intEnv("GATEWAY_PORT") ?? server?.gatewayPort ?? d.server.gatewayPort,
      gatewayPath:
        process.env.GATEWAY_PATH ?? server?.gatewayPath ?? d.server.gatewayPath,
      apiPrefix:
        process.env.API_PREFIX ?? server?.apiPrefix ?? d.server.apiPrefix,
      allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
        : (server?.allowedOrigins ?? d.server.allowedOrigins),
      auth: {
        required:
          boolEnv("AVA_AUTH_REQUIRED") ??
          server?.auth?.required ??
          d.server.auth.required,
        wsAllowQueryToken:
          boolEnv("AVA_WS_ALLOW_QUERY_TOKEN") ??
          server?.auth?.wsAllowQueryToken ??
          d.server.auth.wsAllowQueryToken,
        issuer:
          process.env.AVA_AUTH_ISSUER ??
          server?.auth?.issuer ??
          d.server.auth.issuer,
        audience:
          process.env.AVA_AUTH_AUDIENCE ??
          server?.auth?.audience ??
          d.server.auth.audience,
      },
    },
    gateway: {
      maxBufferedBytes: Math.max(
        64_000,
        intEnv("GATEWAY_MAX_BUFFERED_BYTES") ??
          intEnv("AVA_GATEWAY_MAX_BUFFERED_BYTES") ??
          gateway?.maxBufferedBytes ??
          d.gateway.maxBufferedBytes,
      ),
      chat: {
        toolEventMaxBytes: Math.max(
          4 * 1024,
          intEnv("GATEWAY_TOOL_EVENT_MAX_BYTES") ??
            intEnv("AVA_GATEWAY_TOOL_EVENT_MAX_BYTES") ??
            gateway?.chat?.toolEventMaxBytes ??
            d.gateway.chat.toolEventMaxBytes,
        ),
        thinking: {
          streamMinIntervalMs: Math.max(
            0,
            intEnv("GATEWAY_THINKING_STREAM_MIN_INTERVAL_MS") ??
              intEnv("AVA_GATEWAY_THINKING_STREAM_MIN_INTERVAL_MS") ??
              gateway?.chat?.thinking?.streamMinIntervalMs ??
              d.gateway.chat.thinking.streamMinIntervalMs,
          ),
          textMaxChars: Math.max(
            512,
            intEnv("GATEWAY_THINKING_TEXT_MAX_CHARS") ??
              intEnv("AVA_GATEWAY_THINKING_TEXT_MAX_CHARS") ??
              gateway?.chat?.thinking?.textMaxChars ??
              d.gateway.chat.thinking.textMaxChars,
          ),
          includeText:
            boolEnv("GATEWAY_THINKING_INCLUDE_TEXT") ??
            boolEnv("AVA_GATEWAY_THINKING_INCLUDE_TEXT") ??
            gateway?.chat?.thinking?.includeText ??
            d.gateway.chat.thinking.includeText,
        },
        attachments: {
          maxCount: Math.max(
            1,
            intEnv("GATEWAY_CHAT_ATTACHMENTS_MAX_COUNT") ??
              intEnv("AVA_GATEWAY_CHAT_ATTACHMENTS_MAX_COUNT") ??
              gateway?.chat?.attachments?.maxCount ??
              d.gateway.chat.attachments.maxCount,
          ),
          maxBytesPerAttachment: Math.max(
            1,
            intEnv("GATEWAY_CHAT_ATTACHMENTS_MAX_BYTES_PER_ATTACHMENT") ??
              intEnv("AVA_GATEWAY_CHAT_ATTACHMENTS_MAX_BYTES_PER_ATTACHMENT") ??
              gateway?.chat?.attachments?.maxBytesPerAttachment ??
              d.gateway.chat.attachments.maxBytesPerAttachment,
          ),
          maxTotalBytes: Math.max(
            1,
            intEnv("GATEWAY_CHAT_ATTACHMENTS_MAX_TOTAL_BYTES") ??
              intEnv("AVA_GATEWAY_CHAT_ATTACHMENTS_MAX_TOTAL_BYTES") ??
              gateway?.chat?.attachments?.maxTotalBytes ??
              d.gateway.chat.attachments.maxTotalBytes,
          ),
          maxDocumentChars: Math.max(
            256,
            intEnv("GATEWAY_CHAT_ATTACHMENTS_MAX_DOCUMENT_CHARS") ??
              intEnv("AVA_GATEWAY_CHAT_ATTACHMENTS_MAX_DOCUMENT_CHARS") ??
              gateway?.chat?.attachments?.maxDocumentChars ??
              d.gateway.chat.attachments.maxDocumentChars,
          ),
        },
      },
    },
    heartbeat: {
      enabled:
        process.env.HEARTBEAT_ENABLED !== undefined
          ? process.env.HEARTBEAT_ENABLED !== "false"
          : (hb?.enabled ?? d.heartbeat.enabled),
      intervalMs:
        intEnv("HEARTBEAT_INTERVAL_MS") ??
        hb?.intervalMs ??
        d.heartbeat.intervalMs,
      target:
        process.env.HEARTBEAT_TARGET ??
        hb?.target ??
        d.heartbeat.target,
      to:
        process.env.HEARTBEAT_TO ??
        hb?.to ??
        d.heartbeat.to,
      accountId:
        process.env.HEARTBEAT_ACCOUNT_ID ??
        hb?.accountId ??
        d.heartbeat.accountId,
    },
    cron: {
      maxConcurrentRuns:
        intEnv("CRON_MAX_CONCURRENT_RUNS") ??
        crn?.maxConcurrentRuns ??
        d.cron.maxConcurrentRuns,
    },
    logging: {
      level: process.env.LOG_LEVEL ?? log?.level ?? d.logging.level,
    },
    vertex: {
      location:
        process.env.VERTEX_AI_LOCATION ?? vtx?.location ?? d.vertex.location,
      anthropicLocation:
        process.env.VERTEX_ANTHROPIC_LOCATION ??
        vtx?.anthropicLocation ??
        d.vertex.anthropicLocation,
    },
    users: {
      enforceRoles:
        boolEnv("AVA_ENFORCE_ROLES") ?? usr?.enforceRoles ?? d.users.enforceRoles,
    },
    sandbox: {
      mode:
        process.env.SANDBOX_MODE ?? sbx?.mode ?? d.sandbox.mode,
      scope:
        process.env.SANDBOX_SCOPE ?? sbx?.scope ?? d.sandbox.scope,
      image:
        process.env.SANDBOX_IMAGE ?? sbx?.image ?? d.sandbox.image,
      memory:
        process.env.SANDBOX_MEMORY ?? sbx?.memory ?? d.sandbox.memory,
      cpus:
        process.env.SANDBOX_CPUS ?? sbx?.cpus ?? d.sandbox.cpus,
      network:
        process.env.SANDBOX_NETWORK ?? sbx?.network ?? d.sandbox.network,
      workdir:
        process.env.SANDBOX_WORKDIR ?? sbx?.workdir ?? d.sandbox.workdir,
      idleTimeoutMs:
        intEnv("SANDBOX_IDLE_TIMEOUT_MS") ?? sbx?.idleTimeoutMs ?? d.sandbox.idleTimeoutMs,
      exec: {
        security:
          process.env.SANDBOX_EXEC_SECURITY ?? sbx?.exec?.security ?? d.sandbox.exec.security,
        allowlist:
          sbx?.exec?.allowlist ?? d.sandbox.exec.allowlist,
      },
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────

export function getConfig(): ResolvedConfig {
  assertNoRemovedExecEnvKeys();
  if (cachedConfig) return cachedConfig;
  const file = loadConfigFromFile();
  cachedConfig = resolve(file);
  return cachedConfig;
}

export function reloadConfig(): ResolvedConfig {
  cachedConfig = null;
  return getConfig();
}

// Convenience accessors used by routing/subagent callers.

export function getModelForComplexity(
  complexity: "simple" | "medium" | "complex" | "vision",
): string | null {
  return getConfig().agent.routing[complexity] || null;
}

export function getModelForSubagent(
  type: "research" | "analyze" | "code" | "general",
): string | null {
  return getConfig().subagents.models[type] || null;
}

export type { ResolvedConfig as Config };

// ── Per-user config merging ────────────────────────────────────────

import type { UserConfigOverrides } from "../db/schema/users.js";

/**
 * Merge per-user config overrides on top of the global resolved config.
 * Returns a shallow copy with user overrides applied.
 */
export function mergeUserConfig(
  global: ResolvedConfig,
  user: UserConfigOverrides | undefined | null,
): ResolvedConfig {
  if (!user) return global;

  return {
    ...global,
    agent: {
      ...global.agent,
      model: {
        ...global.agent.model,
        ...(user.model?.primary ? { primary: user.model.primary } : {}),
        ...(user.model?.fallback ? { fallback: user.model.fallback } : {}),
      },
      workspace: user.workspace || global.agent.workspace,
      userTimezone: user.timezone || global.agent.userTimezone,
    },
    slack: {
      ...global.slack,
      ...(user.slack?.replyToMode ? { replyToMode: user.slack.replyToMode } : {}),
    },
  };
}
