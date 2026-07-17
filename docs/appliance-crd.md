# Appliance CRD

The `Appliance` custom resource is the Git-owned aggregate status surface for
the local Magic Stick installation. Runtime module, instance, and model
requests are represented as separate `ModuleActivation`, `AppInstance`, and
`ModelActivation` CRs so Flux does not overwrite dashboard actions.

The public base installs the CRD and a default `Appliance/local` resource. The
controller Deployment runs in-cluster and reconciles runtime CRs.

## API

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: Appliance
metadata:
  name: local
  namespace: ai-system
spec:
  profile: ai-workstation
  source:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  modules:
    basis:
      enabled: true
    dashboard:
      enabled: true
    gpu:
      enabled: true
    kubeai:
      enabled: true
    litellm:
      enabled: true
    model-catalog:
      enabled: true
```

The CRD is namespaced, with plural `appliances` and short names `msapp` and
`appliance`.

## Spec

| Field | Purpose |
|---|---|
| `spec.profile` | Public profile hint: `minimal`, `ai-workstation`, or `full`. |
| `spec.source` | Flux `GitRepository` source used by generated module Kustomizations. |
| `spec.modules` | Git-owned module defaults. The operator seeds missing `ModuleActivation` resources from enabled entries. |
| `spec.instances` | Deprecated for runtime use. Runtime instance changes use `AppInstance`. |

The default public install uses profile `ai-workstation` and
`spec.source.name: flux-system` because readonly-public mode creates that Git
source. External GitOps repositories that include this public repo can use
`magicstick-public`.

Runtime `ModuleActivation` resources take precedence over `spec.modules`.
Disabling a default module by setting `ModuleActivation.spec.enabled: false`
keeps it disabled; the operator only seeds missing activations.

## Modules And Instances

Modules are capabilities. Instances are concrete uses of those capabilities.

For example, creating `ModuleActivation/openclaw-operator` installs the
OpenClaw operator module. Creating an `AppInstance` with
`spec.application: openclaw` asks the Magic Stick Operator to create a Flux
HelmRelease for the OpenClaw instance chart after required modules and CRDs are
available. The chart creates the `OpenClawInstance`.

The operator auto-enables modules required by an enabled instance and reports
that in status. For example, an OpenClaw instance requires:

- `openclaw-operator`
- `litellm`
- `model-catalog`

The dashboard uses `ModuleActivation`, `AppInstance`, and `ModelActivation` as
its only workload intent write surface. The Magic Stick Operator, Flux, the
model-catalog controller, and the specialized operators perform the actual
reconciliation.

A Paperclip instance also auto-enables `paperclip-operator`, `agent-sandbox`,
`litellm`, and `model-catalog`. Its `agentExecution` parameters select available
adapter runtimes and sandbox concurrency without creating domain-level teams or
agents:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: paperclip-default
  namespace: ai-system
spec:
  application: paperclip
  targetNamespace: ai
  values:
    name: default
    model: qwen3635b
    agentExecution:
      defaultModel: litellm/qwen3635b
      maxConcurrentAgents: 2
      openCode:
        enabled: true
      openClaw:
        enabled: false
        instanceRef: ""
      hermes:
        enabled: false
        instanceRef: ""
```

See [paperclip-agents.md](paperclip-agents.md) for the generated adapter,
network, model, and credential contracts.

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
  parameters:
    postgresStorage: 5Gi
```

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: openclaw-default
  namespace: ai-system
spec:
  application: openclaw
  enabled: true
  targetNamespace: ai
  access:
    authentication: sso
    role: user
    exposure: localAndPublic
  values:
    name: default
    model: CHANGEME_MODEL
```

Instance hostnames are derived from runtime settings instead of being configured
as arbitrary per-instance values:

```text
<instance-name>.<instance-type>.<domain>
```

For the `openclaw-default` example, the default public and local hosts are
`default.openclaw.magicstick.example.com` and
`default.openclaw.magicstick.local`.

`spec.access` is deny-by-default at the Gateway boundary: omitted values mean
shared SSO, the `user` role, and both derived hostnames. `role` accepts `user`,
`viewer`, `operator`, or `admin`; higher dashboard roles inherit lower access.
Set `exposure: local` to omit the public hostname. Setting
`authentication: none` deliberately creates an unauthenticated route and must
be an explicit review decision.

For every enabled instance, the operator creates the required application and
per-instance callback `HTTPRoute` objects, cross-namespace `ReferenceGrant`,
and (for SSO) Envoy `SecurityPolicy` objects. The callback route shares the
dashboard hostname but uses an exact, instance-specific path. The application
charts no longer create nginx `Ingress` resources.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: qwen352bvlembedding
  namespace: ai-system
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    preset: qwen352bvlembedding
    vram: 5Gi
```

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: example-openai-gpt-4o-mini
  namespace: ai-system
spec:
  type: external
  enabled: true
  targetNamespace: ai
  external:
    model: openai/gpt-4o-mini
    apiBase: https://api.openai.com/v1
    modelType: chat
    apiKeySecretRef:
      name: external-openai-api-key
      key: api-key
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
        url: http://default.openclaw.magicstick.local/
        message: OpenClaw instance is ready
  models:
    qwen352bvlembedding:
      phase: Ready
      modelRef: kubeai/qwen352bvlembedding
      catalogId: qwen352bvlembedding
      vramRequiredMi: 5120
      message: Model is available in the generated model catalog.
  conditions:
    - type: Ready
      status: "False"
      reason: WaitingForInstances
      message: Waiting for kubeopencode/default to become ready
      lastTransitionTime: "2026-01-01T00:00:00Z"
```

## Examples

The default public resource lives at
`magic-cluster/platform/magicstick-operator/default-appliance.yaml`.

Use the runtime CR snippets above for examples of module, instance, and model
intent. For normal installations, prefer the dashboard because it writes the same
runtime CRs without requiring users to maintain example YAML overlays.

## ApplianceSetup First-Run State

`ApplianceSetup/local` is a namespaced lifecycle resource in `identity-system`.
Host automation creates it explicitly; the cluster never infers first-run mode
from an absent resource.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ApplianceSetup
metadata:
  name: local
  namespace: identity-system
spec:
  setupVersion: v1
  installationId: 11111111-2222-3333-4444-555555555555
status:
  phase: Pending
```

`status.phase` accepts `Pending`, `Claimed`, `Applying`, `Completed`, `Failed`,
or `CompletedLegacy`. Status may also contain `claimedAt`, `completedAt`, and a
non-sensitive `lastErrorCode`. Claims, session values, passwords, and recovery
codes are never fields of this resource. New installer runs create `Pending`;
an upgrade without the installer marker creates `CompletedLegacy`.
