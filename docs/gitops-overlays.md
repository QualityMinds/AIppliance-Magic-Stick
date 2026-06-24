# GitOps And Overlays

This repository is designed to be consumed by Flux and Kustomize. Public bases
stay reusable; private deployments provide concrete values through overlays.

## Public Entry Points

| Entrypoint | Purpose |
|---|---|
| `magic-cluster/flux/entrypoints/base` | Neutral public Flux graph. |
| `magic-cluster/flux/entrypoints/single-node` | Public single-node profile alias for the neutral graph. |
| `examples/demo/infra-cluster/flux-bootstrap` | Safe example overlay using `example.local` hostnames. |

Render them locally:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

## Private Repository Include Pattern

Private deployments should include this repository into their Flux source
artifact rather than copying public bases.

```yaml
include:
  - repository:
      name: magicstick-public
    fromPath: .
    toPath: vendor/magicstick
```

Private overlays can then import public bases from paths such as:

```yaml
resources:
  - ../../vendor/magicstick/magic-cluster/platform/basis
  - ../../vendor/magicstick/magic-cluster/apps/ai/litellm/base
```

The private repository owns deployment-specific paths, hostnames, storage,
model selection, secret integration, and runtime CR seeding.

## Overlay Responsibilities

Use private overlays for:

- real domains and ingress hosts
- TLS issuer choices
- storage sizing
- `ModelActivation` resources and local model preset overrides
- external model definitions or provider Secrets
- provider credential Secret creation or references
- admin identities
- private Flux paths
- optional runtime CRs that should not be enabled by every deployment

Keep public bases generic and safe.

## Flux Path Patching

The static public graph now keeps optional apps out of the base reconciliation.
Private deployments that still define their own Flux Kustomizations can patch
paths from public bases to deployment overlays:

```yaml
patches:
  - target:
      group: kustomize.toolkit.fluxcd.io
      version: v1
      kind: Kustomization
      name: custom-ai-apps
      namespace: flux-system
    patch: |-
      - op: replace
        path: /spec/path
        value: ./deployments/example/infra-cluster/custom-ai-apps
```

## Model Selection

The public repository no longer carries static KubeAI model components.
Deployments request models with `ModelActivation` resources. Local activations
can reference public presets from `magicstick-model-presets` or provide explicit
KubeAI/vLLM settings.

Example:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: qwen3635b
  namespace: ai-system
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen3635b
```

External LiteLLM-backed models should be added through `ModelActivation`
resources or, for Git-owned seed data, `ConfigMap/ai-external-models`; see
[model-catalog.md](model-catalog.md).

## Profile Pattern

Profiles are public compositions that are still safe by default. Optional
modules, models, and app instances should be requested with `ModuleActivation`,
`ModelActivation`, and `AppInstance` resources instead of making the base graph
install them for every cluster.

Private deployments can either reuse a profile and patch it, or define their
own path set.

## Optional Apps And Operators

`ModuleActivation` installs optional operators and app modules such as KubeAI,
Hermes, OpenClaw, Paperclip, LiteLLM, and KubeOpenCode. App instances are
regular runtime CRs and should be represented as `AppInstance` resources.

When adding a new operator-backed app:

1. Put the operator in `magic-cluster/platform/ai/<operator>`.
2. Add an `AppInstance` builder and `instanceMappings` entry to the Magic Stick
   Operator catalog/controller.
3. Keep instance-specific secrets generated or externally referenced.
4. Document new variables in [configuration.md](configuration.md) and
   [public-release-checklist.md](public-release-checklist.md).

## Post-Build Substitution

Flux Kustomizations that need runtime settings use:

```yaml
postBuild:
  substitute:
    var_substitution_enabled: "true"
  substituteFrom:
    - kind: ConfigMap
      name: ai-appliance-settings
      optional: true
```

Use quoted YAML strings around defaulted substitutions, especially when a value
could contain special YAML characters.
