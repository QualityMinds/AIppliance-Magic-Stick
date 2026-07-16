# Magic Stick Dashboard

The Magic Stick Dashboard is the user interface for the Appliance control plane.
It reads Kubernetes status and writes runtime intent resources. It does not
directly install workloads, create Flux Kustomizations, or manage app resources
itself.

```text
Dashboard UI
  -> Envoy Gateway OIDC login
  -> Dashboard Backend API
  -> Kubernetes API
  -> ModuleActivation, AppInstance, and ModelActivation CRs
  -> Magic Stick Operator
  -> Flux Kustomizations, HelmReleases, and native KubeAI Model resources
```

## Role

The dashboard may:

- read `Appliance/local`
- read `ConfigMap/magicstick-module-catalog`
- read `ConfigMap/magicstick-app-catalog`
- read model presets and the generated `ConfigMap/ai-model-catalog`
- read Flux, Pod, Service, Ingress, ConfigMap, Event, and GPU metric status
- read and patch the runtime settings `ConfigMap/ai-appliance-settings`
- create or patch `ModuleActivation` resources for catalog-driven modules
- create or delete `AppInstance` resources for supported instance types
- create or delete `ModelActivation` resources for local and external models
- create Dashboard-managed provider API key Secrets in namespace `ai`
- read OpenClaw instance credentials when the generated instance exposes them

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw, Hermes,
Paperclip, KubeOpenCode, KubeAI, LiteLLM, or direct app instance reconcilers.

## UI Areas

| Area | Purpose |
|---|---|
| Overview | Shows appliance health, module/instance/model counts, and discovered ingress links. |
| Modules | Renders grouped module cards from the module catalog and writes `ModuleActivation` intent. |
| Instances | Shows instance cards and creates instance requests only for installed/supported operators. |
| Models | Creates/removes local and external model activations and estimates local model VRAM. |
| System Status | Shows Flux, Pod, Service, Ingress, and Event status. |
| Settings | Edits appliance-wide public and mDNS domain settings. |

## Backend API

The dashboard Deployment runs an API sidecar from
`ConfigMap/ai-appliance-dashboard-api`. nginx proxies `/api/*` to the sidecar.
Envoy Gateway requires a Keycloak login for both the local and public dashboard
hostnames and forwards the access token. The API validates the token against
Keycloak before applying its own role checks.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/session` | Returns the authenticated username and local realm roles. |
| `GET` | `/api/appliance` | Returns `Appliance/local`. |
| `PATCH` | `/api/appliance` | Returns `405`; `Appliance/local.spec` is Git-owned. |
| `GET` | `/api/settings` | Returns public domain, dashboard public host, mDNS domain, and derived mDNS name. |
| `PATCH` | `/api/settings` | Validates and patches `flux-system/ai-appliance-settings` while preserving unrelated keys. |
| `GET` | `/api/modules` | Returns catalog metadata plus current `ModuleActivation` spec/status. |
| `POST` | `/api/modules/{name}/enable` | Creates or patches a `ModuleActivation` with `spec.enabled: true`. |
| `POST` | `/api/modules/{name}/disable` | Creates or patches a `ModuleActivation` with `spec.enabled: false`. |
| `GET` | `/api/instances` | Returns `AppInstance` resources and status. |
| `GET` | `/api/instances/{name}/credentials` | Returns supported generated credentials for an instance, currently OpenClaw. |
| `POST` | `/api/instances/{type}` | Adds or replaces an `AppInstance` for supported types such as `openclaw`, `hermes`, `odysseus`, `paperclip`, or `kubeopencode`. |
| `DELETE` | `/api/instances/{name}` | Deletes the `AppInstance`; its finalizer removes the generated HelmRelease and Helm cleans the application resources. |
| `GET` | `/api/models` | Returns model catalog entries, model presets, `ModelActivation` resources, AnythingLLM status, and VRAM summary. |
| `POST` | `/api/models/estimate-vram` | Estimates VRAM for public HuggingFace model metadata, context size, and max sequence count. |
| `POST` | `/api/models/local` | Adds or replaces a local KubeAI-backed `ModelActivation`. |
| `POST` | `/api/models/external` | Adds or replaces an external LiteLLM-backed `ModelActivation`; Dashboard-entered API keys are stored as Secrets. |
| `DELETE` | `/api/models/{name}` | Deletes the `ModelActivation` and a Dashboard-created provider Secret when present. |
| `GET` | `/api/status` | Returns Appliance, Flux, Pod, Service, and Ingress status summaries. |
| `GET` | `/api/events` | Returns core and `events.k8s.io` event summaries. |

All read endpoints require `magicstick-viewer`, `magicstick-operator`, or
`magicstick-admin`. Instance credential reads and runtime mutations require
operator or admin. Settings changes require admin. Envoy authentication alone
does not authorize a configuration change.

## Module Controls

The Modules screen is catalog-driven. It uses
`ConfigMap/magicstick-module-catalog.data["modules.json"]` for display names,
groups, activation mode, aliases, ordering, dependencies, and optional advanced
parameters.

Modules with `activationMode: static` are displayed as status cards but cannot
be enabled or disabled from the dashboard. Modules with
`activationMode: moduleactivation` expose only the currently valid action:
`Enable` for disabled modules and `Disable` for enabled modules. In-progress
modules disable their action button until the request settles.

Progress is phase-based. The dashboard maps existing status phases such as
`Disabled`, `WaitingForModules`, `Reconciling`, `Removing`, `Ready`, and
`Degraded` to visual progress states. These percentages are orientation hints,
not scheduler- or operator-reported completion percentages.

## Instance Controls

Instances are runtime requests stored as `AppInstance` resources in namespace
`ai-system`. The dashboard shows create controls only for instance types whose
required modules are installed or installable according to the module
catalog and current module status.

Instance hostnames are derived, not user-entered:

```text
<instance-name>.<instance-type>.<domain>
```

For example, an OpenClaw instance named `default` uses:

- `default.openclaw.magicstick.example.com`
- `default.openclaw.magicstick.local`

Every create form selects an access mode and exposure. The safe default is
shared SSO for any authenticated `magicstick-user`, with optional minimum roles
of viewer, operator, or administrator. An unauthenticated route is available
only through the explicit `Public without login` choice. Exposure can be local
only or both local and public; hostnames remain derived and are not user-entered.

The operator, not the instance chart or dashboard, creates `HTTPRoute`,
`SecurityPolicy`, and `ReferenceGrant` resources. Both local and public links
are reported in `AppInstance.status` and displayed on the instance card.

The Paperclip form additionally selects the default chat model, enables the
OpenCode sandbox runtime, optionally binds an existing OpenClaw or Hermes
gateway instance, and sets the maximum concurrent sandbox count. Gateway
selectors list existing matching `AppInstance` resources and are required only
when their checkbox is enabled. These values are stored under
`spec.values.agentExecution`; the dashboard does not create Paperclip
companies, employee agents, or gateway credentials.

## Model Controls

Local and external models are runtime requests stored as `ModelActivation`
resources in namespace `ai-system`.

For local HuggingFace-backed models, the dashboard can call
`POST /api/models/estimate-vram` to fetch public metadata, estimate model
weights and KV cache, and suggest minimum and recommended VRAM values. The value
stored in `spec.local.vram` remains the actual request passed to KubeAI/vLLM.

Catalog-only models are read-only in the Models screen. Remove actions are shown
only for `ModelActivation` rows that the dashboard can delete.

## RBAC

The dashboard ServiceAccount is `dashboard/ai-appliance-dashboard`. Its
permissions are intentionally narrow:

- read `appliances.appliance.magicstick.dev`
- read, create, patch, and update `moduleactivations.appliance.magicstick.dev`
- read, create, patch, update, and delete `appinstances.appliance.magicstick.dev`
- read, create, patch, update, and delete `modelactivations.appliance.magicstick.dev`
- read OpenClaw instances for generated credential discovery
- read Flux Kustomizations
- read Pods, Services, Ingresses, HTTPRoutes, ConfigMaps, and Events
- read the DCGM exporter service proxy for live VRAM metrics
- patch only `flux-system/ai-appliance-settings`
- manage only Dashboard-created provider credential Secrets in namespace `ai`

It does not have cluster-admin and does not have permission to create workloads
directly.

## Public-Safe Values

Examples use only `example.local`, `example.com`, `CHANGEME`, and documented
variables or public model preset identifiers. Real domains, external repository
paths, credentials, kubeconfigs, and customer values belong in runtime settings,
runtime Secrets, or optional external overlays.
