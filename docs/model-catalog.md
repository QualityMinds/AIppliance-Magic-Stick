# AI Model Catalog

The AI model catalog is the central model registry for the AI Appliance. It
turns selected KubeAI `Model` resources and optional external model entries
into LiteLLM deployments, then publishes a generated `ai-model-catalog`
ConfigMap for apps that need a stable source of model metadata.

## Responsibilities

- Watch KubeAI `Model` resources in the `ai` namespace.
- Read optional external model definitions from `ConfigMap/ai-external-models`.
- Read external runtime model requests from `ModelActivation` resources in
  namespace `ai-system`.
- Create, update, and remove AI Appliance managed models in LiteLLM.
- Publish generated catalog files in `ConfigMap/ai-model-catalog`.
- Update KubeOpenCode `AgentTemplate` resources when available.
- Restart known model-catalog consumer pods after catalog changes.

The base lives at `magic-cluster/apps/ai/model-catalog` and is included by the
public `magic-cluster/apps/ai` base.

## Resources

| Resource | Purpose |
|---|---|
| `Deployment/ai-model-catalog-controller` | Runs the Python reconciliation loop. |
| `ConfigMap/ai-external-models` | Optional user-provided model definitions. The public base is empty. |
| `ConfigMap/ai-model-catalog` | Generated catalog consumed by apps. Starts as a bootstrap placeholder. |
| `ServiceAccount/ai-model-catalog-controller` | Runtime identity for the controller. |
| `Role/ai-model-catalog-controller` | Allows reading models, configmaps, secrets, pods, and AgentTemplates. |

## Reconciliation Flow

1. The controller lists KubeAI `Model` resources when the KubeAI CRD exists.
2. It reads `ai-external-models.data["models.json"]` when present.
3. It reads enabled external `ModelActivation` resources when present.
4. It builds the desired LiteLLM model set and marks those models with
   `ai_appliance_managed=true`.
5. It calls LiteLLM `/model/new` or `/model/update` for desired models.
6. It deletes stale LiteLLM models only when they were previously marked as AI
   Appliance managed.
7. It writes generated catalog data to `ConfigMap/ai-model-catalog`.
8. It updates configured KubeOpenCode AgentTemplates with the generated chat
   model list.
9. If the catalog hash changed, it deletes known consumer pods so their owning
   controllers recreate them with the new catalog.

## KubeAI Models

Any `kubeai.org/v1` `Model` in namespace `ai` becomes a LiteLLM deployment with:

- `model_name`: the Kubernetes `metadata.name`
- `litellm_params.model`: `openai/<model-name>`
- `litellm_params.api_base`: `http://kubeai.ai.svc.cluster.local/openai/v1`
- `litellm_params.api_key`: `none`
- `model_info.ai_appliance_source`: `kubeai`

Model type is inferred from `spec.features`:

- `TextGeneration` or chat-like features become `chat`.
- `TextEmbedding` or embedding-like features become `embedding`.
- If features are ambiguous, names containing `embedding` become `embedding`;
  otherwise the model defaults to `chat`.

Context window is read from `metadata.annotations["ai-appliance.io/context-window"]`
first. If that annotation is absent, the controller looks for `--max-model-len`
or `--max-model-len=<value>` in `spec.args`.

## External Models

External models are configured through `ConfigMap/ai-external-models` in the
`ai` namespace. The `models.json` value can be either an object with a `models`
array or a raw array.

Runtime external models can also be configured through
`ModelActivation` resources in `ai-system`. This is the Dashboard write path
and avoids patching the Flux-owned `ai-external-models` ConfigMap.

Use `apiKeySecretRef` for real provider credentials. Do not commit direct
`apiKey` values to this public repository.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ai-external-models
  namespace: ai
data:
  models.json: |
    {
      "models": [
        {
          "name": "example-openai-gpt-4o-mini",
          "enabled": true,
          "type": "chat",
          "model": "openai/gpt-4o-mini",
          "apiBase": "https://api.openai.com/v1",
          "apiKeySecretRef": {
            "name": "external-openai-api-key",
            "key": "api-key"
          },
          "contextWindow": 128000
        },
        {
          "name": "example-embedding",
          "type": "embedding",
          "litellm": {
            "model": "openai/text-embedding-3-small",
            "apiBase": "https://api.openai.com/v1"
          },
          "apiKeySecretRef": {
            "name": "external-openai-api-key",
            "key": "api-key"
          }
        }
      ]
    }
```

Dashboard-created external model:

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: example-openai-gpt-4o-mini
  namespace: ai-system
spec:
  type: external
  enabled: true
  targetNamespace: ai
  external:
    model: openai/gpt-4o-mini
    apiBase: https://api.openai.com/v1
    modelType: chat
    contextWindow: 128000
    apiKeySecretRef:
      name: external-openai-api-key
      key: api-key
```

Supported external model fields:

| Field | Purpose |
|---|---|
| `name` | Required. LiteLLM model name and catalog model id. |
| `enabled` | Optional. Set to `false` to ignore the entry. |
| `type` or `modelType` | Optional. `chat` by default; commonly `chat` or `embedding`. |
| `model` or `litellm.model` | Provider model string passed to LiteLLM. |
| `apiBase`, `api_base`, `litellm.apiBase`, or `litellm.api_base` | Optional provider base URL. |
| `apiKeySecretRef.name` and `apiKeySecretRef.key` | Preferred credential source. |
| `apiKey`, `api_key`, `litellm.apiKey`, or `litellm.api_key` | Supported by the controller, but should only be used in private runtime overlays. |
| `apiVersion` or `api_version` | Optional LiteLLM `api_version`. |
| `customLlmProvider` or `custom_llm_provider` | Optional LiteLLM custom provider. |
| `tpm` and `rpm` | Optional LiteLLM rate limits. |
| `contextWindow`, `context_window`, or `max_input_tokens` | Optional model context metadata. |

## Defaults

The controller reads these deployment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | `qwen3635b` | Preferred default chat model id. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | `qwen352bvlembedding` | Preferred default embedding model id. |
| `CATALOG_POLL_SECONDS` | `30` | Retry delay after reconciliation errors. |
| `CATALOG_WATCH_SECONDS` | `15` | Watch timeout for model and external model changes. |
| `CONSUMER_RESTART_ENABLED` | `true` | Delete known consumer pods after catalog changes. |
| `AGENT_TEMPLATE_SYNC_ENABLED` | `true` | Patch configured KubeOpenCode AgentTemplates. |
| `AGENT_TEMPLATE_NAMES` | `litellm-default` | Comma-separated AgentTemplate names to update. |

Defaults are selected only if the requested model id exists in the generated
catalog. If the requested id is missing, the first model of the matching type is
used. If no model of that type exists, the default is an empty string.

## Generated ConfigMap

`ConfigMap/ai-model-catalog` contains scalar keys and generated files:

| Key | Purpose |
|---|---|
| `AI_APPLIANCE_MODEL_CATALOG_READY` | `true` after the controller has published a real catalog. |
| `AI_APPLIANCE_MODEL_CATALOG_HASH` | Short hash of models and selected defaults. |
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | Selected chat model id. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | Selected embedding model id. |
| `defaults.env` | Shell-style ready flag, hash, defaults, and model counts. |
| `catalog.json` | Complete model catalog. |
| `chat-models.json` | Chat models plus selected chat default. |
| `embedding-models.json` | Embedding models plus selected embedding default. |
| `openclaw.json` | OpenClaw-ready LiteLLM provider fragment. |
| `hermes.yaml` | Hermes-ready LiteLLM provider fragment. |

`catalog.json` uses this shape:

```json
{
  "hash": "f00dbabe12345678",
  "models": [
    {
      "id": "qwen3635b",
      "name": "qwen3635b",
      "type": "chat",
      "provider": "litellm",
      "modelRef": "litellm/qwen3635b",
      "source": "kubeai",
      "managed": true,
      "contextWindow": 8192,
      "litellm": {
        "model": "openai/qwen3635b",
        "apiBase": "http://kubeai.ai.svc.cluster.local/openai/v1"
      }
    }
  ],
  "defaultChatModel": "qwen3635b",
  "defaultEmbeddingModel": "qwen352bvlembedding"
}
```

## Consumers

Apps should treat `ConfigMap/ai-model-catalog` as the model source of truth
instead of discovering models directly from KubeAI or LiteLLM.

Current consumers include:

- AnythingLLM waits for `defaults.env` to contain
  `AI_APPLIANCE_MODEL_CATALOG_READY=true` and reads the default embedding model
  from the ConfigMap.
- Hermes waits for readiness, reads `hermes.yaml`, and applies
  `AI_APPLIANCE_HERMES_MODEL` as a preferred model if present in the catalog.
- OpenClaw waits for readiness, reads `openclaw.json`, and applies
  `AI_APPLIANCE_OPENCLAW_MODEL` as a preferred model if present in the catalog.
- Paperclip reads `AI_APPLIANCE_DEFAULT_CHAT_MODEL` and uses the in-cluster
  LiteLLM API for inference.
- KubeOpenCode `AgentTemplate/litellm-default` is patched with generated
  LiteLLM chat models when the CRD and resource are present.

Consumers that should be restarted after catalog changes can add either a label
or annotation:

```yaml
ai-appliance.io/model-catalog-consumer: "true"
```

The controller also recognizes the built-in selectors for AnythingLLM, Hermes,
OpenClaw, and Paperclip.

## GitOps Patterns

Render the base:

```bash
kubectl kustomize magic-cluster/apps/ai/model-catalog
```

Private deployments commonly patch:

- `AI_APPLIANCE_DEFAULT_CHAT_MODEL`
- `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL`
- `ConfigMap/ai-external-models`
- selected KubeAI model bases under `magic-cluster/apps/ai/models`

The public repository must keep `ai-external-models` empty and must not commit
real API keys. Store provider keys in Kubernetes Secrets created by a private
overlay, secret manager, or runtime bootstrap process.

## Operations

Inspect generated catalog status:

```bash
kubectl -n ai get configmap ai-model-catalog \
  -o jsonpath='{.data.AI_APPLIANCE_MODEL_CATALOG_READY}{"\n"}{.data.AI_APPLIANCE_MODEL_CATALOG_HASH}{"\n"}'
```

View available chat models:

```bash
kubectl -n ai get configmap ai-model-catalog \
  -o jsonpath='{.data.chat-models\.json}' | jq .
```

Check controller logs:

```bash
kubectl -n ai logs deploy/ai-model-catalog-controller
```

Common failure modes:

| Symptom | Check |
|---|---|
| `AI_APPLIANCE_MODEL_CATALOG_READY=false` | Controller has not completed a successful reconcile; check controller logs and LiteLLM reachability. |
| External model missing | Confirm `ai-external-models.data["models.json"]` is valid JSON and the entry is not `enabled: false`. |
| Default model is empty or unexpected | Confirm the requested default id exists and has the expected `chat` or `embedding` type. |
| Consumer app still uses old model data | Confirm the pod has the consumer label or annotation, or restart the app after the catalog hash changes. |
| Secret-backed external model fails | Confirm the referenced Secret and key exist in namespace `ai`; the controller needs to read the Secret value to sync LiteLLM. |
