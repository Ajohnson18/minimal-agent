# Sandbox Production Rollout Checklist

Use this checklist before enabling or promoting sandbox mode in production.

## Pre-flight
- [ ] `SANDBOX_MODE` is set to `non-main` for phase 1.
- [ ] `SANDBOX_IMAGE` exists on runtime hosts.
- [ ] `pnpm sandbox:verify-image` passes on the deployment artifact.
- [ ] `BROWSER_MODE=sandbox` and `BROWSER_CDP_URL` are configured where browser automation is expected.
- [ ] Auth-required runtime is enabled (`AVA_AUTH_REQUIRED=1`, `AVA_WS_ALLOW_QUERY_TOKEN=1`).

## Required Green Gates
- [ ] PR deterministic checks are green (`lint`, `typecheck`, `test:parallel`).
- [ ] Integration suite includes sandbox coverage and is green (`pnpm test:integration`).
- [ ] Coverage gates are green (`pnpm test:coverage`, `pnpm test:coverage:core`).
- [ ] Docker smoke is green (`pnpm test:docker:smoke`) with auth-enabled runtime.
- [ ] Nightly live gate is green with `AVA_LIVE_TEST_ALLOW=vertex,browser`.

## Phase 1 (Production `non-main`)
- [ ] Deploy with `SANDBOX_MODE=non-main`.
- [ ] Monitor for 7 days:
  - [ ] Rate of `SANDBOX_UNAVAILABLE` errors.
  - [ ] Queue failures tagged `SANDBOX_UNAVAILABLE`.
  - [ ] Browser CDP connection failures.
- [ ] No critical incidents in the 7-day window.

## Phase 2 (Promote to `all`)
- [ ] Promote to `SANDBOX_MODE=all` only after phase 1 criteria are met.
- [ ] Confirm no host-exec fallback is occurring for sandbox-required requests.
- [ ] Continue monitoring the same error classes for at least one additional release window.

## Rollback
- [ ] If sandbox unavailability or user-impacting failures spike, immediately set `SANDBOX_MODE=off`.
- [ ] Keep auth-required runtime unchanged during rollback.
- [ ] Capture failing logs and sandbox diagnostics before retrying rollout.
