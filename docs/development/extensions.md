# Extend Magic Stick

## Adding A Cluster Base

1. Add the base under the narrowest existing ownership path.
2. Reuse existing Kustomize and HelmRelease patterns.
3. Add Flux health checks only when later waves require the resource to be
   ready.
4. Keep values generic and safe by default.
5. Render both the standalone base and any aggregate base that imports it.
6. Update [architecture.md](../concepts/architecture.md), [configuration.md](../reference/configuration.md),
   or [gitops-overlays.md](gitops-overlays.md) when the public contract changes.

## Adding A Module

1. Add or reuse a public-safe Kustomize base.
2. Add a catalog entry in
   `magic-cluster/platform/magicstick-operator/module-catalog.yaml`.
3. Choose a stable generated Flux `kustomizationName`.
4. Document required CRDs and dependencies.
5. Update the module catalog and docs when the module is user-selectable.
6. Render `magic-cluster/platform/magicstick-operator` and any touched base.

## Adding An App Variable

1. Use a documented `AI_APPLIANCE_*` name.
2. Provide a safe default with Flux substitution.
3. Quote YAML strings when values may contain special characters.
4. Add the variable to [configuration.md](../reference/configuration.md).
5. Add release-review coverage to [public-release-checklist.md](release-checklist.md).

For module storage values, prefer `ModuleActivation.spec.parameters` plus an
operator-managed Flux substitution over installer or USB metadata.

## Adding A Secret

Prefer one of these patterns:

- generated Secret with secret-generator annotations
- `valueFrom.secretKeyRef` pointing to a Secret supplied by a private overlay
- external secret manager integration outside this public repository

Never commit real secret data. When debugging, avoid copying decoded Secret
values into logs, issues, commits, or docs.

## Adding An Operator-Backed App

Use two layers:

- `magic-cluster/platform/ai/<name>-operator` for the operator, HelmRepository,
  HelmRelease, namespace, CRDs, and operator RBAC patches.
- `magic-cluster/apps/instances/<name>` for the AppInstance Helm chart.
- an entry in `magicstick-app-catalog` declaring the chart, required modules,
  and required CRDs.

This keeps CRD availability in a module base and app lifecycle in runtime CRs.
