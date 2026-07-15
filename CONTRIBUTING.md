# Contributing

Thanks for helping improve AIppliance-Magic-Stick. This repository is a public
template: it should stay reusable, deployment-neutral, and safe to publish.

## Public Repository Boundary

Do not commit real deployment values to this repository. Keep these in private
deployment overlays or runtime secrets:

- real domains, hostnames, IP addresses, customer names, or personal usernames
- GitHub tokens, kubeconfigs, private keys, API keys, passwords, or generated secrets
- private Flux paths, private repository URLs, storage sizing, or model selections

Use `example.local`, `example.com`, `CHANGEME`, `REPLACE_WITH_*`, or documented
runtime variables for placeholders.

## Local Validation

Before opening a pull request, run the relevant checks:

```bash
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
gitleaks detect --source . --config .gitleaks.toml --redact

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
kubectl kustomize magic-cluster/platform/ai/agent-sandbox
kubectl kustomize magic-cluster/platform/observability
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

See [docs/public-release-checklist.md](docs/public-release-checklist.md) for the
full release checklist.

## Pull Requests

- Keep changes focused and explain the public behavior change.
- Update docs when adding public configuration, CRD fields, modules, models, or
  runtime parameters.
- Add or update validation coverage for new Kustomize entry points.
- Include a short validation summary in the PR description.
- Do not mix reusable public template changes with deployment-specific overlay changes.
