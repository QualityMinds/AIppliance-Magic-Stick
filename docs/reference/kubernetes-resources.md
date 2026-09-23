# Kubernetes resources

`status.hardwareOperators.<module>.devices` reports physical PCI GPUs with their
node identity, device-local facts, memory layout and optional per-engine
results. See [device-specific diagnostics](gpu-compatibility.md#device-specific-dashboard-diagnostics)
for request binding and exact-device limitations.

The `Appliance` custom resource is the Git-owned aggregate status surface for
the local Magic Stick installation. Runtime module, instance, and model
requests are represented as separate `ModuleActivation`, `AppInstance`, and
`ModelActivation` CRs so Flux does not overwrite dashboard actions.

The public base installs the CRD and a default `Appliance/local` resource. The
controller Deployment runs in-cluster and reconciles runtime CRs.

## API

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: Appliance
metadata:
  name: local
  namespace: ai-system
spec:
  profile: ai-workstation
  source:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  modules:
    basis:
      enabled: true
    dashboard:
      enabled: true
    litellm:
      enabled: true
    model-catalog:
      enabled: true
```

The CRD is namespaced, with plural `appliances` and short names `msapp` and
`appliance`.

## Spec

| Field | Purpose |
|---|---|
| `spec.profile` | Public profile hint: `minimal`, `ai-workstation`, or `full`. |
| `spec.source` | Flux `GitRepository` source used by generated module Kustomizations. |
| `spec.modules` | Git-owned module defaults. The operator seeds missing `ModuleActivation` resources from enabled entries. |
| `spec.instances` | Deprecated for runtime use. Runtime instance changes use `AppInstance`. |

The default public install uses the GPU-neutral profile `ai-workstation` and
`spec.source.name: flux-system` because readonly-public mode creates that Git
source. It seeds LiteLLM and the model catalog for external providers. KubeAI
is requested for ordinary vLLM/Ollama `ModelActivation` resources. FreeToken
and Realtime use direct Deployments instead. An
accelerator-backed model additionally depends on the matching NVIDIA, AMD, or
Intel module. Independently, the shared NFD module is static and vendor
operator activations are created when their hardware is detected.
External GitOps repositories that include this public repo can use
`magicstick-public`.

Runtime `ModuleActivation` resources take precedence over `spec.modules`.
Disabling a default module by setting `ModuleActivation.spec.enabled: false`
keeps it disabled; the operator only seeds missing activations.

## Modules And Instances

### AMD compatibility intent and evidence

Additional GPU support is runtime intent, not an edit to `Appliance.spec`.
`ModuleActivation/amd-gpu.spec.parameters` accepts these bounded fields:

| Field | Meaning |
| --- | --- |
| `compatibilityProfile` | Catalog profile ID, currently experimental `strix-halo`, or an empty string for upstream-only support. |
| `allowExperimental` | Explicit `"true"` consent required for an experimental profile. |
| `validationRequest` | Optional unique identifier explicitly requesting bounded, resource-consuming engine diagnostics. Empty by default; changing it requests a fresh run. Test outcomes never gate GPU availability. |
| `gpuSharing` | Bounded JSON for `exclusive` or `dra-shared`, selected node name/UID, namespace `ai` and 2–16 model slots. Only the dedicated, revision-checked GPU-sharing API changes it; profile edits preserve it. |

The API restricts these parameters to administrators; it accepts no arbitrary
test image, script or node selector. Profile selection does not itself mean
that a driver, GPU resource or inference engine is ready.

`ModuleActivation/gpu.spec.parameters.gpuSharing` holds the independent NVIDIA
configuration: `exclusive` or `time-slicing`, selected node name/UID, namespace
`ai` and 2–16 shared slots. The common GPU-sharing API translates its public
`exclusive`/`shared` modes into these provider-specific values. Missing settings
preserve the existing NVIDIA device-plugin default. Hardware operator status
`hardwareOperators.gpu.sharing` reports management, desired mode, observed phase,
slot limit and admitted models. No NVIDIA DRA migration is implied.

`Appliance.status.hardwareOperators.amd-gpu.compatibility` contains the selected
profile, catalog profiles and per-node evidence including `profileId`,
`profileVersion`, `upstreamSupported`, `optedIn`, `eligible`, `pciDevices`,
`expectedArchitecture`, `detectedArchitecture`, `hostDriverReady`,
`resourceRegistered`, `hostFingerprint` and `hostBootId`. Per-engine `validation.OLlama` and
`validation.VLLM` expose state, image/image ID, job, timestamps and reasons.
Upstream support is reported distinctly from a locally passed validation.
`compatibility.sharing` records the allocation transition and actual DRA device
inventory. `ModelActivation.status.gpuSharing` records allocation mode and node,
plus the shared claim and PCI device for AMD DRA. See [GPU sharing](../administration/gpu-sharing.md) for these optional
contracts and their non-isolating memory semantics.
`compatibility.validationRequired` is `false`. Host/driver and resource eligibility
remain required; engine tests are advisory. `runtimeReady` describes adoption of
the configured image by KubeAI, independently of a test's state. Boot/host/image
changes make a started request stale, not an automatic new test request.

For shared-memory evidence, `physicalMemoryMi` is the OS-visible `MemTotal` in
MiB, not installed-memory inventory. `gpuAccessibleMi` is a conservative
GTT/TTM bound within that pool. Raw firmware VRAM counters are not added to it.

For unified-memory activations, `ModelActivation.status.memoryArchitecture`
is `unified`, `sharedPoolId` identifies the Node UID, and `memoryRequiredMi`
records the single Linux-RAM request. `gpuAllocationMode` is `firmware-reserved`,
`shared-gtt` or `unknown`: the fixed GPU budget is not charged to Linux twice;
dynamic/unknown allocations retain a conservative shared-RAM request. This does
not certify GPU cgroup enforcement or protect future dynamic capacity. Node host-evidence metadata
is runtime-owned and must not be seeded in public manifests. See
[GPU compatibility](gpu-compatibility.md) for the exact host and validation
contract and [model catalog](compute-targets.md#amd-unified-memory-reservations)
for reservation behavior.

### Application instances

Modules are capabilities. Instances are concrete uses of those capabilities.

For example, creating `ModuleActivation/openclaw-operator` installs the
OpenClaw operator module. Creating an `AppInstance` with
`spec.application: openclaw` asks the Magic Stick Operator to create a Flux
HelmRelease for the OpenClaw instance chart after required modules and CRDs are
available. The chart creates the `OpenClawInstance`.

The operator auto-enables modules required by an enabled instance and reports
that in status. For example, an OpenClaw instance requires:

- `openclaw-operator`
- `litellm`
- `model-catalog`

The dashboard uses `ModuleActivation`, `AppInstance`, and `ModelActivation` as
its only workload intent write surface. The Magic Stick Operator, Flux, the
model-catalog controller, and the specialized operators perform the actual
reconciliation.

A Paperclip instance also auto-enables `paperclip-operator`, `agent-sandbox`,
`litellm`, and `model-catalog`. Its `agentExecution` parameters select available
adapter runtimes and sandbox concurrency without creating domain-level teams or
agents:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: paperclip-default
  namespace: ai-system
spec:
  application: paperclip
  targetNamespace: ai
  values:
    name: default
    model: qwen3635b
    agentExecution:
      defaultModel: litellm/qwen3635b
      maxConcurrentAgents: 2
      openCode:
        enabled: true
      openClaw:
        enabled: false
        instanceRef: ""
      hermes:
        enabled: false
        instanceRef: ""
```

See [paperclip-agents.md](paperclip-agents.md) for the generated adapter,
network, model, and credential contracts.

## Runtime CRs

`HostOperation` is a separate namespaced runtime request for node-local
`prepare-gpu`, `configure-gpu-memory`, `configure-network`, `scan-wifi`, `reboot`
or `poweroff`. Its spec is immutable and bound to a Node
UID, boot ID, unique request ID and explicit disruption acknowledgement; hardware
preparation additionally binds the exact local plan and experiment consent.
The dashboard creates requests, while the local root worker owns status. These
actions never mutate Git-owned `Appliance.spec`. See the [host-management API and
recovery contract](../administration/host-management.md).

`clear-model-cache` additionally binds the current cache `planId` and rejects
all hardware, network and update settings. It accepts no filesystem paths.
The host worker checks workload inactivity and clears only fixed model-cache
locations; uncertain execution is not repeated. See [model cache management](../administration/model-cache.md).

Network operations bind `planId` to the current Netplan/interface inventory and
carry only an immutable `networkRef` (Secret name and UID), never a password in
the CR. `configure-network` adds `Applying`, `AwaitingConfirmation` and terminal
`RolledBack`; status may include `confirmationDeadline`. Explicit confirmation
uses metadata only. See [network management](../administration/network.md).

GPU preparation uses `Registering` after host verification and completes when
fresh eligible GPU registration is confirmed. It does not request or wait for
engine validation. The previous `Validating` phase remains accepted for migration.

`configure-gpu-memory` additionally requires the current memory capability's
`planId`, explicit experimental consent and `gpuMemory` containing only the
integer `carveoutIndex` and `dynamicLimitMi`. It cannot use mixed-system
`experimentMode`; other actions cannot carry `gpuMemory`. The API and root
worker enforce advertised firmware choices, current host/configuration identity,
dynamic-limit steps and the remaining OS RAM allowance. The request contains
desired settings only, not an arbitrary device path or executable payload.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModuleActivation
metadata:
  name: litellm
  namespace: ai-system
spec:
  module: litellm
  enabled: true
  parameters:
    postgresStorage: 5Gi
```

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: openclaw-default
  namespace: ai-system
spec:
  application: openclaw
  enabled: true
  targetNamespace: ai
  access:
    authentication: sso
    role: user
    exposure: localAndPublic
  values:
    name: default
    model: CHANGEME_MODEL
```

Instance hostnames are derived from runtime settings instead of being configured
as arbitrary per-instance values:

```text
<instance-name>.<instance-type>.<domain>
```

For the `openclaw-default` example, the default public and local hosts are
`default.openclaw.magicstick.example.com` and
`default.openclaw.magicstick.local`.

`spec.access` is deny-by-default at the Gateway boundary: omitted values mean
shared SSO, the `user` role, and both derived hostnames. `role` accepts `user`,
`viewer`, `operator`, or `admin`; higher dashboard roles inherit lower access.
Set `exposure: local` to omit the public hostname. Setting
`authentication: none` deliberately creates an unauthenticated route and must
be an explicit review decision.

Optional `spec.access.sharing` adds core instance allow-lists. Its `mode`
is `all` or `selected`; `users` and `groups` each contain at most 100 unique,
stable Keycloak IDs. `all` requires empty lists; `selected` requires SSO and an
empty selection denies everyone. Omission retains role-based access.
The dashboard preserves existing restrictions when an older client omits this
field. See [instance-sharing.md](../user-guide/sharing.md).

For every enabled instance, the operator creates the required application and
per-instance callback `HTTPRoute` objects, cross-namespace `ReferenceGrant`,
and Envoy `SecurityPolicy` objects with fail-closed instance guards (plus OIDC
and role authorization for SSO). `status.accessGuardReady` becomes true only
after the current guard policies are accepted. Until then routes have no app
backend. The callback route shares the
dashboard hostname but uses an exact, instance-specific path. Application
routes for the catalogued AI workloads set `timeouts.request: "0s"` so streamed
responses are not cut off by Envoy's 15-second default; callback routes remain
bounded. The application charts no longer create nginx `Ingress` resources.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: qwen352bvlembedding
  namespace: ai-system
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen352bvlembedding
    artifact: awq-int4
    computeTarget: nvidia-gpu
    vram: 5Gi
```

CPU example; no GPU module or VRAM field is required. `memoryRequiredMi` is the
RAM reserved for the generated model pod through Kubernetes
`resources.requests.memory`:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: qwen2505bcpu
  namespace: ai-system
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen2505bcpu
    artifact: bf16
    computeTarget: cpu
    engine: VLLM
    kvCacheType: auto
    memoryRequiredMi: 4096
    kvCacheMemoryBytes: 536870912
```

The same field is used for `engine: OLlama`; its bundled default is 2048 MiB.
The API accepts positive values from 16 MiB. The operator rounds custom values
up to a 16 MiB resource-profile unit before creating the KubeAI `Model`. If the
field is absent on an existing activation, the operator uses the engine default
(4096 MiB for vLLM or 2048 MiB for Ollama).
For CPU vLLM models created through the dashboard, `kvCacheMemoryBytes` is
derived server-side from HuggingFace architecture metadata, context size, and
maximum sequences. Direct and legacy resources may omit it and receive the
operator's 512 MiB compatibility fallback.

`local.kvCacheType` selects cache precision independently from weight
quantization. Defaults preserve existing resources: `auto` for vLLM and `f16`
for Ollama. vLLM accepts `fp8` only with `computeTarget: nvidia-gpu` or
`amd-gpu`; CPU and Intel XPU accept only `auto`. Ollama accepts `f16`, `q8_0`,
or `q4_0` on each supported Ollama target. The API and operator both reject
incompatible combinations rather than starting with a silent fallback.

`local.artifact` is an ID from the preset variant selected by `engine` and
`computeTarget`. For example, Qwen presets can expose `bf16`, `fp8`,
`awq-int4`, `gptq-int4`, `q4-k-m`, or `q8-0` where the runtime and target are
compatible. Every variant declares one `defaultArtifact`, so the field remains
optional for resources created before artifact selection existed. Unknown IDs
are rejected. The operator resolves the artifact URL and its precision,
quantization, and memory defaults from the Git-owned catalog rather than
accepting arbitrary runtime flags.

The same portable preset can target AMD ROCm or Intel XPU when the dashboard
reports that provider as available:

```yaml
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen2505bcpu
    artifact: bf16
    computeTarget: amd-gpu # alternatively intel-gpu or nvidia-gpu
    engine: VLLM
    vram: 4Gi
```

The API and operator resolve the KubeAI resource profile; clients cannot choose
an arbitrary profile. For Intel this selects the `xe` or `i915` profile from
the resource actually published by Kubernetes.

Ollama uses the exact KubeAI engine value `OLlama` and an `ollama://` model
reference. The bundled portable preset supports CPU, NVIDIA, and AMD ROCm:

```yaml
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen2505bcpu
    artifact: q4-k-m # alternatively q8-0 or fp16 for this preset
    computeTarget: cpu # alternatively nvidia-gpu or amd-gpu
    engine: OLlama
    kvCacheType: q8_0
    memoryRequiredMi: 2048
```

Intel is currently a vLLM-only target. An Ollama/Intel activation is rejected
until a validated KubeAI image and resource profile are added.

For vLLM, the operator maps the field to `--kv-cache-dtype`; FP8 additionally
enables dynamic K/V scale calculation. For Ollama it sets
`OLLAMA_KV_CACHE_TYPE` and `OLLAMA_FLASH_ATTENTION=1`. Status exposes
`requestedKvCacheType` immediately and `effectiveKvCacheType` only after the
generated runtime has a Ready replica. The latter confirms the applied startup
configuration, not measured cache allocation.

### CPU scheduling fields

`spec.local.cpuResources` optionally contains integer `requestMillicores`
(minimum 1) and `limitMillicores` (minimum 0; zero means no quota). Missing
fields inherit the engine/target defaults. A positive limit must be at least
the effective request, including when the request is inherited. The API and
controller both validate this rule; the CRD also rejects explicitly conflicting
values. `status.cpuResources` exposes the resolved per-replica values. The
dashboard can remove the override using `local.cpuResources: null` in its
revision-bound edit API. This field is independent of `memoryRequiredMi`,
`vramMi`, `cpuOffloading` and engine thread settings. See the
[CPU scheduling policy](compute-targets.md#cpu-scheduling-policy).

### vLLM deployment fields

`spec.local.vllm.visionAttention` accepts `auto`, `aotriton`, `triton`, or
`flash-attn-triton`. The nested object is vLLM-only; its current catalog target
is `amd-gpu`; an object without a value defaults to `triton`. An omitted object
preserves existing args/env. An explicit `auto`
removes managed vision overrides and lets vLLM choose. It does not clear other
runtime settings or change the model source. The revision-bound local-model
edit API accepts `local: {vllm: {visionAttention: "auto"}}` (or a manual value).
The controller applies the same catalog validation to direct CR requests.
See [vision attention deployment](compute-targets.md#vllm-vision-attention-deployment)
for exact CLI/environment mappings and runtime requirements.

### FreeToken deployment fields

`spec.local.engine: FreeToken` selects the dedicated runtime. Settings live only
under `spec.local.freetoken`; vLLM/Ollama offloading and KV-cache controls do not
apply. `gpuDevice` selects the node inventory entry, `gpuCount` requests whole
NVIDIA devices, and `gpuMemoryMi` is an aggregate planned VRAM budget.
`systemMemoryMi` is the Pod RAM request and limit, not a native FreeToken flag.
`memoryStrategy` accepts the catalog's bounded choices and defaults to `auto`.

Context and concurrency remain `local.contextWindow` and `local.maxNumSeqs`.
Optional `advanced` values and `restartNonce` are defined in the
[ModelActivation schema](../../magic-cluster/platform/magicstick-operator/crds/modelactivations.appliance.magicstick.dev.yaml).
API/controller capability checks remain stricter than the structural schema.
See [FreeToken runtime mapping](freetoken.md) for exact flags and limitations.

### Realtime profile fields

`spec.local.realtime` selects a catalog vLLM-Omni profile while retaining
`engine: VLLM`. Required fields are `profile` and `gpuNode`. Profiles cover
CUDA, ROCm, XPU and CPU; no profile enum or device/model allowlist is imposed
by the CRD. The API/controller validate the selected catalog backend, valid
inputs and actual schedulable resources. Ordinary engine settings do not leak in.

Typed settings are `gpuCount`, `systemMemoryMi`, `gpuMemoryFraction`,
`thinkerCpuOffloadGiB`, optional `runtimeImage` and `restartNonce`.
The optional image overrides only the container image for that activation;
empty uses the catalog default. Custom images receive no pinned-source patch.
Context/concurrency remain `local.contextWindow` and `local.maxNumSeqs`.
CPU has no GPU request. Shared NVIDIA/DRA requires `gpuCount: 1`; exclusive
allocation offers the shipped one-/two-device plans.

`local.url` is a canonical HF repository reference, not a reviewed model
allowlist. No Magic Stick config.json, quantization, architecture or stage
completeness check runs at creation, edit, restart or bootstrap. Runtime errors
remain visible. RAM estimates are advisory, but node RAM capacity, slot admission
and claim identity checks remain. Source/profile remain immutable in Edit.
See the [full contract](realtime.md#configuration-contract).

### CPU offloading fields

The optional NVIDIA `spec.local.cpuOffloading` boolean has **no CRD default**:
omission preserves legacy runtime behavior; explicit `false` requests no weight
offloading. `true` currently supports one NVIDIA-backed vLLM or Ollama replica
only. Ollama has exactly one enabled policy: GPU-first auto-fit. There is no
manual layer count or alternative balancing mode.

| Field | Contract when offloading is enabled |
|---|---|
| `vram` / `vramMi` | GPU memory planning budget; separate from system RAM. |
| `memoryRequiredMi` | Total host RAM including offloaded weights, runtime and chosen startup headroom; rendered as equal Pod memory request and limit. |
| `cpuOffloadMi` | API-derived vLLM weight budget, converted to GiB by the wrapper. Zero for Ollama; not a KV budget. |
| `ollamaGpuLayers` | Deprecated compatibility field. The current operator ignores it when offloading is enabled; Ollama GPU-first auto-fit owns the layer count. |
| `allowMemoryRisk` | Optional explicit boolean accepting insufficient/uncertain memory estimates or unavailable capacity. Also applies to CPU vLLM minimum checks. Omission/false keeps strict preflight validation. Does not change requests, limits, cache settings, authorization, or hardware support. |

For normal API/CLI creation, submit only `cpuOffloading`, the RAM/VRAM budgets
and model/context inputs. The API recomputes both engine-specific fields;
client-supplied derived values are ignored. The estimator's `offloading` object
reports `ramMinimumMi`, `ramRecommendedMi`, `ramMaximumMi`, `gpuMinimumMi`,
`gpuRecommendedMi`, `fitsVram`, and the separated weight/cache/runtime estimates.
An unknown maximum is `null`, not zero. Insufficient/unknown budgets require
`allowMemoryRisk: true`; the dashboard records this when its warning-styled Add
button is used. Invalid combinations and more than one replica remain rejected.
Administrators creating CRs directly must supply the vLLM offload budget where
applicable; Ollama derives no fixed layer control. The operator validates target,
replica count, positive RAM and engine controls.
Only the estimated host-runtime coverage check is skipped by the explicit flag.
Neither the flag nor a successful creation guarantees a running model.

`status.cpuOffloading`, `status.memoryRequiredMi`, and
`status.resolvedResourceProfile` expose applied intent. Optional
`status.memoryUsage` contains Ollama `/api/ps` reports (`ramMi`, `vramMi`,
`totalMi`, `source`, `sampledAt`, `replicas`), not process RSS or resource requests.
Missing/unloaded runtime samples clear that object. Profile values are generated
outside Git-owned `Appliance/local.spec`; see [operator responsibilities](../concepts/controllers.md).

### External activation example

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: example-openai-gpt-4o-mini
  namespace: ai-system
spec:
  type: external
  enabled: true
  targetNamespace: ai
  external:
    model: openai/gpt-4o-mini
    apiBase: https://api.openai.com/v1
    modelType: chat
    apiKeySecretRef:
      name: external-openai-api-key
      key: api-key
```

For a KubeAI-backed local activation, `status.phase: Starting` means that its KubeAI `Model`
and a non-terminating model Pod exist but `status.replicas.ready` is still zero.
Without a Pod, the phase is `WaitingForPod`, then `Degraded` with reason
`ModelPodCreationStalled` after two minutes. `status.podCreation` stores `since`
and a `revision` bound to model UID/generation and activation generation so the
timer survives controller restarts without penalizing a changed configuration.
It is cleared once a Pod exists. Reconciliation continues and automatically
recovers; there is no time limit on image/model downloads in an existing Pod.
Terminal owned Pods are a separate case: `status.podRecovery` persists the
revision, attempt count, last attempt time, Pod UID and original failure.
The controller deletes only exact Model-owned `Failed`/`Succeeded` Pods using
identity preconditions. Five bounded attempts are allowed, then the phase is
`Degraded` with reason `ModelPodRecoveryExhausted`. Readiness or a changed
desired revision resets recovery; pending/running Pods and shared GPU claims
are never deleted by this path.
The local activation becomes
`Ready` only after at least one vLLM or Ollama replica is ready and the generated model
catalog contains the model. If the ready replica disappears, the phase returns
to `Starting` or the no-Pod states above and the model is withdrawn from the routable catalog. External
activations keep their catalog-based readiness behavior.

The direct vLLM-Omni runtime reports Kubernetes permission failures as
`Degraded/RealtimePermissionDenied` and other rejected API operations as
`Degraded/RealtimeApiRejected`, including before a Pod exists. Transient API
outages use `Starting/RealtimeApiUnavailable`. These states are retried during
normal reconciliation and clear after recovery; failed activations are not
published to the model catalog. See [Realtime lifecycle](realtime.md#lifecycle-and-routing).

## Status

The controller status contract is:

```yaml
status:
  phase: Reconciling
  observedGeneration: 3
  modules:
    litellm:
      phase: Ready
      kustomization: app-litellm
    openclaw-operator:
      phase: Ready
      kustomization: operator-openclaw
      autoEnabled: true
  instances:
    openclaw:
      default:
        phase: Ready
        namespace: ai
        kind: OpenClawInstance
        name: default
        url: http://default.openclaw.magicstick.local/
        message: OpenClaw instance is ready
  models:
    qwen352bvlembedding:
      phase: Ready
      modelRef: kubeai/qwen352bvlembedding
      catalogId: qwen352bvlembedding
      computeTarget: nvidia-gpu
      engine: VLLM
      resolvedResourceProfile: magicstick-nvidia-gpu:1
      vramRequiredMi: 5120
      message: Model is available in the generated model catalog.
  hardwareOperators:
    gpu:
      displayName: NVIDIA GPU Operator
      phase: Ready
      needed: true
      operatorActive: true
      managedBy: magicstick
      operatorVersion: v26.3.3
      detectedNodes: [worker-gpu-1]
      compatibleNodes: [worker-gpu-1]
      allocatableResources: 1
      resourceNames: [nvidia.com/gpu]
      message: 1 allocatable GPU resource(s) are ready.
    amd-gpu:
      displayName: AMD GPU Operator
      phase: NotRequired
      needed: false
      operatorActive: false
      managedBy: none
      allocatableResources: 0
    intel-gpu:
      displayName: Intel GPU Operator
      phase: NotRequired
      needed: false
      operatorActive: false
      managedBy: none
      allocatableResources: 0
  conditions:
    - type: Ready
      status: "False"
      reason: WaitingForInstances
      message: Waiting for kubeopencode/default to become ready
      lastTransitionTime: "2026-01-01T00:00:00Z"
```

## Examples

The default public resource lives at
`magic-cluster/platform/magicstick-operator/default-appliance.yaml`.

Use the runtime CR snippets above for examples of module, instance, and model
intent. For normal installations, prefer the dashboard because it writes the same
runtime CRs without requiring users to maintain example YAML overlays.

## ApplianceSetup First-Run State

`ApplianceSetup/local` is a namespaced lifecycle resource in `identity-system`.
Host automation creates it explicitly; the cluster never infers first-run mode
from an absent resource.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ApplianceSetup
metadata:
  name: local
  namespace: identity-system
spec:
  setupVersion: v1
  installationId: 11111111-2222-3333-4444-555555555555
status:
  phase: Pending
```

`status.phase` accepts `Pending`, `Claimed`, `Applying`, `Completed`, `Failed`,
or `CompletedLegacy`. Status may also contain `claimedAt`, `completedAt`, and a
non-sensitive `lastErrorCode`. Claims, session values, passwords, and recovery
codes are never fields of this resource. New installer runs create `Pending`;
an upgrade without the installer marker creates `CompletedLegacy`.
