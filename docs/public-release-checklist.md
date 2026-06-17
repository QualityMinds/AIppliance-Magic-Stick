# Public Release Checklist

Run this before publishing this repository or creating a release tag for private deployments to pin.

## Structure

- This repository contains only reusable template files and safe examples.
- Real deployment values live in private deployment repositories.
- New deployments use private overlays and patches instead of editing public bases directly.

## Value Scan

Search the repository for values that must not be released:

```bash
rg -n "Q[M]-Worker1|quality[m]inds|ai-box-[0]1|github.com/Quality[M]inds|19[2]\\.|1[0]\\.|17[2]\\.(1[6-9]|2[0-9]|3[0-1])\\." .
rg -n "ghp_|github_pat_|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA|password:|token:|api[_-]?key" .
```

Expected findings should be placeholders, generated-secret annotations, Kubernetes secret references, or safe `example.*` values only.

## Build Checks

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/apps/ai
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize magic-cluster/apps/ai/agent-templates
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/profiles/single-node/apps/ai
kubectl kustomize magic-cluster/profiles/single-node/apps/ai-agent-templates
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

## Secret Checks

```bash
gitleaks detect --source . --config .gitleaks.toml --no-git
```

Do not commit generated Kubernetes Secrets, Flux bootstrap token secrets, private keys, kubeconfigs, Ansible Vault files, or filled installer tokens.

## Review Questions

- Does every public hostname use `example.local`, `example.com`, or a documented placeholder?
- Are real domains, admin emails, storage sizes, and private Flux paths absent from this repository?
- Are safe defaults clearly documented for private deployments to patch?
- Do example overlays still build after public base changes?
- Are new secrets generated at runtime instead of stored in Git?
