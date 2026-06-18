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
| 10 | `infrastructure-ai` | `magic-cluster/platform/ai` | `infrastructure-basis` |
| 20 | `infrastructure-observability` | `magic-cluster/platform/observability` | `infrastructure-ai` |
| 30 | `apps` | `magic-cluster/apps/dashboard` | `infrastructure-basis` |
| 40 | `apps-ai` | `magic-cluster/apps/ai` | `infrastructure-ai` |
| 50 | `apps-ai-kubeopencode` | `magic-cluster/apps/ai/kubeopencode` | `infrastructure-ai` |
| 60 | `apps-ai-agent-templates` | `magic-cluster/apps/ai/agent-templates` | `apps-ai-kubeopencode` |

The `single-node` entrypoint patches `apps-ai` and `apps-ai-agent-templates` to
use profile-specific paths under `magic-cluster/profiles/single-node`.

## Platform Components

| Area | Components |
|---|---|
| Basis | Namespaces, ingress-nginx, cert-manager, generated secrets, reloader, and kdns. |
| AI infrastructure | NVIDIA GPU support, KubeAI, Hermes operator, OpenClaw operator, and Paperclip operator. |
| GPU | NVIDIA GPU Operator, time slicing, and Magic Stick MPS control support. |
| Observability | kube-prometheus-stack, Loki, Promtail, OpenTelemetry Collector, Grafana dashboards, and public ingresses. |

## Application Components

| App | Path | Notes |
|---|---|---|
| Dashboard | `magic-cluster/apps/dashboard` | Cluster landing page and app discovery surface. |
| LiteLLM | `magic-cluster/apps/ai/litellm/base` | In-cluster OpenAI-compatible API and model routing. |
| Model catalog | `magic-cluster/apps/ai/model-catalog` | Syncs KubeAI and external models into LiteLLM and publishes generated catalog fragments. |
| AnythingLLM | `magic-cluster/apps/ai/anything-llm/base` | Uses LiteLLM and the generated embedding default. |
| Hermes | `magic-cluster/apps/ai/hermes` | Hermes `HermesInstance` CR using the Hermes operator and model catalog. |
| OpenClaw | `magic-cluster/apps/ai/openclaw` | OpenClaw `OpenClawInstance` CR using the OpenClaw operator and model catalog. |
| Paperclip | `magic-cluster/apps/ai/paperclip` | Paperclip `Instance` CR using the Paperclip operator, managed PostgreSQL, and in-cluster admin bootstrap. |
| KubeOpenCode | `magic-cluster/apps/ai/kubeopencode` | Helm-managed KubeOpenCode controller and server. |
| Agent templates | `magic-cluster/apps/ai/agent-templates` | KubeOpenCode AgentTemplate resources applied after CRDs exist. |

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
