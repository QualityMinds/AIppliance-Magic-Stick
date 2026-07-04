# Magic Stick Operator Controller Contract

This directory intentionally contains controller design notes, not production
controller code. The MVP installs the `Appliance` CRD, RBAC, module catalog, a
disabled controller Deployment, examples, and documentation.

The real Magic Stick Operator is a meta-operator. It must not replace
specialized operators:

- OpenClaw Operator manages `OpenClawInstance` resources.
- Hermes Operator manages `HermesInstance` resources.
- Paperclip Operator manages `Instance` resources in `paperclip.inc`.
- KubeOpenCode manages `AgentTemplate`, `Agent`, `Task`, `CronTask`,
  `Registry`, and `KubeOpenCodeConfig` resources.

## Reconcile Inputs

- `Appliance` resources in `appliance.magicstick.dev/v1alpha1`
- `ConfigMap/magicstick-module-catalog` in `ai-system`
- Flux `GitRepository` referenced by `spec.source`
- CRDs listed in the module catalog and instance mappings

## Generated Flux Kustomizations

The controller creates Flux `Kustomization` resources in `flux-system` using
module catalog fields:

- `metadata.name` from `kustomizationName`
- `metadata.labels["app.kubernetes.io/managed-by"] = magicstick-operator`
- `metadata.labels["appliance.magicstick.dev/name"] = <appliance name>`
- `spec.interval = 10m0s`
- `spec.path = ./<module path>`
- `spec.prune = true`
- `spec.sourceRef` from `Appliance.spec.source`
- `spec.dependsOn` from module `requires`
- `spec.postBuild.substituteFrom` for modules with `postBuildSubstitution`

Dashboard module controls also read optional catalog UI/API metadata:
`displayName`, `aliases`, `activationMode`, `order`, and `parameters`.

Disabled runtime modules delete the generated Flux `Kustomization` instead of
suspending it. Generated Kustomizations use `spec.prune = true` and
`spec.deletionPolicy = Delete`, so Flux can prune module resources during
deletion.

## Instance Orchestration

For enabled instances, the controller auto-enables any required modules from
`instanceMappings`, reports that in status, waits for required CRDs, and then
creates or patches the specialized custom resource. Instance resources must be
owned by the `Appliance` and labeled with:

- `app.kubernetes.io/managed-by: magicstick-operator`
- `appliance.magicstick.dev/name: <appliance name>`
- `appliance.magicstick.dev/instance-type: <type>`
- `appliance.magicstick.dev/instance-name: <name>`

If a CRD is missing, the controller sets a `WaitingForCRD` condition and does
not create that instance resource.

## Status Contract

The controller writes:

- `status.phase`
- `status.observedGeneration`
- `status.modules.<module>.phase`
- `status.modules.<module>.kustomization`
- `status.modules.<module>.autoEnabled`
- `status.instances.<type>.<name>.phase`
- standard conditions such as `Ready`, `DependencyAutoEnabled`,
  `WaitingForCRD`, and `WaitingForInstances`
