# AIppliance-Magic-Stick

Reusable public template for building an AI Appliance from an empty machine to a running AI platform.

This repository intentionally contains generic template code, public-safe
defaults, render-only examples, and placeholders. Real deployment values are
supplied at install time, through runtime settings, or through runtime CRs
created by the dashboard.

## Installation

Choose the path that matches the starting point. All new installations end in
the same protected First-Run Setup; no default human password is generated.

| Starting point | Entry point | What it installs |
|---|---|---|
| Empty physical server | [Build and boot the USB installer](docs/installation/bare-metal.md) | Ubuntu, K3s, Flux, and Magic Stick |
| New cloud VM | [Use the cloud-init/autoinstall template](docs/installation/cloud-init-vm.md) | Ubuntu host automation, K3s, Flux, and Magic Stick |
| Existing dedicated Ubuntu 24.04 host or VM | [`install-from-linux.sh`](install-from-linux.sh) | K3s, Flux, and Magic Stick on the host |
| Existing Kubernetes cluster | [`deploy-on-k8s.sh`](deploy-on-k8s.sh) or [`deploy-on-k8s.ps1`](deploy-on-k8s.ps1) | Flux-managed Magic Stick cluster components only |

### Existing Ubuntu 24.04 host

Download the script first so it can be reviewed, then run its fail-closed
preflight and installation. The host must be dedicated to Magic Stick.

```bash
curl -fsSL \
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/install-from-linux.sh \
  -o /tmp/install-from-linux.sh

sudo bash /tmp/install-from-linux.sh --preflight-only
sudo bash /tmp/install-from-linux.sh
```

The script resolves the selected branch or tag to a commit and pins both the
host checkout and Flux source to that commit. For a released version, add
`--ref <release-tag>`.

### Existing Kubernetes cluster

Run this from an administrator workstation with `kubectl`, `helm`, `flux`, and
Python 3. The script shows the selected context and asks before creating any
cluster-wide resources.

```bash
curl -fsSL \
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/deploy-on-k8s.sh \
  -o /tmp/deploy-on-k8s.sh

bash /tmp/deploy-on-k8s.sh --context "$(kubectl config current-context)" --preflight-only
bash /tmp/deploy-on-k8s.sh --context "$(kubectl config current-context)"
```

On Windows with PowerShell 7:

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/deploy-on-k8s.ps1 `
  -OutFile $env:TEMP\deploy-on-k8s.ps1

pwsh $env:TEMP\deploy-on-k8s.ps1 -Context (kubectl config current-context) -PreflightOnly
pwsh $env:TEMP\deploy-on-k8s.ps1 -Context (kubectl config current-context)
```

The cluster installer reuses compatible existing Flux controllers but refuses
to replace another `flux-system` source, another Magic Stick installation, or
an existing First-Run state. See the complete
[installation guide](docs/installation/README.md) for prerequisites, manual
fallback steps, setup access, and operational checks.

## Layout

```text
.
├── magic-installer/            # reusable cloud-init/autoinstall template
├── magic-host/                 # reusable Ansible playbooks and roles
├── magic-cluster/              # reusable Kubernetes, app, platform and Flux bases
├── install-from-linux.sh       # one-command bootstrap for dedicated Ubuntu hosts
├── deploy-on-k8s.sh            # existing-cluster bootstrap for Bash
├── deploy-on-k8s.ps1           # existing-cluster bootstrap for PowerShell 7
├── examples/demo/              # render-only public overlay using example.local values
├── .codex/skills/              # optional repo-local Codex skill sources
├── docs/
│   ├── .nojekyll
│   ├── index.html
│   ├── README.md
│   ├── architecture.md
│   ├── authentication.md
│   ├── appliance-crd.md
│   ├── configuration.md
│   ├── dashboard.md
│   ├── development.md
│   ├── features.md
│   ├── getting-started.md
│   ├── gitops-overlays.md
│   ├── legal-notice.html
│   ├── modules.md
│   ├── model-catalog.md
│   ├── operator-orchestration.md
│   ├── operations.md
│   ├── privacy.html
│   ├── sales-deck/
│   └── public-release-checklist.md
├── CONTRIBUTING.md
├── SUPPORT.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── GOVERNANCE.md
├── MAINTAINERS.md
├── CHANGELOG.md
├── ROADMAP.md
├── THIRD_PARTY_NOTICES.md
├── LICENSE
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
| Complete feature overview with current product screenshots | [docs/features.md](docs/features.md) |
| Installation on hardware, VMs, or Kubernetes | [docs/installation/README.md](docs/installation/README.md) |
| Configuration after installation | [docs/installation/after-installation-dashboard.md](docs/installation/after-installation-dashboard.md) |
| First checkout and installer flow | [docs/getting-started.md](docs/getting-started.md) |
| Repository and cluster architecture | [docs/architecture.md](docs/architecture.md) |
| Local authentication and enterprise SSO | [docs/authentication.md](docs/authentication.md) |
| Appliance CRD | [docs/appliance-crd.md](docs/appliance-crd.md) |
| Dashboard, CLI, TUI, and control API | [docs/dashboard.md](docs/dashboard.md) |
| Module catalog | [docs/modules.md](docs/modules.md) |
| Operator orchestration | [docs/operator-orchestration.md](docs/operator-orchestration.md) |
| Runtime variables and secrets | [docs/configuration.md](docs/configuration.md) |
| Optional GitOps overlays | [docs/gitops-overlays.md](docs/gitops-overlays.md) |
| Cluster operations | [docs/operations.md](docs/operations.md) |
| AI model catalog | [docs/model-catalog.md](docs/model-catalog.md) |
| Paperclip agent execution | [docs/paperclip-agents.md](docs/paperclip-agents.md) |
| German sales deck (PowerPoint and PDF) | [docs/sales-deck/README.md](docs/sales-deck/README.md) |
| Development and release checks | [docs/development.md](docs/development.md) |

Agent-specific repo instructions live in [AGENTS.md](AGENTS.md). Optional
repo-local Codex skill sources live under [.codex/skills](.codex/skills).

## Community And Security

- [CONTRIBUTING.md](CONTRIBUTING.md) explains the public repository boundary,
  validation commands, and pull request expectations.
- [SECURITY.md](SECURITY.md) defines how to report suspected vulnerabilities or
  leaked credentials without exposing deployment-specific details.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) sets collaboration expectations.
- [SUPPORT.md](SUPPORT.md) explains where to ask public questions and where not
  to put deployment-specific data.
- [GOVERNANCE.md](GOVERNANCE.md), [MAINTAINERS.md](MAINTAINERS.md), and
  [CHANGELOG.md](CHANGELOG.md) document the lightweight public project process.
- [ROADMAP.md](ROADMAP.md) lists likely public project directions.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists referenced runtime
  images and Helm charts for release review.

## GitOps Entry Points

Public template:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
```

Render-only demo overlay:

```bash
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Public single-node profile:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/single-node
```

Advanced deployments that use an external GitOps repository can include this
repository into their source artifact, for example:

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
and playbook paths. Optional GitHub bootstrap mode additionally uses:

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
`AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` when runtime settings override the public
defaults. App-specific storage and preferred model settings are runtime
`AppInstance.spec.values`; instance hostnames are derived as
`<instance-name>.<instance-type>.<domain>`. Module storage values are runtime
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

The default appliance is GPU-neutral: LiteLLM and the model catalog support
external providers without accelerator hardware. Local models choose vLLM or
Ollama and then a compatible compute target. vLLM supports `cpu`,
`nvidia-gpu`, `amd-gpu`, and `intel-gpu`; Ollama supports CPU, NVIDIA, and AMD.
CPU models install only KubeAI; accelerator models also require their matching
provider and remain in `WaitingForGPU` until Kubernetes exposes the vendor
resource.

One shared Node Feature Discovery installation continuously classifies cluster
nodes. Matching NVIDIA, AMD, or Intel hardware requests only that vendor's
pinned operator; CPU-only clusters run none of them. The dashboard System Status
page always shows all three providers as `NotRequired`, `Installing`, `Ready`,
or with a concrete failure reason. The Models screen enables only providers
that are `Ready`; Intel automatically selects its `xe` or `i915` resource
profile.

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
kubectl kustomize magic-cluster/platform/hardware-discovery
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/platform/ai/agent-sandbox
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

See [docs/public-release-checklist.md](docs/public-release-checklist.md) before publishing a release tag.
