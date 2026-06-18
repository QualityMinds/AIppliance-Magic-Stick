# magic-cluster

Reusable Kubernetes and Flux bases for the AI Appliance.

This directory must not contain real deployment domains, Flux repository values, private addresses, personal data, or committed secrets.

## Layout

| Path | Purpose |
|---|---|
| `flux/graph/base` | Stable Flux Kustomization graph and dependency waves |
| `flux/entrypoints/base` | Neutral public Flux entrypoint |
| `flux/entrypoints/single-node` | Public read-only single-node Flux entrypoint |
| `platform/basis` | Namespaces, ingress-nginx, cert-manager, secret generator, reloader, kdns |
| `platform/ai` | AI infrastructure wave with NVIDIA GPU support, KubeAI, Hermes, OpenClaw, and Paperclip operators |
| `platform/ai/openclaw-operator` | OpenClaw CRD operator base for `openclaw.rocks/v1alpha1` instances |
| `platform/ai/paperclip-operator` | Paperclip CRD operator base for `paperclip.inc/v1alpha1` instances |
| `platform/gpu` | NVIDIA GPU Operator and CUDA MPS GPU sharing |
| `platform/observability` | Prometheus stack, Loki, Promtail, OpenTelemetry, Grafana dashboards |
| `apps/dashboard` | Dashboard app |
| `apps/ai` | LiteLLM, AnythingLLM, Qdrant, and reusable model bases |
| `apps/ai/openclaw` | Optional OpenClaw `OpenClawInstance` CR base using the OpenClaw operator |
| `apps/ai/paperclip` | Optional Paperclip `Instance` CR base using the Paperclip operator |
| `apps/ai/kubeopencode` | KubeOpenCode Helm release, separated so CRDs can become ready before custom resources |
| `apps/ai/agent-templates` | KubeOpenCode AgentTemplate resources applied after KubeOpenCode CRDs exist |

## Deployment Overlays

Concrete deployments can either use a public profile directly or live in
private repositories. A private repo can include this repository into
`vendor/magicstick` with Flux `GitRepository.spec.include`, then import bases
from `vendor/magicstick/magic-cluster/platform/*` or
`vendor/magicstick/magic-cluster/apps/*` and patch:

- domain and storage settings through Flux `postBuild` variables
- TLS issuer names
- admin emails
- selected model resources
- LiteLLM model config fragments
- AnythingLLM embedding model preference
- OpenClaw instance opt-in paths, public URL, API key Secret name, image tag, and storage sizes
- Paperclip instance opt-in paths, public URL, admin identity, image tag, and storage sizes
- KubeOpenCode default model
- Flux Kustomization paths

## Builds

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/apps/ai
kubectl kustomize magic-cluster/apps/ai/openclaw
kubectl kustomize magic-cluster/apps/ai/paperclip
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize magic-cluster/apps/ai/agent-templates
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/profiles/single-node/apps/ai
kubectl kustomize magic-cluster/profiles/single-node/apps/ai-agent-templates
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

The public `apps/ai` base is intentionally model-neutral. It includes reusable
model bases under `apps/ai/models`, but does not select them. KubeAI is applied
as part of `infrastructure-ai` before those Model resources. The
`profiles/single-node/apps/ai` overlay selects `qwen3635b` and
`qwen352bvlembedding` and configures LiteLLM and AnythingLLM defaults. The
`profiles/single-node/apps/ai-agent-templates` overlay sets KubeOpenCode
defaults for a single-node appliance.

The Paperclip operator is selected by the default `platform/ai` base so the
`instances.paperclip.inc` CRD is available with the AI infrastructure wave. The
Paperclip `Instance` base remains opt-in; deployments that want a Paperclip app
should reconcile `apps/ai/paperclip` after the operator is ready. The upstream
operator chart requires Kubernetes 1.28 or newer.

The OpenClaw operator is selected by the default `platform/ai` base so the
`openclaw.rocks/v1alpha1` CRDs are available with the AI infrastructure wave.
The OpenClaw `OpenClawInstance` base remains opt-in; deployments that want an
OpenClaw app should reconcile `apps/ai/openclaw` after the operator is ready
and provide an `openclaw-api-keys` Secret in the `ai` namespace.

The Paperclip app base creates a one-time bootstrap job so first admin setup is
handled in-cluster instead of requiring a manual shell command. By default it
uses `admin@example.com` and a generated `paperclip-admin` Secret key named
`password`; private deployments can patch
`AI_APPLIANCE_PAPERCLIP_ADMIN_EMAIL` and `AI_APPLIANCE_PAPERCLIP_ADMIN_NAME`.
