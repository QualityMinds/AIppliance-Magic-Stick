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
│   ├── .nojekyll
│   ├── index.html
│   ├── README.md
│   ├── architecture.md
│   ├── appliance-crd.md
│   ├── configuration.md
│   ├── dashboard.md
│   ├── development.md
│   ├── getting-started.md
│   ├── gitops-overlays.md
│   ├── modules.md
│   ├── model-catalog.md
│   ├── operator-orchestration.md
│   ├── operations.md
│   └── public-release-checklist.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── THIRD_PARTY_NOTICES.md
├── AGENTS.md
└── .gitleaks.toml
```

Use `example.local`, `example.com`, `CHANGEME`, or documented variables for all template values.

## Documentation

Start with [docs/README.md](docs/README.md) for the full documentation index.
The GitHub Pages landing page lives at [docs/index.html](docs/index.html);
configure Pages to publish from the `docs/` directory for a buildless project
site.

| Topic | Document |
|---|---|
| First checkout and installer flow | [docs/getting-started.md](docs/getting-started.md) |
| Repository and cluster architecture | [docs/architecture.md](docs/architecture.md) |
| Appliance CRD | [docs/appliance-crd.md](docs/appliance-crd.md) |
| Dashboard UI/API | [docs/dashboard.md](docs/dashboard.md) |
| Module catalog | [docs/modules.md](docs/modules.md) |
| Operator orchestration | [docs/operator-orchestration.md](docs/operator-orchestration.md) |
| Runtime variables and secrets | [docs/configuration.md](docs/configuration.md) |
| Private GitOps overlays | [docs/gitops-overlays.md](docs/gitops-overlays.md) |
| Cluster operations | [docs/operations.md](docs/operations.md) |
| AI model catalog | [docs/model-catalog.md](docs/model-catalog.md) |
| Development and release checks | [docs/development.md](docs/development.md) |

## Community And Security

- [CONTRIBUTING.md](CONTRIBUTING.md) explains the public repository boundary,
  validation commands, and pull request expectations.
- [SECURITY.md](SECURITY.md) defines how to report suspected vulnerabilities or
  leaked credentials without exposing private deployment details.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) sets collaboration expectations.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists referenced runtime
  images and Helm charts for release review.

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

Deployment overlays can then import individual module bases from
`vendor/magicstick/magic-cluster/platform/...` and
`vendor/magicstick/magic-cluster/apps/...`.

## Host Bootstrap

The installer writes `/etc/default/ai-appliance-repo`. In the default
`readonly-public` mode, that file only needs the public Flux source and runtime
settings:

- `FLUX_BOOTSTRAP_MODE`
- `FLUX_PUBLIC_SYNC_PATH`
- `MAGICSTICK_PUBLIC_REPO`
- `MAGICSTICK_PUBLIC_REF`
- `MAGICSTICK_PUBLIC_REF_KIND`
- `AI_APPLIANCE_DOMAIN`
- `AI_APPLIANCE_DASHBOARD_HOST`
- `AI_APPLIANCE_MDNS_DOMAIN`
- `AI_APPLIANCE_MDNS_NAME`
- `AI_APPLIANCE_DASHBOARD_MDNS_NAME`

The host converge runner supplies defaults for the public checkout, inventory
and playbook paths. Private GitHub bootstrap is opt-in and additionally uses:

- `GIT_OWNER`
- `GIT_REPO`
- `GIT_BRANCH`
- `FLUX_CLUSTER_PATH`
- `AI_APPLIANCE_PRIVATE_CHECKOUT`
- `FLUX_GITHUB_TOKEN`

Secrets such as Flux tokens must be supplied at install/runtime and must not be committed.
In `readonly-public` mode Flux reads only this public repository and does not
need a Git token.

The generated AI model catalog honors `AI_APPLIANCE_DEFAULT_CHAT_MODEL` and
`AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` for private deployments that need to
override the public defaults. App-specific storage, host, and preferred model
values are runtime `AppInstance` parameters; module storage values are runtime
`ModuleActivation.spec.parameters`.

See [docs/model-catalog.md](docs/model-catalog.md) for the model catalog
contract, external model schema, generated ConfigMap keys, and operational
checks.

## Appliance Modules

The base installation now includes the `Appliance` CRD, `ModuleActivation` and
`AppInstance` CRDs, a public-safe module catalog, a default `Appliance/local`
resource, and a live `magicstick-operator` controller. Optional capabilities
are selected declaratively through runtime CRs. The Magic Stick Operator is a
meta-operator: it enables modules with Flux and creates custom resources for
specialized operators, while OpenClaw, Hermes, Paperclip, and KubeOpenCode
remain responsible for their own workloads.

The dashboard is the UI and API client for this model. It reads the Appliance,
module catalog, Flux, Pod, Service, Ingress, and Event status, and creates or
patches only `ModuleActivation`, `ModelActivation`, and `AppInstance` CRs when
users enable modules, add models, or request instances. `Appliance/local.spec`
remains Git-owned.

See [docs/appliance-crd.md](docs/appliance-crd.md),
[docs/dashboard.md](docs/dashboard.md),
[docs/modules.md](docs/modules.md), and
[docs/operator-orchestration.md](docs/operator-orchestration.md).

## Validation

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml

gitleaks detect --source . --config .gitleaks.toml --no-git --redact
gitleaks detect --source . --config .gitleaks.toml --redact

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

See [docs/public-release-checklist.md](docs/public-release-checklist.md) before publishing a release tag for private deployments to pin.
