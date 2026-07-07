# Documentation

This directory contains the operational and contributor documentation for the
public AIppliance Magic Stick template. The default flow is public read-only
bootstrap plus runtime configuration through the dashboard and runtime CRs.

## Reading Path

| Document | Use it for |
|---|---|
| [getting-started.md](getting-started.md) | First local checkout, render checks, and public read-only installer workflow. |
| [architecture.md](architecture.md) | Repository layers, bootstrap flow, Flux graph, and cluster component overview. |
| [appliance-crd.md](appliance-crd.md) | `Appliance` API, spec, status, and public examples. |
| [dashboard.md](dashboard.md) | Dashboard UI/API contract for managing the `Appliance` CR. |
| [modules.md](modules.md) | Magic Stick module catalog and generated Flux Kustomization contract. |
| [operator-orchestration.md](operator-orchestration.md) | Meta-operator responsibilities and specialized operator handoff. |
| [configuration.md](configuration.md) | Bootstrap variables, appliance-wide settings, module parameters, Flux post-build substitution, and secret handling. |
| [gitops-overlays.md](gitops-overlays.md) | Optional GitOps include and overlay patterns for advanced deployments. |
| [operations.md](operations.md) | Day-2 checks for Flux, K3s, apps, models, storage, GPU, logs, and common failures. |
| [model-catalog.md](model-catalog.md) | AI model catalog contract, external model schema, generated ConfigMap keys, and troubleshooting. |
| [development.md](development.md) | Contribution workflow, validation commands, public release checks, and review rules. |
| [public-release-checklist.md](public-release-checklist.md) | Final checklist before publishing a public release tag. |

Top-level community and release files:

| File | Use it for |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Public repository boundary, local validation, and pull request expectations. |
| [../LICENSE](../LICENSE) | Project license. |
| [../SECURITY.md](../SECURITY.md) | Private reporting guidance for vulnerabilities and leaked credentials. |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Collaboration expectations. |
| [../SUPPORT.md](../SUPPORT.md) | Public support boundaries and safe issue content. |
| [../GOVERNANCE.md](../GOVERNANCE.md) | Lightweight project governance. |
| [../MAINTAINERS.md](../MAINTAINERS.md) | Maintainer responsibilities. |
| [../CHANGELOG.md](../CHANGELOG.md) | Public release notes. |
| [../ROADMAP.md](../ROADMAP.md) | Likely public project directions. |
| [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Runtime image and Helm chart inventory for release review. |
| [index.html](index.html) | GitHub Pages landing page. |
| [legal-notice.html](legal-notice.html) | Legal notice for the GitHub Pages site. |
| [privacy.html](privacy.html) | Privacy policy for the GitHub Pages site. |

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
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Run the public release scans before publishing:

```bash
rg -n "Q[M]-Worker1|quality[m]inds|ai-box-[0]1|github.com/Quality[M]inds|19[2]\.|1[0]\.|17[2]\.(1[6-9]|2[0-9]|3[0-1])\." .
rg -n "ghp_|github_pat_|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA|password:|token:|api[_-]?key" .
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
gitleaks detect --source . --config .gitleaks.toml --redact
```

Expected scan findings must be safe placeholders, generated-secret annotations,
Kubernetes secret references, public repository URLs, or documented example
values.
