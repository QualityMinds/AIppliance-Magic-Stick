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
| `default` | Whether the module is part of the default minimal appliance. |
| `uninstallPolicy` | `keep-data` or `remove`. |
| `postBuildSubstitution` | Whether to include `ai-appliance-settings` post-build substitution. |

## Public Modules

| Module | Flux name | Path | Default |
|---|---|---|---|
| `basis` | `platform-basis` | `magic-cluster/platform/basis` | yes |
| `dashboard` | `app-dashboard` | `magic-cluster/apps/dashboard` | yes |
| `litellm` | `app-litellm` | `magic-cluster/apps/ai/litellm/base` | no |
| `model-catalog` | `app-model-catalog` | `magic-cluster/apps/ai/model-catalog` | no |
| `anything-llm` | `app-anything-llm` | `magic-cluster/apps/ai/anything-llm/base` | no |
| `gpu` | `platform-gpu` | `magic-cluster/platform/gpu` | no |
| `kubeai` | `platform-kubeai` | `magic-cluster/platform/ai/kubeai` | no |
| `openclaw-operator` | `operator-openclaw` | `magic-cluster/platform/ai/openclaw-operator` | no |
| `hermes-operator` | `operator-hermes` | `magic-cluster/platform/ai/hermes-operator` | no |
| `paperclip-operator` | `operator-paperclip` | `magic-cluster/platform/ai/paperclip-operator` | no |
| `kubeopencode` | `app-kubeopencode` | `magic-cluster/apps/ai/kubeopencode` | no |
| `observability` | `platform-observability` | `magic-cluster/platform/observability` | no |

`model-catalog` depends on `litellm` because the existing controller syncs
model data into LiteLLM. OpenClaw, Hermes, Paperclip, and KubeOpenCode
instances also depend on `litellm` and `model-catalog`.

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

Dashboard/module disable requests delete the `ModuleActivation`. The Magic
Stick Operator keeps a finalizer on the CR, removes the generated Flux
`Kustomization`, and then lets Kubernetes complete deletion. The generated
object uses `prune: true` and `deletionPolicy: Delete`, so Flux can remove
resources that were installed by that module.

The catalog field `uninstallPolicy` is retained as public metadata for future
data-retention choices. The live MVP treats disabled runtime modules as
`remove`.
