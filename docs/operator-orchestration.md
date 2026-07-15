# Operator Orchestration

The Magic Stick Operator is a meta-operator. It orchestrates platform modules
and instance resources; it does not replace specialized operators.

The dashboard is also not an operator. It reads status and creates or patches
`ModuleActivation`, `ModelActivation`, and `AppInstance` resources only.

## Responsibilities

| Component | Responsibility |
|---|---|
| Magic Stick Operator | Watches `ModuleActivation`, `ModelActivation`, and `AppInstance`, enables modules with Flux, creates one Flux HelmRelease per app instance, creates KubeAI model resources, and reports aggregate `Appliance.status`. |
| Magic Stick Dashboard | Reads `Appliance`, module catalog, Flux, Pod, Service, Ingress, and Event status; creates or patches runtime CRs only. |
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
- Add explicitly enabled runtime modules to the desired set.
- Add required modules for every enabled instance.
- Add required model-serving modules for every enabled model.
- Create or update generated Flux `Kustomization` resources only after required
  module dependencies are requested and ready.
- Delete generated Flux Kustomizations for disabled runtime modules so Flux can
  prune module resources.
- Delete stale generated Flux Kustomizations that no longer have a matching
  `ModuleActivation`.
- Wait for required CRDs.
- Create or patch KubeAI model resources and one generated HelmRelease per app instance.
- Update module, instance, and condition status.

The static Flux `magicstick-operator` Kustomization must not wait on
`Appliance/local.status`: that status is a runtime dashboard read model and may
be `Reconciling` or `Degraded` while optional modules are being installed,
removed, or repaired.

## Instance Mapping

| Application | Required module | Required CRD | Chart output |
|---|---|---|---|
| `openclaw` | `openclaw-operator` | `openclawinstances.openclaw.rocks` | `OpenClawInstance` `openclaw.rocks/v1alpha1` |
| `hermes` | `hermes-operator` | `hermesinstances.hermes.agent` | `HermesInstance` `hermes.agent/v1` |
| `paperclip` | `paperclip-operator`, `agent-sandbox` | `instances.paperclip.inc`, `sandboxes.agents.x-k8s.io` | `Instance` `paperclip.inc/v1alpha1` and per-run `Sandbox` resources |
| `kubeopencode` | `kubeopencode` | `agenttemplates.kubeopencode.io` | `AgentTemplate` and related `kubeopencode.io/v1alpha1` resources |
| `odysseus` | `odysseus` | none | `Deployment` `apps/v1` plus supporting Services, PVCs, ConfigMaps, and Ingress |

All enabled AI app instances also require `litellm` and `model-catalog`.
Paperclip uses the Agent Sandbox CR backend for CLI runtimes; OpenClaw and
Hermes remain separate gateway services.

The generated HelmRelease is stored in `ai-system`, targets the requested app
namespace, and loads its chart from the GitRepository configured in
`Appliance.spec.source`. Charts for operator-backed apps render the native CR;
the Odysseus chart renders its Deployments, Services, PVCs, Secret, ConfigMap,
and Ingress directly. Helm owns upgrade and cleanup for all of these resources.

## Defaulting

For v1alpha1, examples use these defaults:

- the installed public appliance profile is `ai-workstation`
- `Appliance.spec.modules` enables `basis`, `dashboard`, `gpu`, `kubeai`,
  `litellm`, and `model-catalog`
- missing default module activations are seeded once; existing
  `ModuleActivation` resources, including disabled ones, take precedence
- instance target namespace defaults to `ai`
- `enabled` defaults to `true` inside instance arrays
- generated Flux namespace is always `flux-system`
- generated Flux interval is `10m0s`
- generated Flux prune is `true`
- generated Flux deletion policy is `Delete`
- generated Flux wait is `false`; module readiness uses explicit health checks
  such as required CRDs
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

The controller sets an instance to `Ready` when its generated HelmRelease is
ready. Native application readiness remains the responsibility of the chart and
the specialized operator it installs a CR for.

## Public Boundary

The public repository must remain deployment-neutral. Do not place real
domains, private IPs, customer names, tokens, kubeconfigs, generated secrets,
private repository paths, or real deployment-specific values in module
definitions, examples, or docs. Use `example.local`, `example.com`,
`CHANGEME`, or documented variables.
