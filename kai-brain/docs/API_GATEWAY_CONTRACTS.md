# API And Gateway Contracts

This file captures the externally-consumed HTTP and WebSocket contracts.

## Auth Model

### HTTP

- Middleware: `src/middlewares/auth.ts`
- Auth token: `Authorization: Bearer <jwt>`
- Claims accepted:
- `sub` (preferred user id)
- `user_id` (JWT-claim fallback when `sub` is absent)
- Optional strict checks via config/env for issuer and audience.

### WebSocket

- Middleware: `src/gateway/auth.ts`
- Token sources:
- `Authorization` header bearer token
- query token when `wsAllowQueryToken` is enabled

### Slack

- Middleware: `src/middlewares/slack.ts`
- Requires `x-slack-signature` + `x-slack-request-timestamp` and raw body verification.

## HTTP Endpoints

Base prefix defaults to `/api/ava`.

### Health

- `GET /health`
- `GET /api/ava/health`
- `GET /api/ava/health/ready`
- `GET /api/ava/health/live`

### Chat

- `POST /api/ava/chat` (auth required by default)
- Starts/continues session and streams SSE events.
- Body:
- `message` (required)
- `session_id` (optional)
- `model`, `provider` (optional)
- Identity is always derived from authenticated JWT subject.

- `GET /api/ava/chat/history/:session_id`
- Returns session + non-compacted messages.

### Sessions

- `GET /api/ava/sessions`
- `GET /api/ava/sessions/:id`
- `POST /api/ava/sessions`
- `DELETE /api/ava/sessions/:id` (archive path)

### Slack Ingress

- `POST /api/ava/slack/events`
- `POST /api/ava/slack/interactions`
- `POST /api/ava/slack/commands`
- `GET /api/ava/slack/health`

Slack routes are signature-authenticated, not bearer-authenticated.

## WebSocket RPC Contract

Transport:
- Typed request frame `{ type: "req", id, method, params }`.
- Typed response frame `{ type: "res", id, ok, payload?, error? }`.
- Typed event frame `{ type: "event", event, payload, seq?, stateVersion? }`.
- Connection requires a handshake:
- server emits `connect.challenge`
- client must call `connect` with the challenge nonce before any other method
- `connect` response advertises authoritative `methods` and `events` lists.

Client capabilities:
- Pass optional `caps` in `connect` params.
- `tool-events` enables capability-gated `agent` stream events for `thinking` and `tool` phases.

Method registry source: `src/gateway/protocol/methods.ts`.

Session-scoped RPC methods are `sessionKey`-first and reject `sessionId` aliases.

### Chat Methods

- `chat.send`
- `chat.history`
- `chat.abort`

### Session Methods

- `sessions.list`
- `sessions.preview`
- `sessions.get`
- `sessions.reset`
- `sessions.delete`

### Queue Methods

- `queue.enqueue`
- `queue.stats`
- `queue.pending`
- `queue.cancel`

### Cron Methods

- `cron.list`
- `cron.add`
- `cron.update`
- `cron.remove`
- `cron.run`

### Browser Methods

- `browser.status`
- `browser.navigate`
- `browser.snapshot`
- `browser.act`
- `browser.screenshot`
- `browser.tabs`

### Exec Approval Methods

- `exec.approval.request`
- `exec.approval.waitDecision`
- `exec.approval.resolve`

### Subscription Methods

- `subscribe`
- `unsubscribe`

## Server-Pushed Gateway Events

Event contract source: `src/gateway/protocol/events.ts`.

### Connection events
- `connect.challenge`

### Chat events
- `chat` with payload:
- `{ runId, sessionKey, seq, state, message?, errorMessage?, usage?, stopReason? }`
- `message` is a structured chat block object (`role`, `timestamp`, `content[]`) for delta/final rendering.

### Agent events
- `agent` (chat-stream side channel for cap-enabled clients)
- payload shape:
- `{ runId, sessionKey?, stream, seq, ts, data? }`
- `stream` values:
- `thinking`:
- always includes `delta`.
- `text` is optional and only present when `gateway.chat.thinking.includeText=true`.
- `tool`:
- `phase: "call"` includes `toolName` and clamped `args`.
- `phase: "result"` includes `toolName`; `result` is only included when session `verboseLevel=full` (otherwise omitted).
- `agent.*` legacy lifecycle events may still appear from non-chat queue/legacy paths.

### Cron events
- `cron.fired`
- `cron.completed`
- `cron.error`

### Session events
- `session.created`
- `session.updated`
- `session.deleted`

### Exec approval events
- `exec.approval.requested`
- `exec.approval.resolved`

## RPC Error Codes

Defined in `src/gateway/protocol/types.ts`:

- `-32700` parse error
- `-32600` invalid request
- `-32601` method not found
- `-32602` invalid params
- `-32603` internal error
- `-32001` not found
- `-32002` unauthorized
- `-32003` already exists
- `-32004` timeout
- `-32005` sandbox unavailable

## Contract Notes

- When auth context exists, legacy `userId` method params are ignored in favor of token subject.
- Session ownership checks are enforced across session/queue/cron/subscription/chat methods.
- Event payload identity fields are `sessionKey`-first for external consumers.
- `chat.send` is asynchronous: acceptance response arrives before terminal `chat` events.
- `chat.send` accepts optional `attachments` over WebSocket using OpenClaw-compatible wire permissiveness (`unknown[]`).
- Runtime attachment shape is `{ type?, mimeType?, fileName?, content? }` where `content` is base64 (or data URL base64).
- Supported attachment classes:
  - `image/*` (passed natively as model image input)
  - docs-first file scope: `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/json`
- Unsupported attachment types, invalid base64 payloads, and limit violations return `INVALID_PARAMS`.
- Attachment limit knobs are configurable via `gateway.chat.attachments.*` in `config.json`.
- `chat.history` never returns attachment binary payloads; attachment blocks are returned with metadata + omission markers (`omitted`, `bytes`).
- Slack ingress is deliberately ack-first and async to avoid Slack retry storms.
