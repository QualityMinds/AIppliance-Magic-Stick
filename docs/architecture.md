# Architecture

AIppliance Magic Stick is split into reusable layers that can be consumed by a
read-only public deployment or by a private GitOps deployment repository.

## Repository Layers

| Layer | Path | Responsibility |
|---|---|---|
| Installer | `magic-installer` | Builds bootable Ubuntu autoinstall media with cloud-init metadata. |
| Host automation | `magic-host` | Installs and reconciles the local host with Ansible, K3s, and Flux. |
| Cluster bases | `magic-cluster` | Reusable Flux, platform, app, observability, GPU, and profile bases. |
| Examples | `examples` | Safe example overlays using `example.local` values. |
| Documentation | `docs` | Public contract, operations, development, and release notes. |

The public repository must stay deployment-neutral. Private deployments should
import it and apply their own overlays, secrets, domains, and storage sizing.

## Bootstrap Flow

```text
Installer image
  -> Ubuntu autoinstall and cloud-init
  -> /etc/default/ai-appliance-repo
  -> /usr/local/sbin/ai-appliance-converge
  -> Ansible playbook magic-host/playbooks/local.yml
  -> K3s
  -> Flux
  -> Flux graph under magic-cluster/flux/graph/base
  -> Magic Stick Operator CRD, module catalog, and default Appliance
  -> platform and app Kustomize bases
```

The converge runner is installed as host automation and can be rerun manually.
It updates the pinned public checkout, optionally updates a private deployment
checkout, and runs the public Ansible playbook with the configured inventory.

## Bootstrap Modes

| Mode | Behavior | When to use |
|---|---|---|
| `readonly-public` | Flux reads this public repository directly and applies a public profile path. No Git token is required. | Safe demos, local appliance bring-up, and public template validation. |
| `github` | Flux bootstraps a private GitHub deployment repository and applies a private sync manifest that can include this public repository. | Real deployments that need private domains, secrets, storage sizing, and overlay ownership. |

## Flux Graph

The base graph is defined under `magic-cluster/flux/graph/base`.

| Wave | Flux Kustomization | Path | Depends on |
|---|---|---|---|
| 00 | `infrastructure-basis` | `magic-cluster/platform/basis` | none |
| 15 | `magicstick-operator` | `magic-cluster/platform/magicstick-operator` | `infrastructure-basis` |
| 30 | `apps` | `magic-cluster/apps/dashboard` | `infrastructure-basis` |

Optional AI, Observability, GPU, and instance resources are no longer applied by
the static graph. The Magic Stick Operator creates generated Flux
`Kustomization` resources from runtime CRs and creates model or app resources
from `ModelActivation` and `AppInstance` CRs.

## Appliance Model

The `Appliance` CRD is the Git-owned aggregate status surface. Runtime
selection happens through `ModuleActivation`, `ModelActivation`, and
`AppInstance` CRs. The base install includes:

- K3s and Flux from host automation
- base platform components
- `Appliance`, `ModuleActivation`, `ModelActivation`, and `AppInstance` CRDs
- `ConfigMap/magicstick-module-catalog`
- live `magicstick-operator` controller
- default `Appliance/local` with profile `ai-workstation`

The default `ai-workstation` profile seeds the core AI module stack: `gpu`
(NVIDIA GPU Operator), `kubeai`, `litellm`, and `model-catalog`. These defaults
create missing `ModuleActivation` resources, but existing runtime activations
remain authoritative so administrators can disable a default module explicitly.

The Magic Stick Operator is a meta-operator. It enables modules by generating
Flux `Kustomization` resources and creates instance resources only after the
required specialized operator CRDs exist. OpenClaw, Hermes, Paperclip, and
KubeOpenCode continue to own their workload-specific reconciliation.

The dashboard is the user-facing client for this model. It runs in the cluster,
reads the Appliance, module catalog, Flux, Pod, Service, Ingress, and Event
status, and creates or patches `ModuleActivation`, `ModelActivation`, and
`AppInstance` CRs. It does not install modules or create workload resources
directly.

## Platform Components

| Area | Components |
|---|---|
| Basis | Namespaces, ingress-nginx, cert-manager, generated secrets, reloader, and kdns. |
| Appliance control plane | Appliance CRDs, module catalog, operator RBAC, live controller, and examples. |
| AI modules | NVIDIA GPU support, KubeAI, Hermes operator, OpenClaw operator, and Paperclip operator. |
| GPU | NVIDIA GPU Operator and time-slicing GPU sharing. |
| Observability | kube-prometheus-stack, Loki, Promtail, OpenTelemetry Collector, Grafana dashboards, and public ingresses. |

## Application Components

| App | Path | Notes |
|---|---|---|
| Dashboard | `magic-cluster/apps/dashboard` | Cluster landing page, app discovery surface, and Appliance CR UI/API client. |
| LiteLLM | `magic-cluster/apps/ai/litellm/base` | In-cluster OpenAI-compatible API and model routing. |
| Model catalog | `magic-cluster/apps/ai/model-catalog` | Syncs KubeAI and external models into LiteLLM and publishes generated catalog fragments. |
| AnythingLLM | `magic-cluster/apps/ai/anything-llm/base` | Uses LiteLLM and the generated embedding default. |
| Runtime app instances | `AppInstance` CRs | Hermes, OpenClaw, Paperclip, and KubeOpenCode instances created by the Magic Stick Operator. |
| KubeOpenCode | `magic-cluster/apps/ai/kubeopencode` | Helm-managed KubeOpenCode controller and server module. |

## Value Boundary

The public repo provides reusable defaults and placeholders. Deployment-specific
values must be supplied by:

- `/etc/default/ai-appliance-repo` during host bootstrap
- `ConfigMap/ai-appliance-settings` for Flux post-build substitution
- private Kustomize overlays and patches
- runtime-generated Kubernetes Secrets
- approved external secret management

Do not commit real domains, private IPs, personal data, tokens, kubeconfigs,
private repository paths, or generated secrets to this repository.
