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

## Adding A Dashboard Service

Read the [project instructions](../../AGENTS.md),
[module catalog](../reference/module-catalog.md) and
[application controls](../reference/application-controls.md) first. Read
[dashboard instructions](../../dashboard/AGENTS.md) when changing clients or the
shared API. Choose whether the service is a module only or supports independently
configured `AppInstance` resources.

1. **Verify the upstream runtime.** Inspect the selected release, license,
   supported architectures, entrypoint, configuration and model API compatibility.
   Confirm how users reach it: a CLI does not automatically provide a web server.
   If a browser terminal or proxy is needed, verify that component too. Pin
   available images by immutable digest and verify downloaded assets with locked
   checksums. Document startup network requirements; a new custom image must be
   published before its deployment reference can be usable.
2. **Register the module.** Add or reuse a base under the appropriate
   `magic-cluster/apps/ai/` or `magic-cluster/platform/` ownership path. Extend
   `magic-cluster/platform/magicstick-operator/module-catalog.yaml` with stable
   identity, display/group/order, `activationMode`, `path`, `kustomizationName`,
   dependencies and required CRDs. Keep new optional services `default: false`
   unless another default is requested. A direct application that needs no shared
   installation may use an empty capability-marker base; its instance chart owns
   the workloads. Module-only services do not need an application catalog entry.
3. **Register instance support when needed.** Add the application to
   `magic-cluster/platform/magicstick-operator/app-catalog.yaml`. Declare
   `displayName`, `chartPath`, `requiredModules`, `requiredCrds` and `route`.
   `route.serviceName` selects the existing `instance` or `shortName` naming mode;
   match it and `route.port` to the Service rendered by the application. Set
   `requestTimeout: "0s"` for routes that require unbounded streaming or
   WebSockets. Reuse the generic controller instead of adding application-specific
   orchestration.
4. **Build the instance chart.** Use `magic-cluster/apps/instances/<application>/`
   with `Chart.yaml`, `values.yaml`, `values.schema.json` and templates. The
   operator passes identity, target namespace and derived hosts under
   `.Values.instance`; saved application settings are in `.Values.instance.values`.
   Validate required settings and supported namespaces. For an operator-backed
   application, render its native CR and put the operator/CRDs in the module base.
   For a direct application, render its Deployment, ClusterIP Service and any
   ConfigMaps/PVCs. Keep instance resources independently named. Define probes,
   resource limits, persistence and upgrade/removal behavior; retention metadata
   in a catalog is not a substitute for implementing PVC retention.
5. **Connect the Services form.** Application discovery comes from the catalogs.
   Extend `dashboard/apps/web/src/pages/ServicesPage.tsx` only for the supported
   form fields, defaults and payload mapping that the new application needs.
   Trace a submitted field through `api.createInstance`, saved
   `AppInstance.spec.values` and the chart; rendering a field does not save it.
   Reuse dependency availability, sharing, loading/error handling and role checks.
   Validate inputs at the API/chart boundary as appropriate, and preserve backend
   role/CSRF enforcement. Extend shared contracts/API/client code only when the
   existing contract cannot express the new behavior; preserve CLI/TUI consumers.
6. **Integrate models when applicable.** Use the shared
   [model catalog](../reference/model-catalog.md) and LiteLLM endpoint rather than
   maintaining another model list or hardcoding an installed model. If the runtime
   needs a new configuration format, add its export to
   `magic-cluster/apps/ai/model-catalog/controller.py` and the bootstrap ConfigMap.
   Preserve token limits, model capabilities and consumer reload/restart behavior.
   Reference credentials through environment variables or Kubernetes Secrets;
   never put key values in catalog ConfigMaps. Keep namespace constraints
   consistent with mounted ConfigMaps and `secretKeyRef`.
7. **Preserve access and lifecycle ownership.** The Magic Stick Operator creates
   instance `HTTPRoute`, `SecurityPolicy` and `ReferenceGrant` resources and reports
   URLs/status. Instance charts expose ClusterIP Services and disable their own
   external ingress. Reuse the SSO default, access/sharing choices and
   `<instance-name>.<instance-type>.<domain>` hostname contract. Keep runtime intent
   outside Git-owned `Appliance/local.spec`. Ensure disable/removal affects only
   the intended instance/module and preserves data according to its documented
   policy. Use the least privileges the verified runtime needs.
8. **Verify and document the complete path.** Select the affected checks from
   [project validation](../../AGENTS.md#validation-and-completion). Render the
   chart with a realistic `instance` values fixture and check schema rejection of
   invalid inputs; render the operator and touched Kustomize bases. Cover missing
   dependencies, repeated reconciliation, updates, errors and deletion ownership.
   For client changes, check the saved create payload, backend authorization and
   loading/empty/error states, then inspect the flow at desktop/mobile widths.
   Test the selected runtime in a container when adding startup scripts or adapting
   runtime behavior. Update application/module/model references, the user guide
   and [third-party notices](../../THIRD_PARTY_NOTICES.md) as affected. Report local
   rendering, runtime checks and live acceptance separately; a healthy web endpoint
   alone does not prove model inference.

For chart structure, compare the
[OpenClaw operator-backed chart](../../magic-cluster/apps/instances/openclaw/Chart.yaml)
with the [Pi direct-workload chart](../../magic-cluster/apps/instances/pi-coding/Chart.yaml).
Reuse the appropriate pattern, then verify every runtime-specific setting against
the selected upstream release. Keep the detailed lifecycle and API contracts in
their linked reference guides.

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

Follow [Adding a Dashboard service](#adding-a-dashboard-service), using an
operator-backed instance chart.

Use two layers:

- `magic-cluster/platform/ai/<name>-operator` for the operator, HelmRepository,
  HelmRelease, namespace, CRDs, and operator RBAC patches.
- `magic-cluster/apps/instances/<name>` for the AppInstance Helm chart.
- an entry in `magicstick-app-catalog` declaring the chart, required modules,
  and required CRDs.

This keeps CRD availability in a module base and app lifecycle in runtime CRs.
