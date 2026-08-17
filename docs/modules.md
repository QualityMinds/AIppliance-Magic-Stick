# Modules

Magic Stick modules are public-safe capabilities that the Magic Stick Operator
can enable through generated Flux `Kustomization` resources.

The module catalog is the source of truth. It is installed as
`ConfigMap/magicstick-module-catalog` in namespace `ai-system` from
`magic-cluster/platform/magicstick-operator/module-catalog.yaml`.

## Catalog Structure

`modules.json` contains:

| Field | Purpose |
|---|---|
| `groups` | UI and documentation grouping metadata. Each group can define `displayName` and `order`. |
| `modules` | Canonical module definitions keyed by module name. |

Each module definition may contain:

| Field | Purpose |
|---|---|
| `displayName` | Human-readable title. The dashboard falls back to the module key. |
| `group` | Catalog group key such as `core`, `runtime`, `apps`, or `operators`. |
| `aliases` | Backward-compatible names accepted by the API, such as `anythingllm`. |
| `activationMode` | `static` for Git-owned modules, `moduleactivation` for runtime-toggleable modules. |
| `order` | Stable sort order inside a group. |
| `path` | Public repo Kustomize path without a leading `./`. |
| `kustomizationName` | Generated Flux `Kustomization.metadata.name`. |
| `requires` | Canonical module dependencies. |
| `requiredCrds` | CRDs that must exist before dependent instances are created. |
| `default` | Whether the module is seeded by the default GPU-neutral appliance. |
| `activationPolicy` | Optional lifecycle hint. `local-model` modules are requested automatically by local models and can also be managed explicitly in the dashboard. |
| `uninstallPolicy` | Public metadata for data-retention choices. |
| `postBuildSubstitution` | Whether to include `ai-appliance-settings` as Flux post-build substitution. |
| `parameters` | Optional dashboard fields stored in `ModuleActivation.spec.parameters`; each field may declare its Flux `substitution` variable. |
| `credentials.provider` | Optional fixed dashboard credential provider. The API supports only explicitly implemented providers and never accepts arbitrary Secret names from catalog data. |

Do not maintain a second hardcoded module list in dashboard code or docs. Add a
module to the catalog and let the operator and dashboard discover it there.

Enabled modules with a supported credential provider expose **Credentials** to
operators and administrators. LiteLLM uses this control for its generated UI
login and API master key; the secret value remains in Kubernetes until an
authorized user explicitly opens the panel.

## Runtime Activation

`Appliance.spec.modules` seeds missing `ModuleActivation` resources for default
modules. Existing `ModuleActivation` resources remain authoritative, so setting
`spec.enabled: false` on a seeded module keeps it disabled.

Modules with `activationMode: static`, currently `basis` and `dashboard`, are
shown as status-only modules in the dashboard. They are reconciled by the static
Flux graph and cannot be toggled through `ModuleActivation`.

Modules with `activationMode: moduleactivation` can be enabled or disabled by
creating or patching a `ModuleActivation`:

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

## On-Demand Local Model Runtime

`gpu` and `kubeai` use `activationPolicy: local-model` and are not part of a
fresh installation. The dashboard requires both modules to be enabled and
`Ready` before it allows an enabled local `ModelActivation` to be created.
External `ModelActivation` resources require only `litellm` and
`model-catalog`.

Both modules also expose normal **Enable** and **Disable** actions in the
dashboard. KubeAI depends on the GPU module, so enable GPU first or KubeAI waits
in `WaitingForModules`. A manual action removes any automatic-activation marker
and makes the module user-managed. For backward compatibility, the operator can
still reconcile automatic markers on model activations created outside the
dashboard. After every local model has been removed, **Remove Local GPU
Runtime** deletes only automatically created KubeAI and GPU activations;
manually managed activations are preserved.

## Generated Flux Kustomization

For enabled runtime modules, the operator creates Flux `Kustomization` resources
in namespace `flux-system` from catalog fields:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-litellm
  namespace: flux-system
  labels:
    app.kubernetes.io/managed-by: magicstick-operator
    appliance.magicstick.dev/name: local
spec:
  interval: 10m0s
  path: ./magic-cluster/apps/ai/litellm/base
  prune: true
  deletionPolicy: Delete
  sourceRef:
    kind: GitRepository
    name: magicstick-public
    namespace: flux-system
  dependsOn:
    - name: platform-basis
```

Modules with `postBuildSubstitution: true` also include:

```yaml
postBuild:
  substitute:
    var_substitution_enabled: "true"
  substituteFrom:
    - kind: ConfigMap
      name: ai-appliance-settings
      optional: true
```

## Instance Dependencies

`ConfigMap/magicstick-app-catalog` defines which modules and CRDs an
`AppInstance.spec.application` needs and points to its Helm chart.
For example, an OpenClaw instance requires `openclaw-operator`, `litellm`, and
`model-catalog`. Odysseus instances require the `odysseus` app module plus
`litellm` and `model-catalog`. Flux renders every instance from its application
chart; the Magic Stick Operator does not create application workloads directly.

The Odysseus instance chart registers the selected `spec.values.model` as a
shared model on a managed LiteLLM endpoint through the Odysseus API. A small
in-Pod bootstrap container waits until both Odysseus and the model are ready,
keeps the registration idempotent across restarts, and reads the LiteLLM key
directly from its Kubernetes Secret without writing it to a ConfigMap or log.
Odysseus becomes Ready only after this initial registration succeeds.

A Paperclip instance requires `paperclip-operator`, `agent-sandbox`, `litellm`,
and `model-catalog`. `agent-sandbox` installs the upstream Agent Sandbox
controller pinned to `v0.5.1` and provides `sandboxes.agents.x-k8s.io` for
Paperclip's `sandbox-cr` execution backend. Both operator modules remain opt-in
until an enabled Paperclip `AppInstance` requests them.

Enabled app instances do not override a disabled module intent. If an instance
requires a disabled module, the instance waits in `WaitingForModules` until the
module is enabled again.

## Disable Behavior

Dashboard disable requests keep the `ModuleActivation` as explicit disabled
runtime intent with `spec.enabled: false`. The Magic Stick Operator removes the
generated Flux `Kustomization`. Generated Kustomizations use `prune: true` and
`deletionPolicy: Delete`, so Flux can remove resources installed by that module.

Operator module namespaces are annotated with
`kustomize.toolkit.fluxcd.io/prune: disabled`. Disabling an operator module
removes its Helm release and workloads, but keeps the namespace available so a
later re-enable does not leave Helm release storage pointing at a deleted
namespace.
