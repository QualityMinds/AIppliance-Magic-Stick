---
name: magicstick-gitops-module
description: Use when changing MagicStick modules, the module catalog, Flux/Kustomize graph, HelmRelease bases, operator dependencies, CRDs, or generated module lifecycle behavior.
---

# MagicStick GitOps Module Work

## Read First

- `AGENTS.md`
- `docs/modules.md`
- `docs/operator-orchestration.md`
- `docs/architecture.md`
- `magic-cluster/platform/magicstick-operator/module-catalog.yaml`

## Workflow

1. Locate the module base and its catalog entry before editing.
2. Keep the module catalog as the source of truth for display name, group,
   activation mode, dependencies, CRDs, parameters, and generated Flux name.
3. Update `instanceMappings` when an `AppInstance` type requires the module.
4. Keep public bases reusable; deployment-specific values belong in runtime
   settings, runtime CRs, Secrets, or optional external overlays.
5. Update docs listed in `AGENTS.md` for catalog, dependency, or lifecycle
   changes.

## Checks

- `kubectl kustomize magic-cluster/platform/magicstick-operator`
- Render each touched module base.
- Render `magic-cluster/flux/entrypoints/single-node` when graph or default
  profile behavior changes.
- Run public value and secret scans when defaults, examples, or docs change.
