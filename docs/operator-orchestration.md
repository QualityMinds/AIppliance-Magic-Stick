# Operator Orchestration

The Magic Stick Operator is a meta-operator. It orchestrates platform modules
and instance resources; it does not replace specialized operators.

The dashboard is also not an operator. It reads status and creates or patches
`ModuleActivation`, `ModelActivation`, and `AppInstance` resources only.

## Responsibilities

| Component | Responsibility |
|---|---|
| Magic Stick Operator | Watches `ModuleActivation`, `ModelActivation`, and `AppInstance`, enables modules with Flux, creates one Flux HelmRelease plus authenticated Gateway resources per app instance, creates KubeAI model resources, and reports aggregate `Appliance.status`. |
| Magic Stick Dashboard | Reads `Appliance`, module catalog, Flux, Pod, Service, Ingress, HTTPRoute, and Event status; creates or patches runtime CRs only. |
| Node Feature Discovery | Re-detects node hardware every 60 seconds and publishes the shared PCI-vendor and platform labels. |
| NVIDIA GPU Operator | Owns NVIDIA driver, device-plugin, and `nvidia.com/gpu` publication after matching hardware is detected. |
| AMD GPU Operator | Owns AMD device configuration and device-plugin publication; the portable baseline consumes the host/inbox `amdgpu` driver. |
| Intel Device Plugins Operator | Owns Intel GPU device-plugin resources on supported Intel GPU nodes; the kernel provides the host driver. |
| OpenClaw Operator | Owns lifecycle of `OpenClawInstance` resources. |
| Hermes Operator | Owns lifecycle of `HermesInstance` resources. |
| Paperclip Operator | Owns lifecycle of Paperclip `Instance` resources. |
| Agent Sandbox Controller | Owns lifecycle of `Sandbox` resources and their isolated runtime Pods. |
| KubeOpenCode controller | Owns KubeOpenCode resources such as `AgentTemplate`, `Agent`, `Task`, `CronTask`, `Registry`, and `KubeOpenCodeConfig`. |

## Reconcile Flow

- Read the Git-owned `Appliance/local` source configuration.
- Watch or poll `ModuleActivation`, `ModelActivation`, and `AppInstance`
  resources.
- Load `ConfigMap/magicstick-module-catalog` and `ConfigMap/magicstick-app-catalog`.
- Normalize user-facing module keys to canonical catalog names.
- Seed missing `ModuleActivation` resources from enabled
  `Appliance.spec.modules` entries.
- Read NFD labels, run the platform preflight, and request only the NVIDIA, AMD,
  or Intel operator whose hardware is present.
- Refuse a second vendor operator when its CRD already exists outside a Magic
  Stick activation, and retain existing operators across transient label loss.
- Add explicitly enabled runtime modules to the desired set.
- Add required modules for every enabled instance.
- Add required model-serving modules for every enabled model.
- Create or update generated Flux `Kustomization` resources only after required
  module dependencies are requested and ready.
- Delete generated Flux Kustomizations for disabled runtime modules so Flux can
  prune module resources.
- Suspend, rather than delete, an enabled module Kustomization while a required
  module is temporarily unready, preserving its workloads and persistent data
  across source and operator rollouts.
- Delete stale generated Flux Kustomizations that no longer have a matching
  `ModuleActivation`.
- Wait for required CRDs.
- Create or patch KubeAI model resources and one generated HelmRelease per app instance.
- For CPU-backed vLLM and Ollama models, translate
  `spec.local.memoryRequiredMi` into the engine-specific KubeAI resource-profile
  multiplier. Each multiplier unit represents 16 MiB, so KubeAI writes the
  reservation to the model pod's `resources.requests.memory`.
- Resolve each instance backend from the app catalog and create derived local
  and optional public HTTPRoutes, exact callback routes on the shared dashboard
  hosts, the cross-namespace ReferenceGrant, and an Envoy SecurityPolicy for
  shared OIDC plus minimum-role authorization. Catalogued AI application routes
  disable Envoy's total request timeout for long-lived streams, while the exact
  callback routes retain the bounded default.
- Remove generated routes and policies when an instance is suspended or deleted.
- Update module, instance, hardware-operator, and condition status.

The static Flux `magicstick-operator` Kustomization must not wait on
`Appliance/local.status`: that status is a runtime dashboard read model and may
be `Reconciling` or `Degraded` while optional modules are being installed,
removed, or repaired.

The controller runs as one replica with a zero-surge rolling strategy. The old
Pod is stopped before its replacement starts, which keeps reconciliation
serialized while remaining upgrade-compatible with Flux server-side apply.

## Instance Mapping

| Application | Required module | Required CRD | Chart output |
|---|---|---|---|
| `openclaw` | `openclaw-operator` | `openclawinstances.openclaw.rocks` | `OpenClawInstance` `openclaw.rocks/v1alpha1` |
| `hermes` | `hermes-operator` | `hermesinstances.hermes.agent` | `HermesInstance` `hermes.agent/v1` |
| `paperclip` | `paperclip-operator`, `agent-sandbox` | `instances.paperclip.inc`, `sandboxes.agents.x-k8s.io` | `Instance` `paperclip.inc/v1alpha1` and per-run `Sandbox` resources |
| `kubeopencode` | `kubeopencode` | `agenttemplates.kubeopencode.io` | `AgentTemplate` and related `kubeopencode.io/v1alpha1` resources |
| `odysseus` | `odysseus` | none | `Deployment` `apps/v1` plus supporting Services, PVCs, and ConfigMaps |

All enabled AI app instances also require `litellm` and `model-catalog`.
Paperclip uses the Agent Sandbox CR backend for CLI runtimes; OpenClaw and
Hermes remain separate gateway services.

The shared Envoy route is the browser authentication boundary. Hermes uses
LiteLLM through its native `config.raw`; its agent gateway remains available to
in-cluster integrations on service port `8443`, while the authenticated browser
route targets the bundled dashboard on service port `9119`.
Paperclip is kept private in `local_trusted` mode; an in-pod TCP proxy exposes
its loopback listener only on the Pod IP for the ClusterIP Service. Odysseus
runs with its local login disabled. Both avoid an application-specific second
login after SSO without exposing either backend directly. MagicStick rebuilds
the pinned Paperclip operator with a documented compatibility patch so only
`local_trusted` instances bind to loopback; authenticated instances retain the
upstream network bind.

The generated HelmRelease is stored in `ai-system`, targets the requested app
namespace, and loads its chart from the GitRepository configured in
`Appliance.spec.source`. Charts for operator-backed apps render the native CR;
the Odysseus chart renders its Deployments, Services, PVCs, Secret, ConfigMap,
directly. Helm owns upgrade and cleanup for application resources; the Magic
Stick Operator owns all external Gateway resources.

## Defaulting

For v1alpha1, examples use these defaults:

- the installed public appliance profile is `ai-workstation`
- `Appliance.spec.modules` enables `basis`, `dashboard`, `litellm`, and
  `model-catalog`; it does not enable GPU or KubeAI
- enabled external models require only `litellm` and `model-catalog`
- an enabled CPU model auto-enables `kubeai`, `litellm`, and `model-catalog`
- CPU models without an explicit memory reservation default to 4096 MiB for
  vLLM and 2048 MiB for Ollama
- an enabled accelerator model additionally resolves its vendor capability to
  `gpu`, `amd-gpu`, or `intel-gpu`
- missing default module activations are seeded once; existing
  `ModuleActivation` resources, including disabled ones, take precedence
- instance target namespace defaults to `ai`
- `enabled` defaults to `true` inside instance arrays
- instance authentication defaults to shared SSO with minimum role `user`
- instance exposure defaults to derived local and public hostnames
- generated Flux namespace is always `flux-system`
- generated Flux interval is `10m0s`
- generated Flux prune is `true`
- generated Flux deletion policy is `Delete`
- generated Flux wait is `false` by default; hardware-provider modules set
  `waitForReady: true` so driver and device-plugin rollout participates in
  readiness in addition to required-CRD health checks
- generated Flux source comes from `Appliance.spec.source`

## Failure And Status Behavior

If an instance requires a module that is disabled, the MVP contract
does not override the disabled module. The instance remains in
`WaitingForModules` until the module is enabled again. If a required CRD is not
present, the controller records `WaitingForCRD` and skips instance creation
until the next reconcile.

If an enabled module requires another runtime module that is disabled or not
ready, the module remains in `WaitingForModules`; the operator removes any stale
generated Flux Kustomization for that module to avoid Flux `dependsOn` errors
for missing dependencies.

After the local runtime modules are ready, an accelerator-backed model can
enter `WaitingForGPU` until Kubernetes reports at least one allocatable target
resource: `nvidia.com/gpu`, `amd.com/gpu`, `gpu.intel.com/xe`, or
`gpu.intel.com/i915`. CPU and external models never inspect accelerator
capacity. For Intel, the controller also resolves the actual resource to the
matching `xe` or `i915` KubeAI profile before creating the model.

`Appliance.status.hardwareOperators` always contains NVIDIA, AMD, and Intel.
Normal phases are `NotRequired`, `Detected`, `Installing`, `Ready`, and
`Unknown`; actionable failures are `Disabled`, `Unsupported`, `Conflict`, and
`Degraded`. A provider is not `Ready` merely because its controller Deployment
exists: an allocatable extended resource must be present on a compatible node.

After the KubeAI `Model` is created, its `ModelActivation` remains in
`Starting` while `status.replicas.ready` is zero. The operator reports the
current ready-replica count and selected engine in the status message. Ollama
receives an additional runtime check: the operator reads `/api/tags` from every
Ready model pod, waits until the registry source tag is present, and
idempotently creates the KubeAI model-name alias through `/api/copy` when the
upstream bootstrap did not do so. The activation remains `Starting` with reason
`WaitingForOllamaAlias` until that alias is visible on every Ready pod. It
changes to `Ready` only after these engine-specific checks pass and the model
catalog has published the model. If a replica or Ollama alias later becomes
unavailable, the activation returns to `Starting` and the model catalog
withdraws the LiteLLM route until the runtime is healthy again. External model
readiness remains catalog-based.

The controller sets an instance to `Ready` when its generated HelmRelease is
ready. Native application readiness remains the responsibility of the chart and
the specialized operator it installs a CR for.

## Public Boundary

The public repository must remain deployment-neutral. Do not place real
domains, private IPs, customer names, tokens, kubeconfigs, generated secrets,
private repository paths, or real deployment-specific values in module
definitions, examples, or docs. Use `example.local`, `example.com`,
`CHANGEME`, or documented variables.
