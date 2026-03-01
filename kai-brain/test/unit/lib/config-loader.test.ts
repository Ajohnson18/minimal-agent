import { afterEach, describe, expect, test, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UserConfigOverrides } from "../../../src/db/schema/users.js";

const ORIGINAL_ENV = { ...process.env };

async function loadConfigModule() {
  vi.resetModules();
  return import("../../../src/lib/config-loader.js");
}

describe("config-loader", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("loads config and applies env overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-test-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          agent: {
            model: {
              primary: "model-from-file",
              fallback: "fallback-file",
            },
            routing: {
              simple: "simple-file",
              medium: "medium-file",
              complex: "complex-file",
              vision: "vision-file",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.LLM_MODEL = "model-from-env";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.agent.model.primary).toBe("model-from-env");
    expect(config.agent.model.fallback).toBe("fallback-file");
    expect(config.agent.routing.simple).toBe("simple-file");

    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to defaults on invalid config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-invalid-"));
    const configPath = join(dir, "config.json");

    writeFileSync(configPath, "{invalid json", "utf-8");
    process.env.AVA_CONFIG_PATH = configPath;

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.agent.model.primary.length).toBeGreaterThan(0);
    expect(config.server.port).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });

  test("mergeUserConfig applies per-user overrides", async () => {
    process.env.AVA_CONFIG_PATH = join(process.cwd(), "test/fixtures/config.test.json");

    const { getConfig, mergeUserConfig } = await loadConfigModule();
    const global = getConfig();

    const overrides: UserConfigOverrides = {
      model: {
        primary: "user-primary",
      },
      workspace: "/tmp/work",
      timezone: "America/Los_Angeles",
      slack: {
        replyToMode: "first",
      },
    };

    const merged = mergeUserConfig(global, overrides);

    expect(merged.agent.model.primary).toBe("user-primary");
    expect(merged.agent.workspace).toBe("/tmp/work");
    expect(merged.agent.userTimezone).toBe("America/Los_Angeles");
    expect(merged.slack.replyToMode).toBe("first");
  });

  test("exposes fallback model from merged config", async () => {
    process.env.AVA_CONFIG_PATH = join(process.cwd(), "test/fixtures/config.test.json");

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(typeof config.agent.model.fallback).toBe("string");
    expect(config.agent.model.fallback.length).toBeGreaterThan(0);
  });

  test("loads tools.exec parity keys and env overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-exec-parity-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          tools: {
            exec: {
              host: "gateway",
              security: "allowlist",
              ask: "always",
              askFallback: "allowlist",
              allowlist: ["git *"],
              node: "node-a",
              pathPrepend: ["/opt/bin"],
              safeBins: ["echo"],
              backgroundMs: 1234,
              timeoutSec: 77,
              approvalRunningNoticeMs: 4567,
              safeBinTrustedDirs: ["/opt/safe-bin"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.EXEC_HOST = "sandbox";
    process.env.EXEC_TIMEOUT_SEC = "42";
    process.env.EXEC_SAFE_BIN_TRUSTED_DIRS = "/bin,/usr/bin";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.tools.exec.host).toBe("sandbox");
    expect(config.tools.exec.security).toBe("allowlist");
    expect(config.tools.exec.ask).toBe("always");
    expect(config.tools.exec.askFallback).toBe("allowlist");
    expect(config.tools.exec.allowlist).toEqual(["git *"]);
    expect(config.tools.exec.node).toBe("node-a");
    expect(config.tools.exec.pathPrepend).toEqual(["/opt/bin"]);
    expect(config.tools.exec.safeBins).toEqual(["echo"]);
    expect(config.tools.exec.backgroundMs).toBe(1234);
    expect(config.tools.exec.timeoutSec).toBe(42);
    expect(config.tools.exec.approvalRunningNoticeMs).toBe(4567);
    expect(config.tools.exec.safeBinTrustedDirs).toEqual(["/bin", "/usr/bin"]);

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads slack typing and cron concurrency overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-typing-cron-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          slack: {
            typing: {
              keepaliveMs: 5000,
              maxDurationMs: 120000,
            },
          },
          cron: {
            maxConcurrentRuns: 3,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.SLACK_TYPING_KEEPALIVE_MS = "9000";
    process.env.CRON_MAX_CONCURRENT_RUNS = "6";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.slack.typing.keepaliveMs).toBe(9000);
    expect(config.slack.typing.maxDurationMs).toBe(120000);
    expect(config.cron.maxConcurrentRuns).toBe(6);

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads gateway chat attachment limits and gateway env overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-gateway-chat-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          gateway: {
            maxBufferedBytes: 700000,
            chat: {
              toolEventMaxBytes: 12000,
              thinking: {
                streamMinIntervalMs: 250,
                textMaxChars: 9000,
                includeText: false,
              },
              attachments: {
                maxCount: 4,
                maxBytesPerAttachment: 4000000,
                maxTotalBytes: 9000000,
                maxDocumentChars: 8000,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.GATEWAY_TOOL_EVENT_MAX_BYTES = "14000";
    process.env.GATEWAY_CHAT_ATTACHMENTS_MAX_COUNT = "6";
    process.env.AVA_GATEWAY_THINKING_INCLUDE_TEXT = "1";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.gateway.maxBufferedBytes).toBe(700000);
    expect(config.gateway.chat.toolEventMaxBytes).toBe(14000);
    expect(config.gateway.chat.thinking.streamMinIntervalMs).toBe(250);
    expect(config.gateway.chat.thinking.textMaxChars).toBe(9000);
    expect(config.gateway.chat.thinking.includeText).toBe(true);
    expect(config.gateway.chat.attachments.maxCount).toBe(6);
    expect(config.gateway.chat.attachments.maxBytesPerAttachment).toBe(4000000);
    expect(config.gateway.chat.attachments.maxTotalBytes).toBe(9000000);
    expect(config.gateway.chat.attachments.maxDocumentChars).toBe(8000);

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads subagent orchestration mode and supervisor policy overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-subagent-orchestration-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          subagents: {
            orchestration: {
              mode: "supervisor",
              allowSessionOverride: false,
              supervisor: {
                maxAttempts: 2,
                baseBackoffMs: 7000,
                maxBackoffMs: 80000,
                maxWorkflowMs: 2400000,
                statusUpdateMs: 15000,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.SUBAGENT_ORCHESTRATION_MODE = "async";
    process.env.SUBAGENT_SUPERVISOR_MAX_ATTEMPTS = "5";
    process.env.SUBAGENT_SUPERVISOR_STATUS_UPDATE_MS = "45000";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.subagents.orchestration.mode).toBe("async");
    expect(config.subagents.orchestration.allowSessionOverride).toBe(false);
    expect(config.subagents.orchestration.supervisor.maxAttempts).toBe(5);
    expect(config.subagents.orchestration.supervisor.baseBackoffMs).toBe(7000);
    expect(config.subagents.orchestration.supervisor.maxBackoffMs).toBe(80000);
    expect(config.subagents.orchestration.supervisor.maxWorkflowMs).toBe(2400000);
    expect(config.subagents.orchestration.supervisor.statusUpdateMs).toBe(45000);

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads parent agent timeout and supports disabling via env override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-agent-timeout-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          agent: {
            timeoutMs: 120000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.AGENT_TIMEOUT_MS = "0";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.agent.timeoutMs).toBe(0);

    process.env.AGENT_TIMEOUT_MS = "900000";
    const { reloadConfig } = await loadConfigModule();
    const reloaded = reloadConfig();
    expect(reloaded.agent.timeoutMs).toBe(900000);

    rmSync(dir, { recursive: true, force: true });
  });

  test("fails fast when removed exec completion keys are present in config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-exec-removed-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          tools: {
            exec: {
              notifyOnExit: false,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    const { getConfig } = await loadConfigModule();
    expect(() => getConfig()).toThrow(
      "tools.exec.notifyOnExit has been removed",
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test("fails fast when removed exec completion env keys are present", async () => {
    process.env.EXEC_NOTIFY_ON_EXIT = "1";
    const { getConfig } = await loadConfigModule();
    expect(() => getConfig()).toThrow(
      "EXEC_NOTIFY_ON_EXIT has been removed",
    );
  });

  test("loads slack monitor parity keys and env overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-slack-monitor-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          slack: {
            defaultRequireMention: false,
            queueMode: "followup",
            inboundDebounceMs: 1250,
            inboundDedupeTtlMs: 120000,
            inboundDedupeMaxSize: 42,
            interactionDedupeTtlMs: 240000,
            interactionDedupeMaxSize: 84,
            missingThreadCacheTtlMs: 30000,
            missingThreadCacheMaxSize: 64,
            threadHistoryScope: "channel",
            mentionGatingMode: "explicit-only",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.SLACK_INBOUND_DEBOUNCE_MS = "2000";
    process.env.SLACK_REQUIRE_MENTION = "true";
    process.env.SLACK_QUEUE_MODE = "steer-backlog";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.slack.defaultRequireMention).toBe(true);
    expect(config.slack.queueMode).toBe("steer-backlog");
    expect(config.slack.inboundDebounceMs).toBe(2000);
    expect(config.slack.inboundDedupeTtlMs).toBe(120000);
    expect(config.slack.inboundDedupeMaxSize).toBe(42);
    expect(config.slack.interactionDedupeTtlMs).toBe(240000);
    expect(config.slack.interactionDedupeMaxSize).toBe(84);
    expect(config.slack.missingThreadCacheTtlMs).toBe(30000);
    expect(config.slack.missingThreadCacheMaxSize).toBe(64);
    expect(config.slack.threadHistoryScope).toBe("channel");
    expect(config.slack.mentionGatingMode).toBe("explicit-only");

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads heartbeat target routing config and env overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-heartbeat-target-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          heartbeat: {
            enabled: true,
            intervalMs: 60000,
            target: "slack",
            to: "channel:CFILE",
            accountId: "acct-file",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    process.env.HEARTBEAT_TARGET = "none";
    process.env.HEARTBEAT_TO = "channel:CENV";
    process.env.HEARTBEAT_ACCOUNT_ID = "acct-env";

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.heartbeat.target).toBe("none");
    expect(config.heartbeat.to).toBe("channel:CENV");
    expect(config.heartbeat.accountId).toBe("acct-env");
    expect(config.heartbeat.intervalMs).toBe(60000);

    rmSync(dir, { recursive: true, force: true });
  });

  test("defaults slack.defaultRequireMention to true", async () => {
    delete process.env.AVA_CONFIG_PATH;
    delete process.env.SLACK_REQUIRE_MENTION;

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.slack.defaultRequireMention).toBe(true);
  });

  test("maps legacy sandbox.exec policy into tools.exec when new keys are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-legacy-exec-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          sandbox: {
            exec: {
              security: "deny",
              allowlist: ["echo *"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.tools.exec.security).toBe("deny");
    expect(config.tools.exec.allowlist).toEqual(["echo *"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[config] sandbox.exec.security/allowlist is deprecated; migrate to tools.exec.security/allowlist.",
    );

    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("prefers tools.exec policy over legacy sandbox.exec policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ava-config-exec-precedence-"));
    const configPath = join(dir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          tools: {
            exec: {
              security: "allowlist",
              allowlist: ["git *"],
            },
          },
          sandbox: {
            exec: {
              security: "deny",
              allowlist: ["echo *"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    process.env.AVA_CONFIG_PATH = configPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getConfig } = await loadConfigModule();
    const config = getConfig();

    expect(config.tools.exec.security).toBe("allowlist");
    expect(config.tools.exec.allowlist).toEqual(["git *"]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[config] sandbox.exec.security/allowlist is deprecated; migrate to tools.exec.security/allowlist.",
    );

    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});
