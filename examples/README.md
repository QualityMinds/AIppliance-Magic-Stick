# examples

Safe example overlays for users creating new deployments.

`demo/` imports the bootstrap and dashboard bases from `magic-cluster` and
patches them with `example.local` hosts. Optional AI modules, models, and app
instances are requested at runtime with `ModuleActivation`, `ModelActivation`,
and `AppInstance` resources.

See [../docs/gitops-overlays.md](../docs/gitops-overlays.md) for the overlay
patterns used by the demo.

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
kubectl kustomize examples/demo/infra-cluster/apps
```
