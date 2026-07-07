# Public Release Checklist

Run this before publishing this repository or creating a public release tag.

## Structure

- This repository contains only reusable template files, public-safe defaults,
  and render-only examples.
- Real deployment values come from installer metadata, runtime settings, runtime
  CRs, Kubernetes Secrets, or optional external overlays.
- New deployments do not edit public bases directly for local-only values.
- Public documentation links from `README.md` and `docs/README.md` stay current.
- `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `GOVERNANCE.md`, `MAINTAINERS.md`, `CHANGELOG.md`, `ROADMAP.md`, and
  `THIRD_PARTY_NOTICES.md` reflect the current public release posture.
- `docs/index.html`, `docs/legal-notice.html`, and `docs/privacy.html` are
  present when GitHub Pages is published from `docs/`.
- CI release checks are present under `.github/workflows/`.
- Runtime images and chart versions avoid mutable tags such as `latest` where practical.

## Value Scan

Search the repository for values that must not be released:

```bash
rg -n "Q[M]-Worker1|quality[m]inds|ai-box-[0]1|github.com/Quality[M]inds|19[2]\\.|1[0]\\.|17[2]\\.(1[6-9]|2[0-9]|3[0-1])\\." .
rg -n "ghp_|github_pat_|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA|password:|token:|api[_-]?key" .
```

Expected findings should be placeholders, generated-secret annotations, Kubernetes secret references, or safe `example.*` values only.

## Build Checks

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml

kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/platform/observability
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

## Secret Checks

```bash
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
gitleaks detect --source . --config .gitleaks.toml --redact
```

Do not commit generated Kubernetes Secrets, Flux bootstrap token secrets, private keys, kubeconfigs, Ansible Vault files, or filled installer tokens.

## Third-Party Review

- Review [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for referenced
  runtime images and Helm charts.
- Confirm upstream artifact licenses and terms are acceptable for the intended release.
- Confirm brand and project names are used only to identify integrations.
- Confirm pinned images or digest references are still intentionally selected.

## Review Questions

- Does every public hostname use `example.local`, `example.com`, or a documented placeholder?
- Are real domains, admin emails, storage sizes, and external Flux paths absent from this repository?
- Are catalog placeholders such as `AI_APPLIANCE_DEFAULT_CHAT_MODEL` and
  `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` documented and safe by default?
- Does the public `ai-external-models` ConfigMap contain only an empty example schema and no provider secrets?
- Are safe defaults clearly documented for runtime settings and optional overlays?
- Are optional modules, models, and app instances represented as runtime CRs
  instead of static public descriptors?
- Are render-only examples public-safe and limited to `example.local`,
  `example.com`, `CHANGEME`, or documented variables?
- Do module catalog paths point only to reusable public bases?
- Do example overlays still build after public base changes?
- Does the dashboard write only `ModuleActivation`, `ModelActivation`, and
  `AppInstance` CRs, without direct workload install permissions?
- Are new secrets generated at runtime instead of stored in Git?
- Are new public interfaces documented in `docs/configuration.md`,
  `docs/gitops-overlays.md`, `docs/operations.md`, or another focused page?
- Are issue templates and pull request checklists steering users away from
  posting deployment-specific values?
