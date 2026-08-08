# AISIX Gateway Evaluation

AISIX is available as an experimental, opt-in canary beside LiteLLM. It is not
part of a fresh installation and it does not replace the production gateway or
change any application endpoint. The purpose of this module is to collect
Magic Stick compatibility and operational evidence before a replacement
decision is made.

The implementation uses only the Apache-2.0 AISIX data plane in standalone
mode. It does not connect to AISIX Cloud and does not install etcd, Redis, a
commercial control plane, or a public HTTPRoute.

## Architecture

```text
ModelActivation / KubeAI Model
             |
             v
  ai-model-catalog-controller
       |                 |
       v                 v
 LiteLLM Admin API   AISIX resources + credential Secrets
       |                 |
       v                 v
 production clients   internal AISIX canary
```

The model-catalog controller remains the source of truth. Every normal
reconcile continues to update LiteLLM. In parallel, it renders the subset that
AISIX can currently represent into two Secrets in the isolated
`aisix-system` namespace:

| Resource | Contents |
|---|---|
| `Secret/aisix-runtime-resources` | Declarative AISIX resource document. Provider credentials are environment references, not plaintext values. The shared caller credential is stored only as a SHA-256 hash. |
| `Secret/aisix-provider-credentials` | Provider credentials required by the compatible AISIX models. |

Flux creates two empty bootstrap Secrets in the dedicated AISIX namespace.
The controller may read and update only those two resource names; it has no
permission to create arbitrary Secrets there. The normal `ai` namespace
permissions remain read-only for Secrets.

Reloader starts a rolling AISIX update when either Secret changes. The
deployment uses `maxUnavailable: 0`; a new pod must become ready before the
last valid gateway pod is removed. Invalid generated configuration therefore
does not deliberately terminate the last ready process.

The AISIX pod disables Kubernetes service-link environment variables. The
same-named `aisix` Service would otherwise inject variables such as
`AISIX_PORT_9090_TCP_ADDR`, which AISIX interprets as configuration overrides.
Provider credentials use the separate `MAGICSTICK_AISIX_PROVIDER_KEY_*`
namespace for the same reason.

## Compatibility Scope

The first evaluation deliberately supports:

- local KubeAI chat and embedding models through KubeAI's OpenAI-compatible
  endpoint;
- external models whose LiteLLM model identifier is `openai/<model>`;
- external OpenAI-compatible endpoints with a provider credential;
- `/v1/models`, `/v1/chat/completions`, streaming-compatible request shapes,
  and `/v1/embeddings` through the AISIX proxy.

Anthropic, Bedrock, Vertex AI, Azure OpenAI, routing groups, semantic routing,
and ensembles remain on LiteLLM during this PoC. The controller lists every
skipped model and its non-sensitive reason in
`ConfigMap/ai-model-catalog.data["gateway-backends.json"]`. Unsupported
models never block the normal LiteLLM reconcile.

## Multi-Architecture Image

Upstream AISIX `v0.8.1` currently publishes an AMD64 image. Magic Stick builds
the exact upstream commit
`315ab1f94802a6704c7355fdc4e85cc4ccadeb74` for both `linux/amd64` and
`linux/arm64` through `.github/workflows/build-aisix-image.yml`.

Every branch build receives an immutable `sha-<git-sha>` tag. The deployment
image can be overridden from the module's **Configure** section. `main` also
publishes the reviewed `v0.8.1-magicstick.1` tag. The base manifest is pinned
to the verified AMD64/ARM64 index digest
`sha256:007cb3c8865e26ac7535bd51253172eca0039176e891be064409cc6dc4ec976c`.

## Enable The Canary

In the dashboard:

1. Open **Modules**.
2. Confirm **LiteLLM** and **Model Catalog** are `Ready`.
3. Open **Configure** under **AISIX (Experimental)** only when an image
   override is needed for a branch build.
4. Select **Enable**.
5. Wait for `app-aisix` and the AISIX pod to become ready.

Equivalent runtime resource:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModuleActivation
metadata:
  name: aisix
  namespace: ai-system
spec:
  module: aisix
  enabled: true
  parameters:
    image: ghcr.io/qualityminds/magicstick-aisix@sha256:007cb3c8865e26ac7535bd51253172eca0039176e891be064409cc6dc4ec976c
```

The image parameter may normally be omitted. Use it only to evaluate another
reviewed digest without changing the base manifest.

Check the rollout without printing Secret data:

```bash
kubectl -n flux-system get kustomization app-aisix
kubectl -n aisix-system get deployment,pods,service
kubectl -n aisix-system logs deployment/aisix
kubectl -n ai get configmap ai-model-catalog \
  -o jsonpath='{.data.gateway-backends\.json}' | jq .
```

AISIX has no local or public browser route. For manual API inspection, use a
temporary port forward and the same generated client key already used for
LiteLLM. Do not paste that key into terminal history, documentation, or issue
reports.

## Run The Contract Test

The test overlay is intentionally not installed by Flux. Applying it starts a
one-shot Job that checks:

- liveness and readiness;
- rejection of unauthenticated requests;
- invalid-model behavior;
- `/v1/models` compatibility with LiteLLM;
- a non-streaming and streaming chat request through both gateways;
- an embedding request through both gateways.

The overlay creates two temporary `ModelActivation` resources and a local,
OpenAI-compatible mock upstream. This exercises the complete model-catalog,
LiteLLM, AISIX, JSON, SSE, and embedding paths without a GPU, Internet access,
or provider quota. All fixture credentials are explicitly non-secret test
values.

```bash
kubectl -n ai delete job aisix-contract-test --ignore-not-found
kubectl apply -k magic-cluster/apps/ai/aisix/tests
kubectl -n ai logs -f job/aisix-contract-test
```

A successful basic run ends with:

```text
AISIX/LiteLLM contract smoke test passed
```

Remove all temporary test resources afterward:

```bash
kubectl delete -k magic-cluster/apps/ai/aisix/tests
```

## Disable And Roll Back

Select **Disable** for AISIX in the dashboard or set the activation to false:

```bash
kubectl -n ai-system patch moduleactivation aisix --type merge \
  -p '{"spec":{"enabled":false}}'
```

Production applications continue using LiteLLM throughout the evaluation, so
disabling AISIX requires no client rollback. The generated runtime Secrets may
remain in the isolated namespace for the next evaluation; they are refreshed
from the model source of truth and are never used while the AISIX workload is
absent.

## Decision Gate

Do not make AISIX the default until all of these are demonstrated on real
hardware and the supported VM architectures:

- AMD64 and ARM64 images start and pass the same contract suite;
- all required chat, streaming, tool-call, structured-output, and embedding
  paths pass against actual Magic Stick clients;
- every required external provider has an explicit adapter mapping;
- invalid configuration, provider failure, credential rotation, and rollback
  are safe;
- a 72-hour soak test has no gateway-caused errors;
- measured CPU, memory, latency, and operational effort justify removing
  LiteLLM and its PostgreSQL dependency.

Only after this gate should a later change introduce a neutral production
`ai-gateway` service and switch applications from LiteLLM to AISIX.
