# examples

Render-only examples for validating public Kustomize composition.

`demo/` imports public bases from `magic-cluster` and patches them with safe
`example.local` values. It is useful for CI and local smoke checks. It is not the
recommended installation path for a normal public read-only appliance; use
`magic-cluster/flux/entrypoints/single-node` and configure runtime settings
through the dashboard.

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
kubectl kustomize examples/demo/infra-cluster/apps
```
