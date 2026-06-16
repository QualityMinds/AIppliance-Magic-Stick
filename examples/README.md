# examples

Safe example overlays for users creating new deployments.

`demo/` imports the reusable bases from `magic-cluster` and patches them with `example.local` hosts. It is intended for build validation and as a copyable pattern, not for production use.

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
kubectl kustomize examples/demo/infra-cluster/apps
kubectl kustomize examples/demo/infra-cluster/apps-ai
kubectl kustomize examples/demo/infra-cluster/apps-ai-kubeopencode
kubectl kustomize examples/demo/infra-cluster/infrastructure-observability
```
