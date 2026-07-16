# magic-cluster

Reusable Kubernetes and Flux bases for the AI Appliance.

This directory must not contain real deployment domains, Flux repository values, private addresses, personal data, or committed secrets.

See [../docs/architecture.md](../docs/architecture.md) for the cluster layer
overview, [../docs/gitops-overlays.md](../docs/gitops-overlays.md) for private
overlay patterns, and [../docs/operations.md](../docs/operations.md) for
runtime checks.

## Layout

| Path | Purpose |
|---|---|
| `flux/graph/base` | Stable Flux Kustomization graph and dependency waves |
| `flux/entrypoints/base` | Neutral public Flux entrypoint |
| `flux/entrypoints/single-node` | Public read-only single-node Flux entrypoint |
| `platform/basis` | Namespaces, cert-manager, secret generator, reloader, kdns |
| `platform/gateway/envoy-gateway` | Primary Envoy Gateway control plane and Gateway API CRDs |
| `platform/identity` | Local Keycloak/PostgreSQL identity broker and protected OIDC pilot route |
| `platform/magicstick-operator` | Appliance CRDs, module catalog, model presets, operator RBAC, live controller, and public examples |
| `platform/ai/kubeai` | KubeAI model-serving platform module |
| `platform/ai/openclaw-operator` | OpenClaw CRD operator base for `openclaw.rocks/v1alpha1` instances |
| `platform/ai/hermes-operator` | Hermes CRD operator base for `hermes.agent/v1` instances |
| `platform/ai/paperclip-operator` | Paperclip CRD operator base for `paperclip.inc/v1alpha1` instances |
| `platform/gpu` | NVIDIA GPU Operator with time-slicing GPU sharing |
| `apps/dashboard` | Dashboard app, route discovery surface, and Appliance CR UI/API client |
| `apps/ai/litellm/base` | LiteLLM API and model-routing module with shared SSO routes |
| `apps/ai/model-catalog` | Controller that syncs KubeAI `Model` CRs and optional external models into LiteLLM and publishes the generated `ai-model-catalog` ConfigMap |
| `apps/ai/anything-llm/base` | AnythingLLM app module with Qdrant and shared SSO routes |
| `apps/ai/kubeopencode` | KubeOpenCode Helm release with Envoy Gateway SSO routes, separated so CRDs can become ready before custom resources |

## Deployment Overlays

Concrete deployments can use a public profile directly. Advanced deployments can
also include this repository from an external GitOps repository into
`vendor/magicstick` with Flux `GitRepository.spec.include`, then import bases
from `vendor/magicstick/magic-cluster/platform/*` or
`vendor/magicstick/magic-cluster/apps/*` and patch:

- domain and storage settings through Flux `postBuild` variables
- TLS issuer names
- admin emails
- `ModelActivation` resources or local model presets
- optional external models in `ai-external-models`
- AI model catalog defaults for chat and embedding models
- `AppInstance` parameters for OpenClaw, Hermes, Paperclip, and KubeOpenCode
- Appliance module, model, and instance selections through runtime CRs
- Flux Kustomization paths

## Builds

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/gateway/envoy-gateway
kubectl kustomize magic-cluster/platform/identity
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

The public template no longer carries static model or app-instance descriptor
trees. The dashboard and API create `ModelActivation` resources for local or
external models, and `AppInstance` resources for concrete Hermes, OpenClaw,
Paperclip, and KubeOpenCode instances. The Magic Stick Operator enables the
required modules and creates the underlying specialized custom resources.

The `ai-model-catalog-controller` syncs KubeAI `Model` resources created from
local `ModelActivation` requests and enabled external model entries into
LiteLLM, then publishes the generated `ai-model-catalog` ConfigMap for
downstream consumers. See
[../docs/model-catalog.md](../docs/model-catalog.md) for the full contract,
external model schema, generated ConfigMap keys, and troubleshooting commands.
