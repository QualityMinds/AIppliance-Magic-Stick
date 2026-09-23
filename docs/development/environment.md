# Development environment

This repository is a public template. Development work should preserve the
boundary between reusable public bases and runtime or deployment-specific
values.

## Local Workflow

Start by checking the worktree:

```bash
git status --short --branch
```

Render the areas you touch. For broad cluster changes, run:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/platform/ai/agent-sandbox
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

For host automation changes:

```bash
ansible-galaxy collection install -r magic-host/requirements.yml
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

For installer CLI changes:

```bash
magic-installer/build-installer-image.sh --help
magic-installer/write-usb.sh --help
```

## Public Template Rules

- Keep real deployment values out of the public repository.
- Use `example.local`, `example.com`, `CHANGEME`, or documented variables.
- Put real domains, storage sizes, model selections, runtime CR seeds, and
  secret integrations in runtime settings, runtime CRs, Secrets, or optional
  external overlays.
- Public Kubernetes manifests should be reusable bases, not one-off deployment
  manifests.
- Public Secret manifests may only use generated-secret annotations,
  non-sensitive placeholders, or references to runtime Secrets.
- Update documentation when adding variables, entrypoints, apps, profiles, or
  operator dependencies.

## Agent Instructions And Skills

Agents and contributors should read [../AGENTS.md](../../AGENTS.md) before making
repo changes. That file is the source of truth for public safety, documentation
sync, validation selection, and git hygiene.

Repo-local Codex skill sources live under `../.codex/skills/`. They are
workflow aids for common project work:

- `magicstick-repo-maintenance` for general repo hygiene and documentation sync
- `magicstick-gitops-module` for modules, Flux, Kustomize, Helm, and catalog work
- `magicstick-dashboard-runtime` for dashboard/API/runtime CR behavior
- `magicstick-public-release` for release, legal, security, and public scans

Keep skills concise. Detailed policy belongs in `AGENTS.md` and public docs.
