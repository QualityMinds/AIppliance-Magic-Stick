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
| `apps` | Dashboard and Forgejo bases |
| `apps-ai` | LiteLLM, AnythingLLM, Qdrant, KubeOpenCode, and reusable model bases |

## Deployment Overlays

Concrete deployments should live in private repositories. A private repo can include this repository into `vendor/magicstick` with Flux `GitRepository.spec.include`, then import bases from `vendor/magicstick/infra-cluster/*` and patch:

- ingress hosts and domains
- TLS issuer names
- admin emails
- storage sizes
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
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

The public `apps-ai` base is intentionally model-neutral. It includes reusable model bases under `apps-ai/models`, but does not select them. A deployment overlay selects concrete models.
