# Documentation

This directory contains the operational and contributor documentation for the
public AIppliance Magic Stick template. The repository is a reusable base; real
deployment values belong in private deployment repositories or runtime
configuration.

## Reading Path

| Document | Use it for |
|---|---|
| [getting-started.md](getting-started.md) | First local checkout, render checks, demo overlay, and installer image workflow. |
| [architecture.md](architecture.md) | Repository layers, bootstrap flow, Flux graph, and cluster component overview. |
| [configuration.md](configuration.md) | Bootstrap variables, `AI_APPLIANCE_*` settings, Flux post-build substitution, and secret handling. |
| [gitops-overlays.md](gitops-overlays.md) | Public bases, private overlays, Flux `GitRepository.spec.include`, profiles, and patching patterns. |
| [operations.md](operations.md) | Day-2 checks for Flux, K3s, apps, models, storage, GPU, logs, and common failures. |
| [model-catalog.md](model-catalog.md) | AI model catalog contract, external model schema, generated ConfigMap keys, and troubleshooting. |
| [development.md](development.md) | Contribution workflow, validation commands, public release checks, and review rules. |
| [public-release-checklist.md](public-release-checklist.md) | Final checklist before publishing a public release tag. |

## Quick Commands

Render the public Flux graph:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
```

Render the single-node public profile:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/single-node
```

Run the main Kubernetes render checks:

```bash
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/apps/ai
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Run the public release scans before publishing:

```bash
rg -n "Q[M]-Worker1|quality[m]inds|ai-box-[0]1|github.com/Quality[M]inds|19[2]\.|1[0]\.|17[2]\.(1[6-9]|2[0-9]|3[0-1])\." .
rg -n "ghp_|github_pat_|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA|password:|token:|api[_-]?key" .
gitleaks detect --source . --config .gitleaks.toml --no-git
```

Expected scan findings must be safe placeholders, generated-secret annotations,
Kubernetes secret references, public repository URLs, or documented example
values.
