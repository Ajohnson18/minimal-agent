# Feature Playbook

Use this guide when building new features so changes align with existing architecture.

## 0) Before You Change Code

1. Identify feature surface in `docs/MODULE_MAP.md`.
2. Trace current behavior in `docs/RUNTIME_FLOWS.md`.
3. Check contract impact in `docs/API_GATEWAY_CONTRACTS.md`.
4. Check data impact in `docs/DATA_MODEL.md`.
5. Confirm config toggles needed (`docs/CONFIG.md`).

## 1) Adding A New Agent Tool

Primary files:
- add tool impl in `src/agent/tools/<name>.tool.ts`
- register in `src/agent/pi-converter.ts`
- update prompt behavior if needed in `src/agent/system-prompt.ts`

Checklist:
- validate tool input schema and return stable structured details.
- enforce security/policy checks if tool can execute side effects.
- ensure tool result size is bounded (avoid context blowups).
- add focused unit tests for success/failure/edge cases.
- add integration test if tool touches DB/network/sandbox.

## 2) Adding A New HTTP API Route

Primary files:
- `src/api/routes/<new>.ts`
- mount in `src/api/server.ts`

Checklist:
- define auth expectations (bearer required or signature-based).
- validate user/session ownership on read/write operations.
- prefer streaming only when client needs incremental events.
- emit stable error shape and status codes.
- add e2e coverage for auth + happy + failure paths.

## 3) Adding A New Gateway RPC Method

Primary files:
- add method name/types in `src/gateway/protocol/methods.ts`
- implement handler in `src/gateway/methods/<domain>.ts`
- route in switch in `src/gateway/server.ts`

Checklist:
- enforce ownership checks using auth user when available.
- return `RpcError` with existing error code taxonomy.
- if method has async lifecycle, define push events and subscribe path.
- document new contract in `docs/API_GATEWAY_CONTRACTS.md`.
- add e2e tests for request/response and authorization.

## 4) Extending Slack Behavior

Primary files:
- filtering logic: `src/slack/monitor/events/messages.ts`
- mention/thread gating: `src/slack/monitor/message-handler/prepare.ts`
- runtime behavior and responses: `src/slack/monitor/runtime.ts`

Checklist:
- preserve ACK-fast ingress behavior.
- ensure event dedupe key remains stable.
- avoid duplicate runs for `app_mention` + `message` dual deliveries.
- keep per-session queue semantics intact.
- preserve reaction/typing cleanup on all code paths.
- add tests for thread edge cases and dedupe regressions.

## 5) Adding/Changing Persistent Data

Primary files:
- schema in `src/db/schema/*.ts`
- migration generated via Drizzle
- service access layer in `src/services/*`

Checklist:
- prefer additive migrations; avoid destructive rewrites.
- index by primary query path.
- keep lifecycle/status fields explicit for async workers.
- update docs in `docs/DATA_MODEL.md`.
- update test fixtures/setup as needed.

## 6) Adding Background Processing

Common places:
- queue path: `src/gateway/services/queue-processor.ts`
- cron path: `src/gateway/services/cron.ts`
- heartbeat path: `src/gateway/services/heartbeat.service.ts`
- outbound delivery path: `src/gateway/services/outbound-delivery-pump.ts`

Checklist:
- design for retry/idempotency first.
- prevent duplicate consumers (claim tokens, SKIP LOCKED patterns).
- include dead-letter/terminal state handling.
- ensure startup recovery and graceful shutdown drain behavior.

## 7) Session Lifecycle Safety Rules

When introducing async work tied to sessions:
- respect deliverability checks (`canDeliverToSession`).
- terminate on archive/delete via `session-lifecycle-guard`.
- avoid sending messages for archived/deleted sessions.
- keep route bindings updated if channel route can change.

## 8) Security Rules

- never bypass auth ownership checks for user-scoped data.
- for command execution, always apply exec policy + approval flow.
- keep sandbox fail-closed where sandbox is required.
- do not leak credentials from user vault or env in tool output.
- verify Slack signatures before processing events/interactions.

## 9) Testing Strategy Per Change Type

- Tool-only logic: unit tests.
- New transport contracts: e2e tests.
- DB/service behavior: integration tests.
- Slack threading/dedupe behavior: targeted unit + e2e Slack tests.
- Queue/cron/heartbeat reliability: integration or reliability suites.

Reference: `docs/TESTING.md` for command matrix.

## 10) Documentation Update Rule

Any feature that changes architecture, contracts, persistence, or extension points should update:
- `docs/MODULE_MAP.md` (ownership changes),
- `docs/RUNTIME_FLOWS.md` (flow changes),
- `docs/API_GATEWAY_CONTRACTS.md` (contract changes),
- `docs/DATA_MODEL.md` (schema changes).

This keeps future human and AI implementation work accurate.
