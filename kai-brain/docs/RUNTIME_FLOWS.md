# Runtime Flows

This document describes how requests move through the system at runtime.

## 1) HTTP Chat Flow (`POST /api/ava/chat`)

Entry files:

- `src/api/routes/chat.ts`
- `src/agent/executor-pi.ts`

Flow:

1. HTTP auth middleware resolves token subject (`req.auth.userId`).
2. Route requires authenticated subject and does not accept `user_id` request fallbacks.
3. Session is created or validated in `ava_sessions`.
4. Existing compaction summary is loaded.
5. SSE stream is opened.
6. `executeAgentWithPi` starts; agent events are streamed as SSE frames.
7. Final `done` event is emitted with content + usage.
8. Route closes stream.

Failure behavior:

- Sandbox unavailable becomes `503` with `SANDBOX_UNAVAILABLE`.
- Parent-run timeout is controlled by `agent.timeoutMs` (`0` disables forced timeout).
- Other run errors are emitted as SSE `error` event when possible.

## 2) Gateway `chat.send` Flow

Entry files:

- `src/gateway/server.ts`
- `src/gateway/methods/chat.ts`
- `src/gateway/runtime.ts`

Flow:

1. WS connection is authenticated (`authenticateGatewayRequest`).
2. Server emits `connect.challenge`; client must call `connect` first.
3. Client sends typed request frame for `chat.send`.
4. Session ownership is validated when auth is present.
5. Gateway runtime creates an in-memory run record.
6. Executor runs async in background.
7. Streaming callbacks emit `chat` events with `state="delta"`.
8. If the client connected with `caps: ["tool-events"]` and subscribed to `agent` (or legacy `agent.*`),
   tool/thinking events are streamed as unified `agent` frames (`stream="thinking"` or `stream="tool"`).
   Thinking events are delta-first (`data.delta`); cumulative `data.text` is optional via
   `gateway.chat.thinking.includeText`.
   Tool `result` payloads are suppressed by default and only included when session `verboseLevel=full`.
9. Terminal event emits `chat` with `state="final"` or `state="error"`.
10. Client can cancel using `chat.abort` and fetch backfill via `chat.history`.

Notes:

- Run records are ephemeral in-memory (TTL cleanup), while messages are durable in DB.
- External WS `agent.run/status/cancel` is no longer supported.
- `chat.send` accepts attachment payloads (`attachments: unknown[]`) and normalizes runtime attachment objects as
  `{ type?, mimeType?, fileName?, content? }` (`content` must be base64 or data URL base64).
- Images (`image/*`) are forwarded as native model image inputs.
- Docs-first files (`application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/json`) are parsed into bounded text context.
- Unsupported file types, malformed base64, and attachment limit violations fail with `INVALID_PARAMS`.
- Attachment limits are configurable in `config.json` via `gateway.chat.attachments.*`.
- `chat.history` returns structured message blocks (`role`, `timestamp`, `content[]`) to mirror streamed chat payloads.
- `chat.history` redacts binary attachment payloads and returns omission metadata (`omitted`, `bytes`) instead of raw base64.

## 3) Slack Message Flow

Entry files:

- `src/api/routes/slack.ts`
- `src/slack/monitor/provider.ts`
- `src/slack/monitor/events/messages.ts`
- `src/slack/monitor/message-handler.ts`
- `src/slack/monitor/message-handler/prepare.ts`
- `src/slack/monitor/runtime.ts`

Flow:

1. Slack route verifies signature using raw body.
2. Route ACKs immediately (200) and forwards to monitor provider asynchronously.
3. Event handler dedupes by channel+timestamp and handles edits/deletes/reactions as system events.
4. Message handler resolves thread metadata and applies inbound debounce when allowed.
5. `prepareSlackMessage` decides dispatch vs pending-history buffering.
   - Top-level room messages with explicit mention dispatch immediately; non-mentions remain pending-history.
   - Room thread replies without AVA signal dispatch only for active AVA threads.
   - Room thread replies that mention other users (but not AVA) are ignored; channel mentions are allowed.
6. Runtime `handleSlackMessage` executes:

- normalizes input,
- handles slash-style commands in-thread,
- resolves per-session queue mode (`collect|followup|steer|steer-backlog|interrupt`),
- resolves per-session subagent flow mode (`async|supervisor` with optional override),
- adds ack reaction + typing status,
- hydrates attachments/media,
- resolves or creates session by `externalId`,
- updates session binding,
- injects thread history/system events/pending context,
- serializes per-session execution queue,
- runs executor,
- streams or posts final response,
- optional TTS upload,
- removes ack reaction and cleans temp files.

Queue steering notes:

- `/queue mode ...` updates per-session behavior and persists mode in `ava_sessions.metadata.queueMode`.
- `/flow mode <async|supervisor|default>` updates per-session subagent flow override in `ava_sessions.metadata.subagentFlowMode`.
- `steer` and `steer-backlog` abort active runs with internal queue reasons to avoid extra user-facing "Run stopped" chatter.
- `collect` drains pending prompts as one batched message; other modes drain one-by-one.
- `/stop` and natural-language stop intents abort active parent runs, clear pending queue items, and also kill background async subagents for that thread session.

Formatting notes:

- Runtime final replies convert markdown to Slack mrkdwn before delivery.
- Async delivery routes (heartbeat/subagent/outbound pump) also convert markdown before Slack send.

Important concurrency controls:

- per-session queueing of active runs,
- global max concurrent runs,
- dedupe caches for event and interaction replay.

## 4) Queue + Cron Flow

Entry files:

- `src/gateway/services/cron.ts`
- `src/gateway/services/queue.ts`
- `src/gateway/services/queue-processor.ts`

Flow:

1. Cron job is scheduled in `ava_cron_jobs`.
2. When due, cron enqueues payload in `ava_queue`.
3. Queue processor drains pending sessions event-driven (with safety poll fallback).
4. For each dequeued item, runtime run is created and executor invoked.
5. Completion updates queue status + broadcasts gateway events.
6. Cron-sourced responses can be routed to Slack (with heartbeat/silent suppression logic).

## 5) Exec Approval Flow

Entry files:

- `src/agent/tools/exec.tool.ts`
- `src/services/exec-approval.service.ts`
- `src/services/exec-approval-manager.ts`
- `src/services/exec-approval-store.ts`
- `src/slack/monitor/events/interactions.ts`
- `src/gateway/methods/exec-approval.ts`

Flow:

1. Exec tool computes effective policy (host/security/ask + allowlist analysis).
2. If approval is needed, service creates pending approval record and notifier prompt.
3. Slack prompt is posted with action buttons (allow once, always allow, deny).
4. User interaction resolves decision (with role/ownership authorization checks).
5. Pending approval manager resolves waiting promise.
6. Exec continues or is denied/timed out.
7. `allow-always` decisions persist normalized allowlist patterns per user/agent.

Gateway path:

- External clients can request/wait/resolve approval via RPC methods.

## 6) Subagent Spawn + Announce Flow

Entry files:

- `src/agent/tools/subagent.tool.ts`
- `src/agent/subagent-executor.ts`
- `src/agent/tools/subagent-registry.ts`
- `src/agent/subagent-announce.ts`

Flow:

1. Parent run calls `spawn_subagent`.
2. Effective flow mode resolves from global config (`subagents.orchestration.mode`) plus optional session override.
3. Execution branches by flow mode:

- `async` mode (delegated):
  - registry records run (`running`) with DB-first durability (`ava_subagent_runs`) plus in-memory coordination cache,
  - subagent runs in background,
  - completion enters announce cleanup (direct-first delivery, then heartbeat fallback).
- `supervisor` mode (parent-owned):
  - tool call waits in-band for child outcome,
  - retries use configured supervisor policy (`maxAttempts`, backoff, workflow deadline),
  - child completion announce is forced to `silent` so only the parent turn decides user-facing response,
  - tool returns structured attempt history and final result/error to the parent run.

4. Subagent executes in isolated child session with inherited sandbox context.
5. Default timeout is disabled (`timeout=0`) unless explicitly configured or passed.
6. In async mode, `steer` uses restart semantics in the same child session:

- active run is killed,
- restart waits briefly for abort settle,
- replacement run gets a new run id but reuses the existing child session id,
- steer guidance is injected as new context for the restarted run.

7. Async announce cleanup phase starts:

- direct delivery attempt with idempotency key,
- fallback to system event queue if direct delivery unavailable,
- heartbeat wake for non-silent queued outcomes.

8. Retry/backoff applies for transient async announce failures.
9. Cleanup is marked handled; old archived runs are swept.

Key constraints:

- depth and children limits enforced,
- steer is rate-limited and requires a running + initialized child session,
- non-silent runs should never intentionally black-hole completion visibility,
- nested requester sessions avoid direct external delivery.

## 7) Heartbeat Flow

Entry files:

- `src/gateway/services/heartbeat-lifecycle.ts`
- `src/gateway/services/heartbeat.service.ts`
- `src/gateway/services/heartbeat-wake.ts`

Flow:

1. Heartbeat lifecycle ensures one heartbeat service per active session.
2. Triggers come from interval timer or wake events (exec/subagent/etc).
3. Heartbeat run claims pending system events (exclusive claim token).
4. It builds prompt from event context or `HEARTBEAT.md` fallback prompt.
5. Executor runs in same session context.
6. Typed control-envelope output determines delivery behavior.
7. Literal token strings are treated as plain text unless wrapped in a control envelope.
8. Non-empty actionable output is delivered via channel-aware delivery.
9. Claim is finalized/released based on outcome.

## 8) Durable Outbound Delivery Flow

Entry files:

- `src/agent/delivery.ts`
- `src/services/outbound-delivery-queue.service.ts`
- `src/services/outbound-idempotency.service.ts`
- `src/gateway/services/outbound-delivery-pump.ts`

Flow:

1. Delivery caller chooses direct or durable path.
2. Durable path enqueues job with route snapshot and idempotency key.
3. Pump claims ready jobs and resolves current session binding/route.
4. Idempotency service prevents duplicate sends.
5. Delivery attempt:

- on success: mark sent + idempotency sent,
- on failure: mark retry with backoff,
- on terminal exhaustion or invalid route: mark dead.

6. Slack sends in this path convert markdown to mrkdwn before `chat.postMessage`.
2. Pump re-schedules itself based on next ready job.

## 9) Session Archive/Delete Termination Flow

Entry file:

- `src/gateway/services/session-lifecycle-guard.ts`

When a session is archived/deleted, AVA terminates in-flight work:

1. stop heartbeat,
2. cancel active gateway runs,
3. cancel pending queue items,
4. kill subagents for parent session,
5. clear system events,
6. cancel pending outbound delivery jobs,
7. invalidate active session bindings.

This keeps delivery and processing consistent with lifecycle state.
