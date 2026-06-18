# Appliance CRD

The `Appliance` custom resource is the public declarative interface for
selecting Magic Stick modules and requesting concrete app or agent instances.

The MVP installs the CRD and a default `Appliance/local` resource. The
controller Deployment is present with `replicas: 0` until a production
reconcile loop is implemented.

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
| `spec.modules` | Capability switches. Known user-facing keys include `modelCatalog`, `openclawOperator`, `hermesOperator`, and `paperclipOperator`. |
| `spec.instances` | Concrete resources for specialized operators, such as OpenClaw, Hermes, Paperclip, and KubeOpenCode. |

The default public install uses `spec.source.name: flux-system` because
readonly-public mode creates that Git source. Private deployment repositories
that include this public repo can use `magicstick-public`.

## Modules And Instances

Modules are capabilities. Instances are concrete uses of those capabilities.

For example, enabling `openclawOperator` installs the OpenClaw operator module.
Requesting `spec.instances.openclaw[]` asks the Magic Stick Operator to create
an `OpenClawInstance` after required modules and CRDs are available.

The MVP contract auto-enables modules required by an enabled instance and
reports that in status. For example, an OpenClaw instance requires:

- `openclaw-operator`
- `litellm`
- `model-catalog`

The dashboard uses this API as its only write surface. UI actions patch
`spec.modules` or `spec.instances`; the Magic Stick Operator, Flux, and the
specialized operators perform the actual reconciliation.

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
