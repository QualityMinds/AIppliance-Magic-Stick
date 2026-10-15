# Dashboard API and authorization

The Magic Stick Dashboard is the user interface for the Appliance control plane.
It reads Kubernetes status and writes runtime intent resources. It does not
directly install workloads, create Flux Kustomizations, or manage app resources
itself.

Model create/update payloads accept optional `local.capabilities` or
`external.capabilities` objects containing `tools`, `vision` and `reasoning`
booleans. Omitted fields remain unknown; string/numeric booleans and unsupported
keys are rejected. Model edits retain the existing revision check and preserve
unmodified capability settings; `capabilities: null` on an edit removes the
declaration. Registered models return the effective optional `capabilities`
object. See [Model capabilities](model-catalog.md#model-capabilities).

For the step-by-step end-user workflow after first-run setup, see
[installation/after-installation-dashboard.md](../get-started/first-model.md).

```text
React browser dashboard
  -> Envoy Gateway OIDC login and forwarded access token
Terminal client (CLI or TUI)
  -> Keycloak Device Authorization Flow
  -> Envoy Gateway JWT validation on api.<mDNS-domain>
Both
  -> Dashboard Backend API
     -> Kubernetes API
        -> ModuleActivation, AppInstance, and ModelActivation CRs
        -> Magic Stick Operator
        -> Flux Kustomizations, HelmReleases, and native KubeAI Model resources
     -> dedicated Keycloak user-administration client
        -> Keycloak Admin REST API
     -> dedicated Keycloak federation-administration client
        -> managed OIDC/SAML providers and fixed role mappers
     -> LiteLLM key-management API
        -> named virtual API keys in LiteLLM PostgreSQL
     -> Keycloak Kubernetes access groups
        -> OIDC-authenticated Kubernetes API and RBAC
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
- create, list, and revoke Dashboard-managed named LiteLLM virtual keys when
  the signed-in actor has `magicstick-admin`
- assign SSO-bound Kubernetes access to existing Keycloak users and generate
  token-free OIDC kubeconfigs when the signed-in actor has `magicstick-admin`
- validate, create, update, disable, and delete dashboard-owned upstream OIDC or
  SAML providers and exact claim/attribute-to-role mappings when both a live
  administrator and the `federated-sso` entitlement permit it

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw, Hermes,
Paperclip, KubeOpenCode, KubeAI, LiteLLM, or direct app instance reconcilers.

## Backend API

### Regression runs

All `/api/regression` routes require a Dashboard administrator; mutations use
the existing same-origin/CSRF protection and verify the live administrator.
They do not require, consult or activate a product license. Missing, expired,
invalid or unavailable license status must not gate the runner lifecycle or
report downloads; this does not bypass entitlement checks in individual tests.
No request accepts a runner image, URL, script, command, manifest or credential.

| Route | Contract |
| --- | --- |
| `GET /api/regression` | Registration/runtime readiness, latest 30 runs, progress/results, lock state and external-runner limitations. Read-only. |
| `POST /api/regression/register` | Exact `confirmation: "DISPOSABLE TEST SERVER"`, `acknowledgeDisruption: true`; immutable Appliance/Node-bound test marker, no production fallback. |
| `POST /api/regression/runs` | 32-lowercase-hex `requestId`, `acknowledgeDisruption: true`; idempotent `RegressionRun` intent and generated private test account. All P0 phases; no UI Job writes. |
| `POST /api/regression/recover-lock` | 32-lowercase-hex `requestId`, reviewed `expectedLockRevision: "<Lease UID>:<resource version>"`, `acknowledgeCleanup: true`; idempotent recovery-only intent. No test phases or forced Lease deletion. |
| `GET /api/regression/runs/<id>` | Durable run status. |
| `POST /api/regression/runs/<id>/cancel` | `acknowledgeDisruption: true`; cancellation intent, bounded teardown, retained recovery evidence. |
| `GET /api/regression/runs/<id>/archive`, `/html`, `/junit` | Allowlisted completed report attachment, at most 64 MiB; never private input/journal/log download. |

Run IDs are `regression-<32 hex characters>`. The operator, not the browser/API,
creates Jobs in `magicstick-regression`. Phases are `Queued`, `Preparing`,
`Starting`, `Running`, `Recovering`, `Cancelling`, and terminal `Passed`,
`Failed`, `Blocked`, `Cancelled`. Kubernetes Job completion means execution
finished, not that the suite passed. Blocked rows expose fixed reason/action,
phase/variant/layer and available stage/trace identity. Credentials are deleted
by a restart-safe API cleanup worker only after the exact run-owned Pod has
terminated and setup/recovery completed, using exact user attributes and Secret
UID/resource-version checks. A killed/interrupted setup retains the generated
identity needed by its private restoration receipt. `recoveryAvailable` allows
the next run to reuse that exact original account after Pod termination and
Lease drain, before ordinary tests. It never substitutes the human's account or
clears a lock. Successful recovery cleans the whole credential lineage.

Normal start performs the same old-run cleanup before a fresh test execution;
no successful rows or test progress are resumed. The separate cleanup action
keeps its existing `/recover-lock` route and `operation: recover-lock` contract.

`lock` contains `state: free|active|stale|blocked`, `canRecover`, a fixed public
`message`, and an optional opaque `revision`. Only a terminated, installation-
bound Kubernetes run with a known journal owner can offer recovery; external
journals are unavailable to the Dashboard. Actual journal and resource-UID
verification occurs in the runner, not in status polling. Confirmation binds
the reviewed Lease UID/resource version and original journal run ID; changed
locks are refused before cleanup. Recovery runs expose `operation: recover-lock`
and `phases: []`; ordinary and older runs use `operation: tests`. Recovery uses
the same retained storage, generated-identity restoration and scoped adapters,
does not prepare fixtures or launch tests, and publishes a sanitized report.

Outcomes remain `Passed`, `Failed`, or `Blocked`. New reports add optional
`blockedBy` to blocked cases: `kind` is `prerequisite`, `failure`, `cancelled`, or
`unknown`; recorded `caseId`, `reason`, `stage`, `executionId`, and `traceRunId`
identify the blocking check. Only catalogue IDs, known reason/stage values and
validated trace identities are exposed. A dependency inherits its own recorded
scenario cause, never an unrelated failed test.
`result.blockedCounts` counts case/variant/layer evidence by those four kinds;
`result.executionBlockedCounts` and `progress.executionBlockedCounts` count
blocked executable scenarios separately. Phase result rows carry both breakdowns.
A scenario that failed remains one Failed execution even if some of its evidence
rows were blocked. Older responses remain compatible; absent cause evidence is
shown as unavailable/unknown. JUnit keeps blocked rows as `<skipped>` and adds
`blockedKind` and recorded `blockedByCase`, `blockedByReason`, `blockedByStage`,
`blockedByExecution`, and `blockedByRun` properties.
New reports mark a missing required execution/layer record with
`MISSING_EVIDENCE` at `report-evidence` as a harness failure. A recorded cleanup
failure retains its original case, step and trace across child and phase
boundaries. Historical reports are read without synthesizing new outcomes.

`result.preparation` is optional. When present, it exposes the sanitized
automatic preparation outcome, fixed reason/stage/detail, a public explanation
and next action. `result.evidenceCounts` optionally separates `fixture` and
`live` Passed/Failed/Blocked evidence; it is omitted for older reports without
complete environment labels. A Failed preparation can coexist with Passed
fixture checks and zero Passed live checks. Neither a missing field nor a green
fixture count is evidence of live acceptance. These fields never include raw
worker output or private paths. Failed lock recovery also exposes its bounded
setup diagnostic in the recovery result and status message; it does not release
the Lease or mark a historical run Passed.

`ModuleActivation/regression` installs the optional report service, scoped RBAC
and retained storage; it is disabled by default. Runner image and SHA are
CI-owned, never selected by a dashboard request. Registering a new installation
does not silently adopt an older test marker.

### Local configuration policy

`/api/models` exposes the existing compute-target catalog as
`computeTargets.engineCatalog`. Engines and Realtime profiles can advertise
`configuration: {sources, discovery, memory, task, maxOutputTokens}` for the
shared Create/Edit form. Source choices are `search|preset|direct`; discovery
uses artifacts or whole repositories; memory uses ordinary estimates or staged
planning. This presentation metadata adds no engine or mutation endpoint.
Existing KV choices, target availability, GPU strategies and CPU defaults remain
authoritative. The create/update API still validates the selected runtime intent.

Omni accepts the existing `local.cpuResources` alongside `local.realtime`.
Partial edits preserve omitted fields; `cpuResources: null` removes the override.
The same immutable engine/source/target and expected-revision protections apply.
Ordinary KV, parallelism, vision overrides and MiB budgets remain rejected for
the current Omni adapter. See [model controls](model-controls.md).

### Automatic model task detection

Local creation accepts `local.modelType: "auto"`. The API resolves the task
before saving a `ModelActivation`; its stored value is always `chat` or
`embedding`. A tested preset's task is authoritative. For dynamic models, Hugging
Face pipeline metadata identifies the task, with a generation architecture as
a fallback when no pipeline tag exists. Ollama follows its runtime's complete
GGUF metadata: an architecture-specific `pooling_type` key identifies embedding;
without it the model supports completion. Missing/incomplete metadata stays
unknown. Repository names and GPU selection are not task evidence.

`POST /api/models/estimate-memory` accepts `modelType: "auto"` and returns
`detectedModelType: "chat" | "embedding" | null`. Unknown metadata uses a
conservative Chat estimate but does not choose a task for creation. The caller
must then submit an explicit `chat` or `embedding`; unresolved automatic creation
returns HTTP 400. Explicit types and older callers that omit the field remain
supported. Discovery accepts an empty `modelType` to list both tasks.

### Application model parameters

Catalog-owned module parameters of `type: "model"` declare a `modelType` of
`chat` or `embedding`. A nonempty value must match an available model ID of that
type in the generated catalog, otherwise enabling returns HTTP 409. Empty values
use the application's catalog default. AnythingLLM's `chatModel` and
`embeddingModel` parameters seed missing native preferences; they do not change
global model defaults or overwrite saved application settings and indexes.

### NVIDIA multi-GPU models

The existing local-model create, estimate, edit, start and stop endpoints remain
the only control path. Optional `local.gpuDeployment` selects `single`, `split`
or `replicated`. Omission preserves existing single/split behavior; replication
must be explicit. A local model may supply `gpuDevices` instead of
`gpuDevice`; both contain exact node-UID/GPU-UUID identities from `/api/models`.
The API validates the entire same-node NVIDIA group, its live DRA state,
every slot, per-card physical/unreserved VRAM and the combined host RAM budget. A memory
risk acknowledgement cannot bypass slot admission, hardware identity, physical
VRAM capacity or the group's verifiable host RAM ceiling.

For DRA-bound `computeMemory.devices`, `gpuCapacityMi` and
`gpuCapacitySource: nvidia-dra-inventory` expose physical capacity from the
current NVIDIA DRA inventory. Group exact identities on the same node with known
positive capacities; GPU models and capacities may differ. `productName` is a
display value rather than an equality requirement. An unknown inventory capacity
must not fall back to a telemetry value. `totalMi` retains its live/planning
meaning: DCGM free plus used memory when measured, or inventory capacity when
no sample exists; the latter keeps `freeMi: null` and `metricsAvailable: false`.
Different live totals do not determine group eligibility. The maximum equal
per-card budget is the minimum unreserved capacity across selected cards, also
bounded by every card's physical inventory capacity.

`/api/models/estimate-memory` returns `gpuCount`, `gpuParallelism`,
`memoryBudgetScope: per-device`, `devices` and `systemMemoryMaximumMi` for a
group. Weight estimates account for sharding with headroom; KV cache/runtime
remain conservative per-card estimates. vLLM model dimensions are checked during
estimation and the pinned runtime rechecks model support before loading. A
successful estimate is not proof of successful inference.
Each `devices` entry retains live/planning counters and also returns physical
`gpuCapacityMi`/`gpuCapacitySource`; physical admission uses the inventory value.

In `replicated` mode each card receives the full weights/cache estimate, not a
shard. The estimate includes `replicaCount`; `systemMemoryMaximumMi` is the
per-copy RAM ceiling (node budget divided by copy count). `memoryRequiredMi`
and `cpuResources` apply per copy. `vllm.parallelism` is invalid in this mode,
and `minReplicas`/`maxReplicas` remain 1 per internal runtime; card count determines
the number of copies. Capabilities advertise supported `deploymentModes` centrally.

`status.replication` reports ready/desired copies and individual status. The
existing administrator-only logs endpoint accepts optional
`?replica=<internal-copy-name>` from its `replicas` response list; it checks
parent UID, child ownership and exact Pod owner UID. The response remains
bounded, and arbitrary Pod names or another activation's copies are not accepted.

Edit preserves the same activation and uses the existing optimistic revision
check. Setting one selection representation replaces the other. Stop retains the
configuration; a terminating Pod keeps its slots until allocation release.
See the [resource contract](kubernetes-resources.md) and
[administrator workflow](../administration/gpu-sharing.md#one-model-across-several-nvidia-gpus).

### Module parameters and local identities

Module enable/disable requests accept only a `parameters` object with fields
declared by that module in the shared catalog. Values are strings (maximum 4096
characters); the AMD profile validator retains its existing boolean normalization.
Unknown fields and invalid values receive HTTP 400 before runtime intent is
written. Hardware GPU sharing still uses its dedicated, revision-safe endpoint.

An explicit parameter map replaces the previous map, including removal of legacy
unknown fields. Omitting the map preserves saved parameters. Updates carry the
current Kubernetes resource version so concurrent edits fail rather than being
overwritten. Independently configured GPU sharing is retained by profile edits.

The user API identifies locally managed accounts with `source: "local"`. Clients
must not require a separate `local: true` property. Regression-created accounts
record the acknowledged exact user ID before checking enabled state and roles;
cleanup independently checks that ID, local origin and protected-account status.

### Software channel operations

`GET /api/host-management` includes each managed host's sanitized `software`
status: desired branch/tag/commit, host revision, source/applied Flux revision,
critical running image IDs, last operation, preview and previous revision.
Local repository paths, metadata, process IDs and credentials are not exposed.

Administrators use the existing host-operation endpoint with
`action: check-software-channel` or `apply-software-channel`. Requests carry the
normal node UID, boot ID, unique request ID, node-name confirmation and current
software `planId`, plus `softwareChannel: {kind, value}`. Apply additionally
requires `softwarePreviewId` from an unexpired check of that exact selection.
Other roles, arbitrary repository URLs, shell expressions, shortened commits,
extra fields and stale plans/previews are rejected before any write. A moved
branch is rechecked on the host and cannot silently replace the approved commit.

The API writes a bounded `HostOperation`; the root-owned worker serializes it with
other maintenance and starts `magicstick-software-channel.service`. The browser
does not patch Flux or execute Ansible. The operation remains observable across
dashboard restarts; completed request IDs are not replayed. External-GitOps
installations report the feature unavailable. See
[software channels](../administration/updates-rollback.md) for recovery and limits.

### Other control-plane operations

Administrators configure **Mesh**, a top-level dashboard page, through the opt-in
core `private-mesh` module. No license file is required.
The typed `/api/mesh` status reports runtime availability, and `/api/mesh/<action>`
commands enforce administrator authorization and browser CSRF checks. The
backend supplies creator identity and appliance TLS trust; the browser cannot
choose upstream service credentials. See [Private Mesh](../user-guide/private-mesh.md) for
device roles, invitations, sharing limits, relay reachability and release gates.
Mesh's **Local model sharing** lists ready local chat models from vLLM, Ollama
and Realtime; the overview reports **Local models** rather than an individual
engine. Sharing uses the existing backend through LiteLLM, never a second copy.
**Join Mesh** remains visible in the Mesh view before and after setup.
Its dialog enables the module if needed, then accepts a device name and a
single-use invitation. Existing membership must be explicitly left before
joining another mesh; opening the dialog does not change anything. Invitation
tokens are cleared on close/success and are not persisted in browser storage.

The single browser frontend Deployment is presentation-only and does not receive
a Kubernetes ServiceAccount token. Its image contains the pre-built React bundle
and nginx; no HTML renderer or frontend-code ConfigMap remains. nginx proxies
`/api/*` to the dedicated `identity-system/ai-appliance-dashboard-api` Service. That API runs in
its own single-replica Deployment and uses
`ConfigMap/ai-appliance-dashboard-api`. Envoy Gateway requires a Keycloak login
for both the local and public dashboard hostnames and forwards the access token.
The terminal API route requires a Keycloak Bearer token and validates its JWT at
the edge. The API then validates every browser or terminal token against
Keycloak, trusts only the browser and CLI client IDs, and applies its own role
checks.

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
- read Nodes, Pods, Services, Ingresses, HTTPRoutes, ConfigMaps, and Events
- read the Kubelet node-summary memory value through `nodes/proxy`, with
  read-only `metrics.k8s.io/nodes` access as a fallback
- read the DCGM exporter service proxy for live VRAM metrics
- patch only `flux-system/ai-appliance-settings`
- manage only Dashboard-created provider credential Secrets in namespace `ai`
- read only `Secret/magicstick-user-admin-client` in `identity-system` for the
  dedicated Keycloak client-credentials flow
- read only `Secret/magicstick-federation-admin-client` in `identity-system` for
  the separately scoped Keycloak federation flow
- read the non-secret `ConfigMap/magicstick-kubernetes-access-info` and the
  ServiceAccount-mounted Kubernetes CA to assemble token-free kubeconfigs

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
