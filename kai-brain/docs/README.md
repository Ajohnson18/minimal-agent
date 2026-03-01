# AVA Codebase Docs

This folder is the source of truth for how AVA is structured today and where to make changes safely.

Use this when:

- you are onboarding to the project,
- you need to add or debug a feature,
- an AI agent needs reliable architectural context before coding.

Last updated: 2026-02-23.

## Start Here

1. Read `docs/ARCHITECTURE.md` for the system overview.
2. Read `docs/MODULE_MAP.md` for file-level ownership.
3. Read `docs/RUNTIME_FLOWS.md` for end-to-end request/runtime paths.
4. Read `docs/API_GATEWAY_CONTRACTS.md` for external contracts.
5. Read `docs/DATA_MODEL.md` for persistence and schema mapping.
6. Read `docs/FEATURE_PLAYBOOK.md` before implementing new functionality.

## Existing Operational Docs

- `docs/CONFIG.md`: runtime config model and routing behavior.
- `docs/AUTH.md`: auth behavior and token model.
- `docs/DEPLOY.md`: deployment and production runtime setup.
- `docs/SANDBOX.md`: sandbox architecture and operational details.
- `docs/SANDBOX_PROD_CHECKLIST.md`: rollout checklist for sandbox mode.
- `docs/TESTING.md`: test strategy and commands.

## Fast Orientation For AI Agents

If you are an agent implementing a feature in this repo, follow this sequence:

1. Locate the feature surface in `docs/MODULE_MAP.md`.
2. Confirm the path in `docs/RUNTIME_FLOWS.md`.
3. Confirm contract impact in `docs/API_GATEWAY_CONTRACTS.md`.
4. Confirm schema impact in `docs/DATA_MODEL.md`.
5. Apply change using guardrails in `docs/FEATURE_PLAYBOOK.md`.
6. Validate with tests from `docs/TESTING.md`.

This keeps changes consistent with existing architecture and prevents regressions.
