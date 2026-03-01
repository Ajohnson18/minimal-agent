# Module Map

This file maps major modules to responsibilities so you can quickly find the right edit point.

## Top-Level Source Layout

- `src/agent`: model runtime, prompting, tools, subagents.
- `src/api`: HTTP server and routes.
- `src/gateway`: WebSocket RPC server, protocol, methods, background services.
- `src/slack/monitor`: active Slack ingestion pipeline.
- `src/services`: cross-cutting durable/domain services.
- `src/db`: DB client and schema definitions.
- `src/sandbox`: container/runtime isolation + Python sandbox execution.
- `src/hooks`: typed phase-hook orchestration system.
- `src/skills`: skill discovery/loading/watching.
- `src/lib`: shared utilities (auth, Slack formatting, queue helpers, config, security).

## Agent Core (`src/agent`)

| File | Responsibility |
| --- | --- |
| `src/agent/executor-pi.ts` | Main run pipeline (history, routing, prompt build, tool loop, persistence, failover). |
| `src/agent/pi-provider.ts` | Model provider/model resolution + context windows. |
| `src/agent/pi-converter.ts` | Built-in + custom tool assembly, policy wrappers. |
| `src/agent/system-prompt.ts` | Dynamic prompt section builder (tooling, skills, memory, heartbeat, sandbox, identity). |
| `src/agent/session-adapter.ts` | Postgres <-> pi-message conversion and history repair. |
| `src/agent/context-pruning.ts` | Adaptive/hard pruning for oversized contexts. |
| `src/agent/compaction.ts` | Context summary retrieval/writing strategy. |
| `src/agent/memory-extractor.ts` | Automatic memory extraction from turns. |
| `src/agent/delivery.ts` | Channel-agnostic delivery (direct or durable). |
| `src/agent/user-context.ts` | Identity resolution into role/config/credentials context. |
| `src/agent/subagent-executor.ts` | Subagent runtime and nested limits. |
| `src/agent/subagent-announce.ts` | Subagent completion delivery/fallback orchestration. |

### Tool Implementations (`src/agent/tools`)

Main extension surface for model capabilities.

Key tools:

- `exec.tool.ts`: command execution + approvals + background sessions.
- `process.tool.ts`: manage running/background sessions.
- `web-search.tool.ts`, `web-fetch.tool.ts`: web retrieval stack.
- `browser.tool.ts`: browser automation integration.
- `python.tool.ts`: sandboxed Python execution.
- `memory.tool.ts`: memory CRUD/search.
- `sql.tool.ts`: read-only SQL access.
- `slack-message.tool.ts`, `slack-actions.tool.ts`: Slack integrations.
- `subagent.tool.ts`, `subagent-registry.ts`: subagent spawn and lifecycle APIs.
- `cron.tool.ts`: scheduling APIs.
- `user-manage.tool.ts`: identity/config/credentials management.

## API Layer (`src/api`)

| File | Responsibility |
| --- | --- |
| `src/api/server.ts` | Express app setup, CORS, middleware ordering, route mounting. |
| `src/api/routes/chat.ts` | SSE chat endpoint using executor. |
| `src/api/routes/sessions.ts` | Session listing/get/create/archive endpoints. |
| `src/api/routes/slack.ts` | Slack ingress ack + forwarding to monitor provider. |
| `src/api/routes/health.ts` | health/ready/live endpoints. |

## Gateway Layer (`src/gateway`)

| File | Responsibility |
| --- | --- |
| `src/gateway/server.ts` | WS server lifecycle, auth, RPC routing, service startup. |
| `src/gateway/runtime.ts` | Connected clients, subscriptions, in-memory run state. |
| `src/gateway/auth.ts` | WS auth extraction + JWT verification. |
| `src/gateway/protocol/methods.ts` | RPC method names + params/results contracts. |
| `src/gateway/protocol/events.ts` | Push event contract definitions. |
| `src/gateway/protocol/types.ts` | base RPC types + error codes. |

### Gateway Methods (`src/gateway/methods`)

- `agent.ts`: async run/status/cancel around executor.
- `sessions.ts`: RPC session lifecycle operations.
- `queue.ts`: queue enqueue/stats/pending/cancel.
- `cron.ts`: schedule CRUD/manual trigger.
- `browser.ts`: browser lifecycle/actions/snapshots/tabs.
- `subscriptions.ts`: event subscription management.
- `exec-approval.ts`: request/wait/resolve approval RPC.

### Gateway Services (`src/gateway/services`)

- `queue.ts`: durable queue abstraction.
- `queue-processor.ts`: background queue drain and execution.
- `cron.ts`: timer scheduling with queue enqueue.
- `heartbeat.service.ts`: periodic/event heartbeat execution.
- `heartbeat-lifecycle.ts`, `heartbeat-wake.ts`: per-session heartbeat lifecycle + wake coalescing/backoff.
- `system-events.ts`: durable event queue wrappers.
- `outbound-delivery-pump.ts`: durable outbound delivery worker.
- `session-lifecycle-guard.ts`: archive/delete termination + deliverability gate.
- `browser.ts`: Playwright/CDP stateful service.

## Slack Runtime (`src/slack/monitor`)

| File | Responsibility |
| --- | --- |
| `provider.ts` | Creates and returns monitor singleton provider. |
| `context.ts` | Dedupe caches, mention gating, channel config, thread resolver. |
| `events/messages.ts` | Slack event callback filtering and dispatch decisions. |
| `events/interactions.ts` | Approval interaction handling. |
| `message-handler.ts` | debounce orchestration and dispatch to runtime. |
| `message-handler/prepare.ts` | converts raw Slack message into dispatch/pending-history decisions. |
| `message-handler/dispatch.ts` | bridges prepared messages to runtime handlers. |
| `runtime.ts` | full execution flow: session resolve, media, queue, commands, agent run, reply pipeline. |
| `commands.ts` | slash command handling (`/ava ...`). |
| `thread-resolution.ts` | missing `thread_ts` resolution with cache+inflight dedupe. |

Notable runtime behavior in `runtime.ts`:

- session queue modes (`collect`, `followup`, `steer`, `steer-backlog`, `interrupt`),
- `/queue mode ...` command handling,
- deduped final-reply suppression against messaging tool sends.

## Shared Services (`src/services`)

| File | Responsibility |
| --- | --- |
| `user.service.ts` | user identity resolution, role management, config, credentials. |
| `credential-vault.ts` | credential encryption/decryption primitives. |
| `memory.service.ts` | hybrid memory search + store. |
| `embedding.service.ts` | embedding generation + cache. |
| `media.service.ts` | media extraction/transcription/analysis pipeline. |
| `tts.service.ts` | speech synthesis provider abstraction. |
| `exec-approval.service.ts` | approval orchestration + Slack notifier + persistence. |
| `exec-approval-manager.ts` | in-memory pending approval coordinator. |
| `exec-approval-store.ts` | DB persistence for approvals/allowlist/ownership checks. |
| `session-binding.service.ts` | binds session to current channel route. |
| `subagent-runs.service.ts` | DB-authoritative subagent run lifecycle persistence/recovery. |
| `outbound-delivery-queue.service.ts` | durable outbound queue CRUD/claim/retry. |
| `outbound-idempotency.service.ts` | idempotency reservation/marking for outbound messages. |
| `system-events.service.ts` | durable events with claim/finalize/release support. |
| `notification-deduplicator.ts` | dedupe wrapper for event creation. |
| `event-cleanup.service.ts` | periodic cleanup tasks. |
| `tracing.service.ts` | tracing integration. |
| `compression.service.ts` | semantic tool-output compression support. |

## Data Layer (`src/db`)

| File/Folder | Responsibility |
| --- | --- |
| `src/db/client.ts` | Postgres pool + drizzle client + health check. |
| `src/db/schema/*.ts` | normalized table definitions and types. |

Detailed schema mapping is in `docs/DATA_MODEL.md`.

## Libraries And Middleware (`src/lib`, `src/middlewares`)

Important shared modules:

- `src/lib/config-loader.ts`: non-secret runtime config and env override precedence.
- `src/lib/auth/*`: token extraction + JWT verification helpers.
- `src/lib/exec-approvals.ts`: allowlist parsing/evaluation and policy math.
- `src/lib/slack/*`: Slack app singleton, file handling, formatting, mention logic, reply dispatcher.
- `src/lib/queue/queue-helpers.ts`: dedupe/window helpers used in Slack and wake flows.
- `src/middlewares/auth.ts`: HTTP bearer enforcement.
- `src/middlewares/slack.ts`: Slack signature verification + challenge handling.

## Extension Points Summary

Use these modules first when extending behavior:

- New model capability: `src/agent/tools/*` + `src/agent/pi-converter.ts`.
- New inbound API: `src/api/routes/*` + `src/api/server.ts`.
- New RPC capability: `src/gateway/protocol/methods.ts` + `src/gateway/methods/*` + router switch in `src/gateway/server.ts`.
- New Slack behavior: `src/slack/monitor/events/*` and/or `src/slack/monitor/runtime.ts`.
- New durable domain primitive: `src/services/*` + `src/db/schema/*`.
- New typed hook phases: `src/hooks/*`.
