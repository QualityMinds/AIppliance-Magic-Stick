---
name: magicstick-gitops-module
description: "Implement or diagnose Magic Stick catalogs, controllers, CRDs, module dependencies and Flux/Kustomize/Helm composition. Use for orchestration changes, not merely to publish an existing image."
---

# GitOps and module work

Read [project instructions](../../../AGENTS.md), then the relevant contract:

- Module lifecycle/dependencies: [module catalog](../../../docs/reference/module-catalog.md)
  and [controllers](../../../docs/concepts/controllers.md).
- CRDs/status/finalizers: [Kubernetes resources](../../../docs/reference/kubernetes-resources.md).
- Application instances: [application controls](../../../docs/reference/application-controls.md)
  and [extension development](../../../docs/development/extensions.md).
- Composition/overlays: [architecture](../../../docs/concepts/architecture.md) and
  [GitOps overlays](../../../docs/development/gitops-overlays.md).

## Work

Locate the catalog entry, reusable base, consuming controller and tests before
editing. Use catalogs for identity, grouping, dependencies, activation mode,
instance mappings and parameters. Add an entry/extension to the generic flow
instead of a per-app dashboard or controller branch when that flow fits.

Keep Git-owned desired appliance configuration separate from runtime resources.
Preserve public-safe defaults and derived instance hostnames. Trace dependencies
and deletion ownership: disabling one module must not delete unrelated objects
or break another active consumer.

Test reconciliation for repeated runs, pending dependencies, errors, updates and
deletion/finalization as affected. Distinguish requested intent from observed
status and keep status generations meaningful. Change CRD schema, RBAC, defaults,
rendering and consumers together when the contract requires it.

For live diagnosis, inspect the source revision, reconciliation conditions,
events and dependent objects first. A failed HelmRelease is not enough to infer
a driver failure. Do not delete/reinstall operators, force finalizers or patch
Git-managed objects merely to investigate. Scoped recovery must retain the
configured ownership and be reconciled with Git after the fix.

## Verify

Run relevant tests under `magic-cluster/platform/magicstick-operator/controller`
and other affected consumers. Render the operator base and touched module bases
with `kubectl kustomize`; render both Flux entrypoints for graph/default changes
and the demo overlay if composition changed. Use
[development environment](../../../docs/development/environment.md) for setup.

Update the matching public contracts. Rendering proves composition, not live
controller convergence. Publication and a live rollout require their own scope
and evidence; stop at analysis when only diagnosis was requested.
