# Dashboard and runtime instructions

Read the [project instructions](../AGENTS.md) and
[dashboard development guide](../docs/development/dashboard.md). These rules also
apply when changing the shared API under `magic-cluster/apps/dashboard`.

## Architecture and contracts

- Web, CLI and TUI share `packages/contracts`, `packages/api-client` and
  `packages/core`. Keep browser/terminal/filesystem dependencies out of that core.
- Implement and authorize capabilities in the existing backend API, not directly
  against Kubernetes in a client. Hiding a button is not authorization.
- Trace a change through saved intent, controller reconciliation, status and
  routing. Do not stop at a successful HTTP response or generated manifest.
- Preserve saved configurations and revision-safe edits. Engine-specific settings
  must not leak across engines; new capabilities should extend existing catalogs.
- Inspect the selected upstream version before adding flags, precision choices or
  hardware restrictions. Document unsupported paths instead of inventing support.

## Interface conventions

- Keep pages compact. Put background explanations behind accessible info controls;
  keep actionable errors and interruption warnings visible. Help must work with
  keyboard focus and touch, not hover alone.
- Advanced settings and GPU configuration accordions start collapsed. Use one
  named section per physical GPU; node facts belong to the node, not every GPU.
- Enable Save/Apply only for valid changes to the current effective configuration.
  Reverting a draft disables the action; polling must not overwrite unsaved input.
- Unsupported, full or temporarily unavailable devices stay understandable: show
  a reason when disabling selection. Recheck availability server-side on writes.
- Avoid extra acknowledgement checkboxes without a concrete safety requirement.
  Preserve appropriate confirmation for destructive or disruptive operations.
- Opening a page, changing tabs or polling status must never start a workload,
  validation, host preparation, cleanup, restart or network reconfiguration.
- Preserve supported model edit, start/stop/restart and log actions. Treat runtime
  shutdown separately from deleting saved definitions or downloaded model data.

## Status and resources

- Separate configured/reserved budgets from live measurements, capacity and slots.
  Unknown or stale telemetry is unknown, not zero or fully available memory.
- Do not add firmware-reserved and dynamic shared limits as independent physical
  RAM. Use the [memory contract](../docs/concepts/memory.md) for each allocation domain.
- Host-driver readiness, Kubernetes registration, optional engine validation and
  actual model readiness are distinct. Never copy AMD facts onto another vendor.
- Map failures to actionable UI messages while retaining useful, redacted details
  in logs. Do not present request acceptance as completed recovery or deployment.

## Verification

Use the pinned workspace dependencies. For client changes run `pnpm typecheck`,
`pnpm test` and `pnpm build` from `dashboard/`; broaden tests for shared contracts.
For API changes select relevant Python suites in `magic-cluster/apps/dashboard`
and `dashboard/apps/api` from the repository root, using the documented API
requirements. Add behavior tests for authorization, invalid inputs, saved-state
compatibility and relevant loading/empty/error states.

Inspect changed browser flows at desktop and narrow mobile widths, including
focus, help, dirty/reverted forms and overflow. A jsdom/component test is not a
real-browser or live-inference test. Use fixture-backed previews where practical;
use the test appliance only within the user's authorized scope. Report unavailable
browser/live checks rather than claiming them from unit tests.

Rendering manifests is additional deployment validation, not a substitute for
client/API tests. Publish only when requested and follow
[image promotion](../docs/development/image-promotion.md) for an appliance rollout.
