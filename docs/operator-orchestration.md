# Operator Orchestration

The Magic Stick Operator is a meta-operator. It orchestrates platform modules
and instance resources; it does not replace specialized operators.

The dashboard is also not an operator. It reads status and patches the
`Appliance` CR only.

## Responsibilities

| Component | Responsibility |
|---|---|
| Magic Stick Operator | Watches `Appliance`, enables modules with Flux, waits for CRDs, creates specialized CRs, and reports aggregate status. |
| Magic Stick Dashboard | Reads `Appliance`, module catalog, Flux, Pod, Service, Ingress, and Event status; patches `Appliance` only. |
| OpenClaw Operator | Owns lifecycle of `OpenClawInstance` resources. |
| Hermes Operator | Owns lifecycle of `HermesInstance` resources. |
| Paperclip Operator | Owns lifecycle of Paperclip `Instance` resources. |
| KubeOpenCode controller | Owns KubeOpenCode resources such as `AgentTemplate`, `Agent`, `Task`, `CronTask`, `Registry`, and `KubeOpenCodeConfig`. |

## Reconcile Flow

- Watch `Appliance` resources.
- Load `ConfigMap/magicstick-module-catalog`.
- Normalize user-facing module keys to canonical catalog names.
- Add catalog defaults and explicitly enabled modules to the desired set.
- Add required modules for every enabled instance.
- Create or update generated Flux `Kustomization` resources.
- Suspend or delete generated Kustomizations for disabled modules according to
  `uninstallPolicy`.
- Wait for required CRDs.
- Create or patch specialized instance resources.
- Update module, instance, and condition status.

## Instance Mapping

| Appliance field | Required module | Required CRD | Generated kind |
|---|---|---|---|
| `spec.instances.openclaw[]` | `openclaw-operator` | `openclawinstances.openclaw.rocks` | `OpenClawInstance` `openclaw.rocks/v1alpha1` |
| `spec.instances.hermes[]` | `hermes-operator` | `hermesinstances.hermes.agent` | `HermesInstance` `hermes.agent/v1` |
| `spec.instances.paperclip[]` | `paperclip-operator` | `instances.paperclip.inc` | `Instance` `paperclip.inc/v1alpha1` |
| `spec.instances.kubeopencode[]` | `kubeopencode` | `agenttemplates.kubeopencode.io` | `AgentTemplate` and related `kubeopencode.io/v1alpha1` resources |

All enabled AI app instances also require `litellm` and `model-catalog`.

## Defaulting

For v1alpha1, examples use these defaults:

- instance namespace defaults to `ai`
- `enabled` defaults to `true` inside instance arrays
- generated Flux namespace is always `flux-system`
- generated Flux interval is `10m0s`
- generated Flux prune is `true`
- generated Flux source comes from `Appliance.spec.source`

## Failure And Status Behavior

If an instance requires a module that is disabled, the MVP contract
auto-enables the module and records `DependencyAutoEnabled`. If a required CRD
is not present, the controller records `WaitingForCRD` and skips instance
creation until the next reconcile.

The controller should set `Ready=True` only when every desired generated Flux
Kustomization is ready and every enabled instance is ready or accepted by its
specialized operator.

## Public Boundary

The public repository must remain deployment-neutral. Do not place real
domains, private IPs, customer names, tokens, kubeconfigs, generated secrets,
private repository paths, or real deployment-specific values in module
definitions, examples, or docs. Use `example.local`, `example.com`,
`CHANGEME`, or documented variables.
