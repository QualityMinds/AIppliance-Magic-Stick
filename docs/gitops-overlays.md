# GitOps And Overlays

This repository is designed to be consumed by Flux and Kustomize. Public bases
stay reusable; private deployments provide concrete values through overlays.

## Public Entry Points

| Entrypoint | Purpose |
|---|---|
| `magic-cluster/flux/entrypoints/base` | Neutral public Flux graph. |
| `magic-cluster/flux/entrypoints/single-node` | Public single-node profile that patches app paths to profile overlays. |
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
  - ../../vendor/magicstick/magic-cluster/apps/ai
```

The private repository owns deployment-specific paths, hostnames, storage,
model selection, secret integration, and optional app enablement.

## Overlay Responsibilities

Use private overlays for:

- real domains and ingress hosts
- TLS issuer choices
- storage sizing
- selected KubeAI model resources
- external model definitions
- provider credential Secret creation or references
- admin identities
- private Flux paths
- optional apps that should not be enabled by every deployment

Keep public bases generic and safe.

## Flux Path Patching

The demo overlay patches Flux Kustomization paths from public bases to example
overlay paths. Private deployments can use the same pattern:

```yaml
patches:
  - target:
      group: kustomize.toolkit.fluxcd.io
      version: v1
      kind: Kustomization
      name: apps-ai
      namespace: flux-system
    patch: |-
      - op: replace
        path: /spec/path
        value: ./deployments/example/infra-cluster/apps-ai
```

## Model Selection

The public `magic-cluster/apps/ai` base is model-neutral. It includes model
components under `magic-cluster/apps/ai/models`, but deployments decide which
models to activate.

Example:

```yaml
resources:
  - ../../vendor/magicstick/magic-cluster/apps/ai

components:
  - ../../vendor/magicstick/magic-cluster/apps/ai/models/qwen3635b/component
  - ../../vendor/magicstick/magic-cluster/apps/ai/models/qwen352bvlembedding/component
```

External LiteLLM-backed models should be added through
`ConfigMap/ai-external-models`; see [model-catalog.md](model-catalog.md).

## Profile Pattern

Profiles are public compositions that are still safe by default. The
single-node profile currently:

- replaces the `apps-ai` Flux path with `magic-cluster/profiles/single-node/apps/ai`
- replaces the `apps-ai-agent-templates` path with
  `magic-cluster/profiles/single-node/apps/ai-agent-templates`
- keeps model components commented so public defaults remain lightweight

Private deployments can either reuse a profile and patch it, or define their
own path set.

## Optional Apps And Operators

AI infrastructure installs the operators and CRDs for KubeAI, Hermes,
OpenClaw, and Paperclip. App instances are regular app-layer resources and can
be patched or split into deployment-specific Kustomizations.

When adding a new operator-backed app:

1. Put the operator in `magic-cluster/platform/ai/<operator>`.
2. Put the app instance in `magic-cluster/apps/ai/<app>`.
3. Add health checks to the Flux graph only when the CRD is needed by default.
4. Keep instance-specific secrets generated or externally referenced.
5. Document new variables in [configuration.md](configuration.md) and
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
