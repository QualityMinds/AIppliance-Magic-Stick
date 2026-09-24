---
name: magicstick-dashboard-runtime
description: "Implement or diagnose Magic Stick dashboard, shared API and model/runtime control behavior. Use for client flows and contracts; not for marketing pages or host driver remediation alone."
---

# Dashboard and runtime work

Read [project instructions](../../../AGENTS.md),
[dashboard instructions](../../../dashboard/AGENTS.md) and the relevant section of
[dashboard development](../../../docs/development/dashboard.md).

## Choose the affected contract

- UI, CLI/TUI, authorization or settings: use the
  [API contract](../../../docs/reference/dashboard-api.md) and existing client packages.
- Model creation/editing, engine settings, lifecycle, logs or routing: use
  [model integration](../../../docs/development/model-integration.md),
  [model controls](../../../docs/reference/model-controls.md) and
  [catalog flow](../../../docs/reference/model-catalog.md).
- Memory or device selection: use [memory accounting](../../../docs/concepts/memory.md),
  [GPU sharing](../../../docs/administration/gpu-sharing.md) and the compute-target
  catalog. Read engine-specific references only for the affected engine.

## Work

Trace the user action through client contracts, API validation/authorization,
persisted runtime intent, reconciliation and returned status. For a diagnosis,
inspect that path without modifying live resources. For implementation, extend
the existing path and test the changed contract at its owning layer.

Keep provider-specific settings separate and preserve existing saved models.
Use effective configuration and current capacity/slot evidence for controls;
recheck constraints in the API. Exercise unchanged, changed, reverted, invalid,
loading and failure states where relevant. Do not duplicate backend rules in each
client or create Kubernetes workloads directly from UI code.

For a new engine/runtime option, verify the pinned upstream's real CLI/API and
hardware support before changing the catalog or launch arguments. Test existing
engine paths affected by shared code. Discovery, scheduling, startup, readiness
and a successful inference response are separate acceptance steps.

## Verify and hand off

Follow the dashboard instructions for workspace typecheck/tests/build and relevant
API tests. Render affected deployment/RBAC manifests and operator bases when their
contracts change. Use [model troubleshooting](../../../docs/administration/troubleshooting/models.md)
for runtime failures; a green component test does not prove live inference.

Update affected user/reference docs. Report what was checked and any remaining
live gate. Stop at local implementation unless publication or deployment is part
of the request; use [image promotion](../../../docs/development/image-promotion.md)
when a dashboard rollout is explicitly in scope.
