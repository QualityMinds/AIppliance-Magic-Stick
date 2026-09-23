# Build and test

## Release Validation

Run the public release checklist before tagging a public version:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
gitleaks detect --source . --config .gitleaks.toml --no-git
```

Also run the value scans from
[public-release-checklist.md](release-checklist.md). Expected findings
must be documented and safe.
