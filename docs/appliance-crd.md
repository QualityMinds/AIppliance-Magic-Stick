# Appliance CRD

The `Appliance` custom resource is the Git-owned aggregate status surface for
the local Magic Stick installation. Runtime module and instance requests are
represented as separate `ModuleActivation` and `AppInstance` CRs so Flux does
not overwrite dashboard actions.

The MVP installs the CRD and a default `Appliance/local` resource. The
controller Deployment runs in-cluster and reconciles runtime CRs.

## API

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: Appliance
metadata:
  name: local
  namespace: ai-system
spec:
  profile: minimal
  source:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
```

The CRD is namespaced, with plural `appliances` and short names `msapp` and
`appliance`.

## Spec

| Field | Purpose |
|---|---|
| `spec.profile` | Public profile hint: `minimal`, `ai-workstation`, or `full`. |
| `spec.source` | Flux `GitRepository` source used by generated module Kustomizations. |
| `spec.modules` | Git-owned static defaults only. Runtime module changes use `ModuleActivation`. |
| `spec.instances` | Deprecated for runtime use. Runtime instance changes use `AppInstance`. |

The default public install uses `spec.source.name: flux-system` because
readonly-public mode creates that Git source. Private deployment repositories
that include this public repo can use `magicstick-public`.

## Modules And Instances

Modules are capabilities. Instances are concrete uses of those capabilities.

For example, creating `ModuleActivation/openclaw-operator` installs the
OpenClaw operator module. Creating an `AppInstance` with `spec.type: openclaw`
asks the Magic Stick Operator to create an `OpenClawInstance` after required
modules and CRDs are available.

The MVP contract auto-enables modules required by an enabled instance and
reports that in status. For example, an OpenClaw instance requires:

- `openclaw-operator`
- `litellm`
- `model-catalog`

The dashboard uses `ModuleActivation` and `AppInstance` as its only write
surface. The Magic Stick Operator, Flux, and the specialized operators perform
the actual reconciliation.

## Runtime CRs

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModuleActivation
metadata:
  name: litellm
  namespace: ai-system
spec:
  module: litellm
  enabled: true
```

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: openclaw-default
  namespace: ai-system
spec:
  type: openclaw
  enabled: true
  targetNamespace: ai
  parameters:
    name: default
    model: CHANGEME_MODEL
    ingress:
      enabled: true
      host: openclaw.example.local
```

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
        url: https://openclaw.example.local
        message: OpenClaw instance is ready
  conditions:
    - type: Ready
      status: "False"
      reason: WaitingForInstances
      message: Waiting for kubeopencode/default to become ready
      lastTransitionTime: "2026-01-01T00:00:00Z"
```

## Examples

Public-safe examples live under
`magic-cluster/platform/magicstick-operator/examples/`:

- `appliance-minimal.yaml`
- `appliance-ai-workstation.yaml`
- `appliance-full.yaml`

They use `example.local` hosts and `CHANGEME_MODEL` placeholders only.
