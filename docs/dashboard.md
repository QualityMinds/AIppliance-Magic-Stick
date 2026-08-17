# Magic Stick Dashboard

The Magic Stick Dashboard is the user interface for the Appliance control plane.
It reads Kubernetes status and writes runtime intent resources. It does not
directly install workloads, create Flux Kustomizations, or manage app resources
itself.

For the step-by-step end-user workflow after first-run setup, see
[installation/after-installation-dashboard.md](installation/after-installation-dashboard.md).

```text
Dashboard UI
  -> Envoy Gateway OIDC login
  -> Dashboard Backend API
     -> Kubernetes API
        -> ModuleActivation, AppInstance, and ModelActivation CRs
        -> Magic Stick Operator
        -> Flux Kustomizations, HelmReleases, and native KubeAI Model resources
     -> dedicated Keycloak user-administration client
        -> Keycloak Admin REST API
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
- read the generated LiteLLM UI password and API master key when an operator or
  administrator explicitly opens the module credential panel
- read OpenClaw instance credentials when the generated instance exposes them
- list and administer human Keycloak users when the signed-in actor has
  `magicstick-admin`

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw, Hermes,
Paperclip, KubeOpenCode, KubeAI, LiteLLM, or direct app instance reconcilers.

## UI Areas

| Area | Purpose |
|---|---|
| Overview | Shows appliance health, module/instance/model counts, and the complete local, public, or direct URLs discovered for modules and app instances from Ingress, Gateway API `HTTPRoute`, and instance status. |
| Modules | Renders grouped module cards from the module catalog and writes `ModuleActivation` intent. |
| Instances | Shows instance cards and opens a two-step create dialog for installed/supported operators: choose the instance type, then configure only that type. |
| Models | Creates/removes local and external model activations and estimates local model VRAM. |
| Users | Gives administrators a paginated Keycloak user overview and local-user lifecycle controls. |
| System Status | Shows Flux, Pod, Service, Ingress, and Event status. |
| Settings | Edits appliance-wide public and mDNS domain settings. |

## Backend API

The frontend Deployment contains only nginx and the HTML renderer and does not
receive a Kubernetes ServiceAccount token. nginx proxies `/api/*` to the
dedicated `identity-system/ai-appliance-dashboard-api` Service. That API runs in
its own single-replica Deployment and uses
`ConfigMap/ai-appliance-dashboard-api`. Envoy Gateway requires a Keycloak login
for both the local and public dashboard hostnames and forwards the access token.
The API validates the token against Keycloak before applying its own role
checks.

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
| `GET` | `/api/modules/{name}/credentials` | Returns credentials for an enabled catalog module with an explicitly supported provider, currently LiteLLM. |
| `GET` | `/api/instances` | Returns `AppInstance` resources and status. |
| `GET` | `/api/instances/{name}/credentials` | Returns supported generated credentials for an instance, currently OpenClaw. |
| `POST` | `/api/instances/{type}` | Adds or replaces an `AppInstance` for supported types such as `openclaw`, `hermes`, `odysseus`, `paperclip`, or `kubeopencode`. |
| `DELETE` | `/api/instances/{name}` | Deletes the `AppInstance`; its finalizer removes the generated HelmRelease and Helm cleans the application resources. |
| `GET` | `/api/models` | Returns model catalog entries, model presets, `ModelActivation` resources, AnythingLLM status, and VRAM summary. |
| `POST` | `/api/models/estimate-vram` | Estimates VRAM for public HuggingFace model metadata, context size, and max sequence count. |
| `POST` | `/api/models/local` | Adds or replaces a local KubeAI-backed `ModelActivation`. |
| `POST` | `/api/models/external` | Adds or replaces an external LiteLLM-backed `ModelActivation`; Dashboard-entered API keys are stored as Secrets. |
| `POST` | `/api/models/local-runtime/remove` | Removes automatically enabled KubeAI and GPU module activations after all local models have been removed. |
| `DELETE` | `/api/models/{name}` | Deletes the `ModelActivation` and a Dashboard-created provider Secret when present. |
| `GET` | `/api/status` | Returns Appliance, Flux, Pod, Service, and Ingress status summaries. |
| `GET` | `/api/events` | Returns core and `events.k8s.io` event summaries. |
| `GET` | `/api/users?search=&first=&max=` | Searches human Keycloak users with bounded server-side pagination. |
| `GET` | `/api/users/{id}` | Returns one sanitized human-user representation. |
| `POST` | `/api/users` | Creates a local user with a temporary password and selected access level. |
| `PATCH` | `/api/users/{id}` | Updates locally managed profile fields. |
| `PUT` | `/api/users/{id}/roles` | Replaces only the direct MagicStick access roles and preserves unrelated roles. |
| `POST` | `/api/users/{id}/enable` | Enables the account. |
| `POST` | `/api/users/{id}/disable` | Disables the account and requests a Keycloak logout. |
| `PUT` | `/api/users/{id}/password` | Sets a temporary local password and requests a Keycloak logout. |
| `DELETE` | `/api/users/{id}` | Deletes an eligible local account. |

All read endpoints require `magicstick-viewer`, `magicstick-operator`, or
`magicstick-admin`. Instance credential reads and runtime mutations require
operator or admin. Settings changes require admin. Envoy authentication alone
does not authorize a configuration change. All `/api/users` endpoints require
`magicstick-admin`, re-check that the actor is still enabled and still an
administrator in Keycloak, and return only sanitized fields and capability
flags. User mutations also require same-origin browser metadata and the
`X-MagicStick-CSRF` request marker used by the dashboard UI.

## User Controls

The **Users** tab is hidden unless `/api/session` contains
`magicstick-admin` and does not report `identityManagementAvailable: false`.
This is only a presentation rule; the backend independently enforces the same
authorization. The user list is loaded lazily when an administrator opens the
tab and after a mutation. It is not part of the global 30-second dashboard
refresh. A direct-external-provider overlay has no local Keycloak administration
surface, so it reports identity management unavailable and the tab stays hidden.

The table shows username, display name, email, enabled state, identity source,
creation time, direct MagicStick roles, and effective access. Search is
server-side and bounded to 10, 25, or 50 results per page. Status and identity
source filters operate on the current page. The **Create User** button remains
visible at the top of the tab while it is open.

The access selector maps to direct realm roles:

| Access level | Direct roles managed by the dashboard |
|---|---|
| User | `magicstick-user` |
| Viewer | `magicstick-user`, `magicstick-viewer` |
| Operator | `magicstick-user`, `magicstick-operator` |
| Administrator | `magicstick-user`, `magicstick-admin` |

Role updates preserve unrelated realm roles and roles inherited from groups.
The dashboard displays effective roles for orientation but does not attempt to
remove group-derived access.

Local users support profile changes, direct MagicStick role changes,
enable/disable, temporary-password reset, and deletion when the API capability
flags allow the action. Brokered or federated users are shown only after
Keycloak knows them. Their upstream profile and password remain read-only;
MagicStick roles and local enabled state may still be managed when permitted.
External users are disabled rather than deleted because deleting a Keycloak
shadow account neither deletes the upstream identity nor prevents it from
returning on a later broker login.

The server blocks self-disable, self-delete, self-demotion, recovery-account
changes, and any operation that would remove the last enabled administrator or
last enabled local administrator. The UI consumes per-user capability flags and
explains unavailable actions, but callers must rely on the backend response as
the authorization decision.

Passwords are accepted only in create and reset forms, sent directly to the
backend over the protected same-origin route, and immediately cleared from the
browser form after submission. They are never returned by the API or rendered
into the user list. Passwords created here are temporary and must be changed at
the next Keycloak login.

Disable, access reduction, password reset, and deletion request a server-side
Keycloak logout. This ends the Keycloak session, but an already issued JWT can
remain valid at Envoy's local JWT filter until that token expires. The
user-administration API itself performs a live actor lookup, so a disabled or
demoted administrator loses that API access immediately even while an older
edge token still exists.

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

Catalog entries with a supported `credentials.provider` show a **Credentials**
action only to operators and administrators while the module is enabled. For
LiteLLM, the panel exposes `admin` plus the generated master key used as the UI
password, API authorization value, and local/public API URLs. The API reads
only the fixed `ai/litellm-masterkey-secret`; catalog data cannot redirect it to
another Secret. Credential responses use `Cache-Control: no-store`.

This includes the optional `gpu` and `kubeai` modules. They stay disabled on a
fresh installation, may be enabled automatically by a local model, and may also
be enabled or disabled manually. A manual action takes ownership away from the
automatic local-model cleanup flow. KubeAI reports `WaitingForModules` until
its GPU dependency is enabled and ready.

Progress is phase-based. The dashboard maps existing status phases such as
`Disabled`, `WaitingForModules`, `Starting`, `Reconciling`, `Removing`, `Ready`, and
`Degraded` to visual progress states. These percentages are orientation hints,
not scheduler- or operator-reported completion percentages.

## Instance Controls

Instances are runtime requests stored as `AppInstance` resources in namespace
`ai-system`. The dashboard shows create controls only for instance types whose
required modules are installed or installable according to the module
catalog and current module status.

`Create Instance` opens a two-step dialog. The first step lists every instance
type in the application catalog, such as OpenClaw, Hermes, or Paperclip. Types
whose required modules are not Ready remain visible but disabled and identify
the missing modules. After selecting an available type, the second step renders
only that application's fields. `Back to types` keeps the workflow in the
dialog without exposing the other configuration forms.

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
are reported in `AppInstance.status` and displayed on the instance card. The
catalog marks these AI application routes as streaming-capable, so their total
Envoy request timeout is disabled without changing the bounded SSO callback
routes.

Envoy Gateway is also the browser authentication boundary for application
instances. Hermes is configured against the in-cluster LiteLLM endpoint.
Paperclip runs in private `local_trusted` mode behind an in-pod loopback proxy,
and Odysseus disables its application-local login, so neither presents a second
login after the shared SSO check. Their Services remain ClusterIP-only and are
reached externally only through the operator-generated authenticated routes.

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
The preset selector is populated from `ConfigMap/magicstick-model-presets` and
includes the `qwen3827b` profile for
`hf://cyankiwi/Qwen3.8-27B-AWQ-INT4`. Selecting a preset fills its tested VRAM,
context, output-token, and concurrency values before the activation is
submitted. The model catalog propagates those limits into managed KubeOpenCode
templates.

The default dashboard is GPU-neutral. External models do not require or activate
GPU or KubeAI modules. The local-model form stays disabled until both the GPU and
KubeAI modules are enabled and report `Ready`; it names every missing or pending
module and directs the operator to the Modules screen. The API enforces the same
precondition and returns HTTP `409` if a client attempts to bypass the UI.

The Models screen treats missing DCGM metrics as a neutral state while the local
runtime is not installed and exposes runtime removal only when no local model
still depends on it.

Catalog-only models are read-only in the Models screen. Remove actions are shown
only for `ModelActivation` rows that the dashboard can delete.

A local model is shown as `Starting` until KubeAI reports a ready vLLM replica.
The status message includes the ready-replica count, for example `0/1 replicas
ready`. `Ready` therefore means both that the local runtime is serving its
health endpoint and that the generated catalog has published the model.

## RBAC

Only the API Deployment uses the ServiceAccount
`identity-system/ai-appliance-dashboard-api`; the frontend Pod disables
automatic ServiceAccount-token mounting. The API permissions are intentionally
narrow:

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
- read only `Secret/magicstick-user-admin-client` in `identity-system` for the
  dedicated Keycloak client-credentials flow

The API ServiceAccount does not have cluster-admin and does not have permission
to create workloads directly. It cannot list identity Secrets and cannot read
the Keycloak bootstrap administrator or first-run setup client Secret. A
`Recreate` deployment strategy keeps exactly one mutating API process active so
the last-administrator guard cannot race across rolling replicas.

## Public-Safe Values

Examples use only `example.local`, `example.com`, `CHANGEME`, and documented
variables or public model preset identifiers. Real domains, external repository
paths, credentials, kubeconfigs, and customer values belong in runtime settings,
runtime Secrets, or optional external overlays.
