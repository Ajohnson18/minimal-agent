# AVA Testing Guide

## Overview

AVA uses a layered testing model:

- `unit`: deterministic module-level behavior, no external network.
- `integration`: real PostgreSQL + mocked external providers.
- `e2e`: deterministic API/Gateway/Slack/queue flow coverage.
- `live`: nightly/manual only, explicitly gated real-provider checks.
- `docker smoke`: infrastructure-level compose + runtime smoke validation.

PR gating suites are `unit + integration + e2e`.

## Commands

- `pnpm test`: runs `pnpm test:parallel`.
- `pnpm test:parallel`: orchestrates PR gating suites.
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm test:coverage`: enforces global `85/85/75/85` thresholds (lines/functions/branches/statements).
- `pnpm test:coverage:core`: enforces core `90/90/75/90` thresholds (lines/functions/branches/statements).
- `pnpm test:live`: live-gated suite (safe skip when disabled).
  - Defaults to `AVA_LIVE_TESTS=1` and `AVA_LIVE_TEST_ALLOW=vertex` unless already set.
- `pnpm test:docker:smoke`: Docker infrastructure smoke test.
- `pnpm test:docker:clean`: Docker cleanup helper.
- `pnpm sandbox:verify-image`: validates required binaries + Python packages in the sandbox image.
- `pnpm db:push:ci`: non-interactive schema apply for CI/automation.

## Required Test Environment

`test/setup/base.setup.ts` injects deterministic defaults before test imports:

- `NODE_ENV=test`
- `AVA_TEST_MODE=1`
- `DATABASE_URL` (from `AVA_TEST_DB_URL` fallback)
- `JWT_SECRET`
- `AVA_AUTH_REQUIRED=1` (default in test setup)
- `AVA_WS_ALLOW_QUERY_TOKEN=1` (default in test setup)
- `VERTEX_AI_PROJECT_ID`
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `AVA_CONFIG_PATH` -> `test/fixtures/config.test.json`

### Database

Integration/e2e tests expect PostgreSQL with AVA tables present.
Recommended local flow:

1. `pnpm docker:up`
2. `pnpm db:migrate:safe` (or `pnpm db:push` for disposable local DBs only)
3. `pnpm test:parallel`

## Live Test Gating

Live tests are guarded by:

- `AVA_LIVE_TESTS=1` (master switch)
- `AVA_LIVE_TEST_ALLOW` (comma-separated allowlist, e.g. `vertex,browser`)
- `AVA_LIVE_TIMEOUT_MS` (optional timeout override)
- `AVA_LIVE_MODEL_ID` (optional model override for live Vertex checks; defaults to `claude-sonnet-4-5@20250929`)

If `AVA_LIVE_TESTS` is not set, live tests skip cleanly.
Live setup automatically reads `.env.local` then `.env`, so `pnpm test:live` works without inline env flags.
Note: `.env.local` overrides `.env`; placeholder values like `VERTEX_AI_PROJECT_ID=your-project-id` will disable live Vertex execution.

Current live scopes:

- `vertex`: provider sanity + live subagent reliability smoke.
- `browser`: browser CDP reachability.

Vertex live tests require real service-account credentials (inline JSON or `GOOGLE_APPLICATION_CREDENTIALS` file with `client_email` + `private_key`).
Example: `AVA_LIVE_TESTS=1 AVA_LIVE_TEST_ALLOW=vertex pnpm test:live`

Example `.env.local`:

```bash
AVA_LIVE_TESTS=1
AVA_LIVE_TEST_ALLOW=vertex,browser
AVA_LIVE_MODEL_ID=claude-sonnet-4-5@20250929
VERTEX_AI_PROJECT_ID=your-project-id
VERTEX_AI_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
# or: GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

## E2E Worker Isolation

`test/setup/e2e.setup.ts` creates per-worker temp state:

- `AVA_STATE_DIR`
- `AVA_WORKSPACE_DIR`
- `SKILLS_DIR`

This avoids cross-test state collisions and stale artifacts.

## Reliability Regression Coverage (Current)

Key suites that cover recently-fixed reliability issues:

- Slack runtime queue steering semantics:
  - `test/unit/slack/runtime-queue-mode.test.ts`
- Slack final reply dedupe against messaging tools:
  - `test/unit/slack/runtime-final-reply-dedupe.test.ts`
- Subagent steer restart + session reuse:
  - `test/unit/agent/subagent-tool-steer.test.ts`
- Subagent timeout policy (`0` means no forced timeout):
  - `test/unit/agent/subagent-timeout-policy.test.ts`
- Markdown rendering consistency on Slack sends:
  - `test/integration/tools/slack-message.tool.test.ts`
  - `test/integration/tools/slack-actions.tool.test.ts`
  - `test/integration/gateway/outbound-delivery-pump.test.ts`
- Heartbeat/subagent end-to-end reliability regressions:
  - `test/e2e/heartbeat-flow.test.ts`
  - `test/e2e/subagent-completion-regression.test.ts`

## Auth Testing

- Test JWT helper: `test/helpers/auth.ts` (`createTestJwt`).
- HTTP e2e tests send `Authorization: Bearer <token>` for `/api/ava/chat` and `/api/ava/sessions`.
- Gateway e2e tests authenticate WebSocket connections with bearer headers (or query token where explicitly tested).
- Slack e2e tests intentionally do **not** require bearer auth and validate signature-only behavior.

## Docker Smoke

`pnpm test:docker:smoke`:

1. Starts postgres + browser sandbox containers.
2. Verifies sandbox image runtime capabilities (`pnpm sandbox:verify-image`).
3. Applies schema (`pnpm db:push:ci`).
4. Boots AVA API + Gateway with auth-required runtime enabled.
5. Checks health endpoints and authenticated API/WS RPC basics (`queue.stats`, `cron.list`, `browser.status`, `browser.navigate`).
6. Validates Python execution through the sandbox container manager path.
7. Optionally runs a minimal live chat path if `AVA_LIVE_TESTS=1`.
8. Always invokes cleanup via `scripts/test-docker-clean.sh`.

## Sandbox Readiness Commands

Run these before promoting sandbox mode:

1. `pnpm sandbox:verify-image`
2. `pnpm test:integration -- test/integration/sandbox`
3. `pnpm test:docker:smoke`

## CI

- `pr-tests.yml`: PR-required deterministic checks (`db:push:ci`, `lint`, `typecheck`, `test:parallel`) on Node `22.x`.
- `ci.yml`: full deterministic + coverage checks on pushes to `main` and manual dispatch.
- `nightly-live.yml`: scheduled/manual live tests + docker smoke.

Deterministic CI jobs set `AVA_FAIL_ON_SKIP=1`, so DB/network-gated tests fail fast instead of silently skipping.

## Legacy Script Migration

Legacy ad-hoc scripts in `src/scripts/test-*.ts` remain available for now but are considered deprecated in favor of the formal `test/**` suites and package scripts.
