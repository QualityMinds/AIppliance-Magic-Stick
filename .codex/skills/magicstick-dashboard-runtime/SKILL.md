---
name: magicstick-dashboard-runtime
description: Use when changing the MagicStick dashboard UI/API, runtime settings, ModuleActivation, ModelActivation, AppInstance flows, RBAC, ingress links, credential display, or VRAM estimation behavior.
---

# MagicStick Dashboard Runtime Work

## Read First

- `AGENTS.md`
- `docs/dashboard.md`
- `docs/appliance-crd.md`
- `docs/model-catalog.md` for model changes
- `magic-cluster/apps/dashboard/`

## Workflow

1. Confirm the dashboard writes only runtime intent resources or settings:
   `ModuleActivation`, `ModelActivation`, `AppInstance`, or
   `flux-system/ai-appliance-settings`.
2. Keep modules catalog-driven; do not hardcode dashboard module lists.
3. Keep instance hostnames derived as
   `<instance-name>.<instance-type>.<domain>`.
4. Show create controls only for installed/supported operators and remove
   controls only for deletable runtime CRs.
5. Keep RBAC narrow and update docs when API routes or permissions change.
6. Update dashboard docs and operations docs in the same change.

## Checks

- `kubectl kustomize magic-cluster/apps/dashboard`
- Extract and syntax-check embedded JS/Python/shell when changed.
- Render `magic-cluster/platform/magicstick-operator` when CRD, catalog, or
  operator expectations change.
- Run targeted API smoke tests for route, validation, delete, or estimate logic.
