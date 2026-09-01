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
| `providesCapabilities` | Optional compute capability exposed by the module, such as `compute.gpu.nvidia`. |
| `requiredCrds` | CRDs that must exist before dependent instances are created. |
| `default` | Whether the module is seeded by the default GPU-neutral appliance. |
| `activationPolicy` | Optional lifecycle hint. `local-model` modules are requested automatically by local models and can also be managed explicitly in the dashboard. |
| `hardware` | Optional vendor-detection contract: NFD label, supported architectures, Kubernetes floor, vendor support label, allocatable resource names, operator version, and driver mode. |
| `waitForReady` | Makes the generated Flux Kustomization wait for the vendor HelmRelease and operands instead of accepting CRD creation as readiness. |
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

Modules with `activationMode: static`, currently `basis`, `hardware-discovery`, and `dashboard`, are
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

`kubeai` uses `activationPolicy: local-model` and is not part of a fresh
installation. Every local model requires KubeAI. Accelerator targets resolve a
vendor capability: `nvidia-gpu` to `compute.gpu.nvidia`, `amd-gpu` to
`compute.gpu.amd`, and `intel-gpu` to `compute.gpu.intel`. A CPU activation
therefore installs KubeAI without installing a GPU driver. External
`ModelActivation` resources require only `litellm` and `model-catalog`. A model
dependency never creates a hardware-detected vendor operator on a node where
the corresponding GPU signal is absent.

These runtime and provider modules also expose normal **Enable** and **Disable** actions in the
dashboard. A manual action removes any automatic-activation marker and makes
the module user-managed. For backward compatibility, the operator can still
reconcile automatic markers on model activations created outside the dashboard.
After every local model has been removed, **Remove Local Inference Runtime**
deletes only model-created runtime activations. Manually managed activations
and vendor activations owned by hardware detection are preserved; deletion of
an unmarked legacy NVIDIA activation exists only for upgrade compatibility.

## Hardware-Driven GPU Operators

One static Node Feature Discovery (NFD) installation scans every node and
refreshes its labels every 60 seconds. Vendor charts never install their own NFD
copy. Magic Stick watches the display/3D-controller vendor labels and creates an
auto-enabled vendor `ModuleActivation` only when compatible hardware is present.

| Module | Detection | Vendor support gate | Allocatable resource | Driver behavior |
|---|---|---|---|---|
| `gpu` | `feature.node.kubernetes.io/pci-10de.present` | same label; NVIDIA validates through ClusterPolicy | `nvidia.com/gpu` | NVIDIA GPU Operator managed |
| `amd-gpu` | `feature.node.kubernetes.io/pci-1002.present` | `feature.node.kubernetes.io/amd-gpu` from AMD's NFD rule | `amd.com/gpu` | portable baseline uses the host/inbox `amdgpu` driver |
| `intel-gpu` | `feature.node.kubernetes.io/pci-8086.present` | `intel.feature.node.kubernetes.io/gpu` from Intel's NFD rule | `gpu.intel.com/i915` or `gpu.intel.com/xe` | Linux kernel driver plus Intel device plugin |

Detection is deliberately broader than the vendor support gate. Magic Stick
does not maintain a product-ID allow-list; AMD and Intel decide whether a
detected GPU is supported through their shipped `NodeFeatureRule`. Before
activation the controller also requires Linux, a supported architecture, and
the catalogued Kubernetes minimum. If the vendor CRD already exists without a
Magic Stick activation, installation stops with `Conflict` rather than creating
a second operator.

Temporary label loss during reboot does not uninstall an existing operator.
The status becomes `Unknown` and the activation is retained. An explicitly
disabled activation is also authoritative and is never re-enabled by hardware
detection. A provider reaches `Ready` only after Kubernetes publishes at least
one allocatable vendor resource.

The model form exposes `cpu`, `nvidia-gpu`, `amd-gpu`, and `intel-gpu`. A target
is selectable only after its provider is `Ready` and the corresponding
allocatable resource exists. Intel remains one user-facing target while the
runtime resolves `gpu.intel.com/xe` or `gpu.intel.com/i915` to a matching KubeAI
resource profile.

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
