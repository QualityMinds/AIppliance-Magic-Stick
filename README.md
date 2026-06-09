# AIppliance-Magic-Stick

Reusable public template for building an AI Appliance from an empty machine to a running AI platform.

This repository intentionally contains only generic template code, safe example overlays, and placeholders. Real deployment values belong in a private deployment repository, which can include this repo through Flux `GitRepository.spec.include`.

## Layout

```text
.
├── installer/                  # reusable cloud-init/autoinstall template
├── infra-host/                 # reusable Ansible playbooks and roles
├── infra-cluster/              # reusable Kubernetes and Flux bases
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
kubectl kustomize infra-cluster/flux-bootstrap
```

Safe demo overlay:

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Private deployments should include this repository into their source artifact, for example:

```yaml
include:
  - repository:
      name: magicstick-public
    fromPath: .
    toPath: vendor/magicstick
```

Deployment overlays can then import bases from `vendor/magicstick/infra-cluster/...`.

## Host Bootstrap

The installer writes `/etc/default/ai-appliance-repo`. The reusable Ansible playbook reads:

- `GIT_HOST`
- `GIT_OWNER`
- `GIT_REPO`
- `GIT_BRANCH`
- `FLUX_CLUSTER_PATH`
- `ANSIBLE_INVENTORY_PATH`
- `ANSIBLE_PLAYBOOK_PATH`
- `FLUX_GITHUB_TOKEN`

Secrets such as Flux tokens must be supplied at install/runtime and must not be committed.

## Validation

```bash
ANSIBLE_ROLES_PATH=infra-host/roles \
  ansible-playbook --syntax-check infra-host/playbooks/local.yml

kubectl kustomize infra-cluster/flux-bootstrap
kubectl kustomize infra-cluster/apps
kubectl kustomize infra-cluster/apps-ai
kubectl kustomize infra-cluster/apps-ai-kubeopencode
kubectl kustomize infra-cluster/apps-ai-agent-templates
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

See [docs/public-release-checklist.md](docs/public-release-checklist.md) before publishing a release tag for private deployments to pin.
