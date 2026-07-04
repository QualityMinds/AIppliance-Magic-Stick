# Modules

Magic Stick modules are public-safe capabilities that the Magic Stick Operator
can enable through generated Flux `Kustomization` resources.

The module catalog is installed as
`ConfigMap/magicstick-module-catalog` in namespace `ai-system` from
`magic-cluster/platform/magicstick-operator/module-catalog.yaml`.

## Catalog Fields

Each catalog entry contains:

| Field | Purpose |
|---|---|
| `name` | Canonical kebab-case module name used in status and dependencies. |
| `title` | Human-readable title. |
| `category` | Module grouping for UI and docs. |
| `description` | Short public-safe description. |
| `path` | Public repo Kustomize path without a leading `./`. |
| `kustomizationName` | Generated Flux `Kustomization.metadata.name`. |
| `requires` | Canonical module dependencies. |
| `provides` | Capabilities exposed by the module. |
| `requiredCrds` | CRDs that must exist before dependent instances are created. |
| `default` | Whether the module is part of the default AI-workstation appliance. |
| `uninstallPolicy` | `keep-data` or `remove`. |
| `postBuildSubstitution` | Whether to include `ai-appliance-settings` post-build substitution. |

## Public Modules

| Module | Flux name | Path | AI-workstation default |
|---|---|---|---|
| `basis` | `platform-basis` | `magic-cluster/platform/basis` | yes |
| `dashboard` | `app-dashboard` | `magic-cluster/apps/dashboard` | yes |
| `litellm` | `app-litellm` | `magic-cluster/apps/ai/litellm/base` | yes |
| `model-catalog` | `app-model-catalog` | `magic-cluster/apps/ai/model-catalog` | yes |
| `anything-llm` | `app-anything-llm` | `magic-cluster/apps/ai/anything-llm/base` | no |
| `gpu` | `platform-gpu` | `magic-cluster/platform/gpu` | yes |
| `kubeai` | `platform-kubeai` | `magic-cluster/platform/ai/kubeai` | yes |
| `openclaw-operator` | `operator-openclaw` | `magic-cluster/platform/ai/openclaw-operator` | no |
| `hermes-operator` | `operator-hermes` | `magic-cluster/platform/ai/hermes-operator` | no |
| `paperclip-operator` | `operator-paperclip` | `magic-cluster/platform/ai/paperclip-operator` | no |
| `kubeopencode` | `app-kubeopencode` | `magic-cluster/apps/ai/kubeopencode` | no |
| `observability` | `platform-observability` | `magic-cluster/platform/observability` | no |

The installed public default uses the `ai-workstation` profile. The `gpu`
module is the NVIDIA GPU Operator module; it installs the cluster-side NVIDIA
GPU stack used by KubeAI and local model serving.

`Appliance.spec.modules` seeds missing `ModuleActivation` resources for default
modules. Existing `ModuleActivation` resources remain authoritative, so setting
`spec.enabled: false` on a seeded module keeps it disabled.

`model-catalog` depends on `litellm` because the current controller syncs model
data into LiteLLM, reads the LiteLLM model list, and publishes app catalog
fragments from that LiteLLM-backed view. If LiteLLM is disabled or missing,
`model-catalog` waits in `WaitingForModules` instead of installing a generated
Flux Kustomization with a missing dependency. OpenClaw, Hermes, Paperclip, and
KubeOpenCode instances also depend on `litellm` and `model-catalog`.

## Generated Flux Kustomization

The generated object shape is:

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

## Uninstall Policy

Dashboard/module disable requests keep the `ModuleActivation` as an explicit
disabled runtime intent with `spec.enabled: false`. The Magic Stick Operator
removes the generated Flux `Kustomization`. The generated object uses
`prune: true` and `deletionPolicy: Delete`, so Flux can remove resources that
were installed by that module.

Module storage overrides live in `ModuleActivation.spec.parameters`. If no
parameter is set, the module manifests keep their own storage defaults.

Operator module namespaces are annotated with
`kustomize.toolkit.fluxcd.io/prune: disabled`. Disabling an operator module
removes its Helm release and workloads, but keeps the namespace available so a
later re-enable does not leave Helm release storage pointing at a deleted
namespace.

Enabled app instances do not override a disabled module intent. If an instance
requires a disabled module, the instance waits in `WaitingForModules` until the
module is enabled again.

The catalog field `uninstallPolicy` is retained as public metadata for future
data-retention choices. The live MVP treats disabled runtime modules as
`remove`.
