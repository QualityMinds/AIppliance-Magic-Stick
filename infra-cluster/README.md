# infra-cluster

Reusable Kubernetes and Flux bases for the AI Appliance.

This directory must not contain real deployment domains, Flux repository values, private addresses, personal data, or committed secrets.

## Bases

| Path | Purpose |
|---|---|
| `flux-bootstrap` | Generic Flux Kustomization objects pointing at `infra-cluster/*` |
| `infrastructure-basis` | Namespaces, ingress-nginx, cert-manager, secret generator, reloader, kdns |
| `infrastructure-ai` | NVIDIA GPU Operator and GPU time slicing |
| `infrastructure-observability` | Prometheus stack, Loki, Promtail, OpenTelemetry, Grafana dashboards |
| `apps` | Dashboard base |
| `apps-ai` | LiteLLM, AnythingLLM, Qdrant, and reusable model bases |
| `apps-ai-kubeopencode` | KubeOpenCode Helm release, separated so CRDs can become ready before custom resources |
| `apps-ai-agent-templates` | KubeOpenCode AgentTemplate resources applied after KubeOpenCode CRDs exist |
| `profiles/single-node` | Public read-only profile with default model and agent selections |

## Deployment Overlays

Concrete deployments can either use a public profile directly or live in
private repositories. A private repo can include this repository into
`vendor/magicstick` with Flux `GitRepository.spec.include`, then import bases
from `vendor/magicstick/infra-cluster/*` and patch:

- domain and storage settings through Flux `postBuild` variables
- TLS issuer names
- admin emails
- selected model resources
- LiteLLM model config fragments
- AnythingLLM embedding model preference
- KubeOpenCode default model
- Flux Kustomization paths

## Builds

```bash
kubectl kustomize infra-cluster/flux-bootstrap
kubectl kustomize infra-cluster/apps
kubectl kustomize infra-cluster/apps-ai
kubectl kustomize infra-cluster/apps-ai-kubeopencode
kubectl kustomize infra-cluster/apps-ai-agent-templates
kubectl kustomize infra-cluster/profiles/single-node/flux-bootstrap
kubectl kustomize infra-cluster/profiles/single-node/apps-ai
kubectl kustomize infra-cluster/profiles/single-node/apps-ai-agent-templates
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

The public `apps-ai` base is intentionally model-neutral. It includes reusable model bases under `apps-ai/models`, but does not select them. A deployment overlay selects concrete models.
The public `profiles/single-node` profile selects `qwen3635b` and
`qwen352bvlembedding` and configures LiteLLM, AnythingLLM, and KubeOpenCode
defaults for a single-node appliance.
