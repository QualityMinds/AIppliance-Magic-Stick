# Architecture

AIppliance Magic Stick is split into reusable layers for public read-only
bootstrap, runtime configuration, and optional advanced GitOps overlays.

## Repository Layers

| Layer | Path | Responsibility |
|---|---|---|
| Installer | `magic-installer` | Builds bootable Ubuntu autoinstall media with cloud-init metadata. |
| Host automation | `magic-host` | Installs and reconciles the local host with Ansible, K3s, and Flux. |
| Cluster bases | `magic-cluster` | Reusable Flux, platform, app, observability, GPU, and profile bases. |
| Examples | `examples` | Render-only public overlays using `example.local` values. |
| Documentation | `docs` | Public contract, operations, development, and release notes. |

The public repository must stay deployment-neutral. Real secrets, domains, and
storage sizing are supplied through installer metadata, dashboard settings,
runtime CRs, Kubernetes Secrets, or optional external overlays.

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
It updates the pinned public checkout and runs the public Ansible playbook with
the configured inventory. In optional GitHub bootstrap mode it can also update an
external deployment checkout.

## Bootstrap Modes

| Mode | Behavior | When to use |
|---|---|---|
| `readonly-public` | Flux reads this public repository directly and applies a public profile path. No Git token is required. | Safe demos, local appliance bring-up, and public template validation. |
| `github` | Flux bootstraps an external GitHub deployment repository and applies a sync manifest that can include this public repository. | Advanced GitOps deployments that need separate overlay ownership. |

## Flux Graph

The base graph is defined under `magic-cluster/flux/graph/base`.

| Wave | Flux Kustomization | Path | Depends on |
|---|---|---|---|
| 00 | `infrastructure-basis` | `magic-cluster/platform/basis` | none |
| 05 | `envoy-gateway` | `magic-cluster/platform/gateway/envoy-gateway` | `infrastructure-basis` |
| 10 | `identity-pilot` | `magic-cluster/platform/identity` | `envoy-gateway` |
| 15 | `magicstick-operator` | `magic-cluster/platform/magicstick-operator` | `infrastructure-basis` |
| 30 | `apps` | `magic-cluster/apps/dashboard` | `infrastructure-basis`, `identity-pilot` |

Optional AI, Observability, GPU, and instance resources are no longer applied by
the static graph. The Magic Stick Operator creates generated Flux
`Kustomization` resources from `ModuleActivation`, native KubeAI resources from
`ModelActivation`, and Flux `HelmRelease` resources from `AppInstance` CRs.

## Appliance Model

The `Appliance` CRD is the Git-owned aggregate status surface. Runtime
selection happens through `ModuleActivation`, `ModelActivation`, and
`AppInstance` CRs. The base install includes:

- K3s and Flux from host automation
- base platform components
- `Appliance`, `ModuleActivation`, `ModelActivation`, and `AppInstance` CRDs
- `ConfigMap/magicstick-module-catalog` and `ConfigMap/magicstick-app-catalog`
- live `magicstick-operator` controller
- default `Appliance/local` with profile `ai-workstation`

The default `ai-workstation` profile seeds the core AI module stack: `gpu`
(NVIDIA GPU Operator), `kubeai`, `litellm`, and `model-catalog`. These defaults
create missing `ModuleActivation` resources, but existing runtime activations
remain authoritative so administrators can disable a default module explicitly.

The Magic Stick Operator is a meta-operator. It enables modules by generating
Flux `Kustomization` resources and creates one Flux `HelmRelease` per instance
after required modules and CRDs exist. Charts for OpenClaw, Hermes, Paperclip,
and KubeOpenCode create their specialized CRs. The Odysseus chart owns its
workloads directly because there is no upstream Odysseus operator.

The dashboard is the user-facing client for this model. It runs in the cluster,
reads the Appliance, module catalog, Flux, Pod, Service, Ingress, and Event
status, and creates or patches `ModuleActivation`, `ModelActivation`, and
`AppInstance` CRs. It does not install modules or create workload resources
directly.

## Platform Components

| Area | Components |
|---|---|
| Basis | Namespaces, cert-manager, generated secrets, reloader, and Gateway-aware kdns. |
| Identity and human access | Envoy Gateway, local Keycloak identity broker, PostgreSQL, and route-level OIDC policies. |
| Appliance control plane | Appliance CRDs, module catalog, model presets, operator RBAC, and live controller. |
| AI modules | NVIDIA GPU support, KubeAI, Hermes operator, OpenClaw operator, and Paperclip operator. |
| GPU | NVIDIA GPU Operator and time-slicing GPU sharing. |
| Observability | kube-prometheus-stack, Loki, Promtail, OpenTelemetry Collector, Grafana dashboards, and authenticated Gateway API routes. |

## Application Components

| App | Path | Notes |
|---|---|---|
| Dashboard | `magic-cluster/apps/dashboard` | Cluster landing page, app discovery surface, and Appliance CR UI/API client. |
| LiteLLM | `magic-cluster/apps/ai/litellm/base` | In-cluster OpenAI-compatible API and model routing. |
| Model catalog | `magic-cluster/apps/ai/model-catalog` | Syncs KubeAI and external models into LiteLLM and publishes generated catalog fragments. |
| AnythingLLM | `magic-cluster/apps/ai/anything-llm/base` | Uses LiteLLM and the generated embedding default. |
| Runtime app instances | `AppInstance` CRs | The Magic Stick Operator creates one Flux HelmRelease per instance; its chart owns the application resources. |
| KubeOpenCode | `magic-cluster/apps/ai/kubeopencode` | Helm-managed KubeOpenCode controller and server module. |

Envoy Gateway is the only installed application gateway. The dashboard uses
authenticated local and public `HTTPRoute` resources plus API-level role
checks. LiteLLM and AnythingLLM require an authenticated Magic Stick user;
Grafana, Prometheus, and Alertmanager require at least the viewer role. The
bundled installation has no application `Ingress` resources. See
[authentication.md](authentication.md).

Local mDNS discovery follows the same Gateway API model. Routes opt in with
`lab42.io/mdns.enabled: "true"`; kdns publishes only accepted `.local`
`HTTPRoute` hostnames and uses the programmed address and listener port from the
referenced `Gateway`. No discovery-only Ingress is required.

## Value Boundary

The public repo provides reusable defaults and placeholders. Deployment-specific
values must be supplied by:

- `/etc/default/ai-appliance-repo` during host bootstrap
- `ConfigMap/ai-appliance-settings` for Flux post-build substitution
- optional external Kustomize overlays and patches
- runtime-generated Kubernetes Secrets
- approved external secret management

Do not commit real domains, private IPs, personal data, tokens, kubeconfigs,
private repository paths, or generated secrets to this repository.
