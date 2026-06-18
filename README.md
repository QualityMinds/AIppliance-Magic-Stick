# AIppliance-Magic-Stick

Reusable public template for building an AI Appliance from an empty machine to a running AI platform.

This repository intentionally contains only generic template code, safe example overlays, and placeholders. Real deployment values belong in a private deployment repository, which can include this repo through Flux `GitRepository.spec.include`.

## Layout

```text
.
├── magic-installer/                  # reusable cloud-init/autoinstall template
├── magic-host/                 # reusable Ansible playbooks and roles
├── magic-cluster/              # reusable Kubernetes, app, platform and Flux bases
├── examples/demo/              # safe example overlay using example.local hosts
├── docs/
│   └── public-release-checklist.md
├── AGENTS.md
└── .gitleaks.toml
```

Use `example.local`, `example.com`, `CHANGEME`, or documented variables for all template values.

## GitOps Entry Points

Public template:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
```

Safe demo overlay:

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Public single-node profile:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/single-node
```

Private deployments should include this repository into their source artifact, for example:

```yaml
include:
  - repository:
      name: magicstick-public
    fromPath: .
    toPath: vendor/magicstick
```

Deployment overlays can then import bases from `vendor/magicstick/magic-cluster/platform/...` and `vendor/magicstick/magic-cluster/apps/...`.

## Host Bootstrap

The installer writes `/etc/default/ai-appliance-repo`. The reusable Ansible playbook reads:

- `FLUX_BOOTSTRAP_MODE`
- `GIT_HOST`
- `GIT_OWNER`
- `GIT_REPO`
- `GIT_BRANCH`
- `FLUX_CLUSTER_PATH`
- `FLUX_PUBLIC_SYNC_PATH`
- `ANSIBLE_INVENTORY_PATH`
- `ANSIBLE_PLAYBOOK_PATH`
- `MAGICSTICK_PUBLIC_REPO`
- `MAGICSTICK_PUBLIC_REF`
- `MAGICSTICK_PUBLIC_REF_KIND`
- `AI_APPLIANCE_*`
- `FLUX_GITHUB_TOKEN`

Secrets such as Flux tokens must be supplied at install/runtime and must not be committed.
In `readonly-public` mode Flux reads only this public repository and does not
need a Git token.

Current app storage placeholders include `AI_APPLIANCE_HERMES_STORAGE` for the
Hermes agent PVC and `AI_APPLIANCE_OPENCLAW_STORAGE` for the optional OpenClaw
agent PVC.

## Validation

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml

kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/apps/ai
kubectl kustomize magic-cluster/apps/ai/hermes
kubectl kustomize magic-cluster/apps/ai/openclaw
kubectl kustomize magic-cluster/apps/ai/paperclip
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize magic-cluster/apps/ai/agent-templates
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/profiles/single-node/apps/ai
kubectl kustomize magic-cluster/profiles/single-node/apps/ai-agent-templates
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

See [docs/public-release-checklist.md](docs/public-release-checklist.md) before publishing a release tag for private deployments to pin.
