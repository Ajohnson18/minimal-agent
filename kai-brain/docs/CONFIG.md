# AVA Configuration

Runtime config is loaded by `src/lib/config-loader.ts`.

Primary reference files:

- `config.example.json`
- `src/lib/config-loader.ts`

## Resolution Order

Config values are resolved in this order:

1. Environment variables
2. `config.json` (usually `~/.ava/config.json` or `AVA_CONFIG_PATH`)
3. Built-in defaults in `config-loader`

## High-Impact Options

### Subagents

Key fields:

- `subagents.maxDepth` (default `2`)
- `subagents.maxChildren` (default `5`)
- `subagents.maxConcurrent` (default `8`)
- `subagents.defaultTimeoutMs` (default `0`)
- `subagents.orchestration.mode` (default `async`)
- `subagents.orchestration.allowSessionOverride` (default `true`)
- `subagents.orchestration.supervisor.*` (retry/backoff/workflow controls for supervisor mode)

Behavior notes:

- `defaultTimeoutMs: 0` means no forced timeout by default.
- Positive values are clamped to runtime safety bounds.
- `spawn_subagent.timeout` follows the same behavior and accepts `0` to disable timeout.
- `orchestration.mode: async` is the baseline delegated non-blocking flow.
- `orchestration.mode: supervisor` runs subagents in-band: parent waits, retries by supervisor policy, and receives child output directly.
- Supervisor mode forces child announce behavior to internal (`silent`) so child runs do not post directly to Slack/user channels.
- Async mode uses registry + announce pipeline (`ava_subagent_runs` + direct/heartbeat fallback) and supports `list/status/steer/kill`.
- Session override is available via Slack: `/flow mode <async|supervisor|default>`.

Env override:

- `SUBAGENT_DEFAULT_TIMEOUT_MS`
- `SUBAGENT_ORCHESTRATION_MODE`
- `SUBAGENT_ORCHESTRATION_ALLOW_SESSION_OVERRIDE`
- `SUBAGENT_SUPERVISOR_MAX_ATTEMPTS`
- `SUBAGENT_SUPERVISOR_BASE_BACKOFF_MS`
- `SUBAGENT_SUPERVISOR_MAX_BACKOFF_MS`
- `SUBAGENT_SUPERVISOR_MAX_WORKFLOW_MS`
- `SUBAGENT_SUPERVISOR_STATUS_UPDATE_MS`

### Parent Agent Runtime Timeout

Key field:

- `agent.timeoutMs` (default `0`)

Behavior notes:

- `0` disables forced parent-run timeout.
- Positive values apply a hard timeout to one parent run.
- Parent timeout is independent of tool-specific timeouts.

Env override:

- `AGENT_TIMEOUT_MS`

### Gateway Chat + Attachments

Key fields:

- `gateway.maxBufferedBytes`
- `gateway.chat.toolEventMaxBytes`
- `gateway.chat.thinking.streamMinIntervalMs`
- `gateway.chat.thinking.textMaxChars`
- `gateway.chat.thinking.includeText`
- `gateway.chat.attachments.maxCount`
- `gateway.chat.attachments.maxBytesPerAttachment`
- `gateway.chat.attachments.maxTotalBytes`
- `gateway.chat.attachments.maxDocumentChars`

Behavior notes:

- `gateway.chat.attachments.*` controls hard limits enforced at `chat.send` entry.
- `gateway.chat.thinking.includeText` controls whether cumulative `agent.thinking.data.text`
  is emitted alongside deltas.
- `gateway.maxBufferedBytes` controls slow-client backpressure drop threshold in WS runtime.

Env overrides (preferred neutral names):

- `GATEWAY_MAX_BUFFERED_BYTES`
- `GATEWAY_TOOL_EVENT_MAX_BYTES`
- `GATEWAY_THINKING_STREAM_MIN_INTERVAL_MS`
- `GATEWAY_THINKING_TEXT_MAX_CHARS`
- `GATEWAY_THINKING_INCLUDE_TEXT`
- `GATEWAY_CHAT_ATTACHMENTS_MAX_COUNT`
- `GATEWAY_CHAT_ATTACHMENTS_MAX_BYTES_PER_ATTACHMENT`
- `GATEWAY_CHAT_ATTACHMENTS_MAX_TOTAL_BYTES`
- `GATEWAY_CHAT_ATTACHMENTS_MAX_DOCUMENT_CHARS`

Legacy compatibility envs are still accepted (`AVA_GATEWAY_*`) but should be treated as transitional.

### Slack Runtime Queue Steering

Key field:

- `slack.queueMode` (default `steer-backlog`)

Supported values:

- `collect`: batch queued prompts after active run completes.
- `followup`: FIFO follow-up queue.
- `steer`: latest message wins, abort current run, keep only latest queued prompt.
- `steer-backlog`: abort current run, queue latest first, preserve older queued prompts behind it.
- `interrupt`: hard interrupt current run and replace queue with latest prompt.

Runtime controls:

- `/queue mode <collect|followup|steer|steer-backlog|interrupt>`
- mode is persisted per session in `ava_sessions.metadata.queueMode`
- `/flow mode <async|supervisor|default>`
- flow override is persisted per session in `ava_sessions.metadata.subagentFlowMode`

Env override:

- `SLACK_QUEUE_MODE`

### Heartbeat Routing

Key fields:

- `heartbeat.enabled`
- `heartbeat.intervalMs`
- `heartbeat.target`
- `heartbeat.to`
- `heartbeat.accountId`

These fields control default heartbeat routing hints and account scoping for delivery resolution.

Env overrides:

- `HEARTBEAT_ENABLED`
- `HEARTBEAT_INTERVAL_MS`
- `HEARTBEAT_TARGET`
- `HEARTBEAT_TO`
- `HEARTBEAT_ACCOUNT_ID`

### Model + Routing

Model selection and failover are centralized in executor/runtime services. Main knobs remain:

- `agent.model.*`
- `agent.routing.*`
- `subagents.models.*`

## Removed Config Keys

The following legacy exec keys are hard-removed and now fail fast if present:

- `tools.exec.notifyOnExit`
- `tools.exec.notifyOnExitEmptySuccess`

Use per-call `completionPolicy` on exec actions instead.

## Minimal Example

```json
{
  "version": "1.0",
  "subagents": {
    "orchestration": {
      "mode": "async",
      "allowSessionOverride": true,
      "supervisor": {
        "maxAttempts": 3,
        "baseBackoffMs": 5000,
        "maxBackoffMs": 60000,
        "maxWorkflowMs": 3600000,
        "statusUpdateMs": 30000
      }
    },
    "defaultTimeoutMs": 0,
    "maxDepth": 2,
    "maxChildren": 5,
    "maxConcurrent": 8
  },
  "slack": {
    "queueMode": "steer-backlog",
    "maxConcurrentRuns": 5
  },
  "heartbeat": {
    "enabled": true,
    "intervalMs": 1800000,
    "target": "last",
    "to": "",
    "accountId": ""
  }
}
```

## Applying Changes

After editing config:

1. Restart the AVA process.
2. Verify loaded values in startup logs.
3. Run targeted tests (`pnpm test:unit` and relevant e2e/integration suites) before production rollout.
