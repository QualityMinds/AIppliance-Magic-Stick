# AI Model Catalog

The AI model catalog is the central model registry for the AI Appliance. It
turns selected KubeAI `Model` resources and optional external model entries
into LiteLLM deployments, then publishes a generated `ai-model-catalog`
ConfigMap for apps that need a stable source of model metadata.

The catalog is accelerator-neutral. External models work with LiteLLM alone.
Local `ModelActivation` resources use vLLM on an explicit `cpu`, `nvidia-gpu`,
`amd-gpu`, or `intel-gpu` compute target. KubeAI is installed for every local
target, while the matching vendor provider is required only for an accelerator
target.

## Responsibilities

- Watch KubeAI `Model` resources and publish only models with a ready replica.
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

1. The controller lists KubeAI `Model` resources when the KubeAI CRD exists
   and selects only resources with `status.replicas.ready` greater than zero.
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

A `kubeai.org/v1` `Model` in namespace `ai` becomes a LiteLLM deployment only
after KubeAI reports at least one ready replica. Models that are still pulling
weights, compiling, warming up, or restarting are removed from the routable
LiteLLM set and generated catalog until they are ready again. A ready model is
published with:

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
The optional OpenCode output limit is read from
`metadata.annotations["ai-appliance.io/max-output-tokens"]`. The generated
OpenCode configuration always clamps its output limit to the model context
window, so a consumer cannot request more output tokens than the selected
runtime accepts.

For Dashboard-created local `ModelActivation` resources, the Magic Stick
Operator treats `spec.local.contextWindow` as the desired runtime context size.
For vLLM it writes `--max-model-len=<contextWindow>` into the generated KubeAI
`Model.spec.args`; for Ollama it writes `OLLAMA_CONTEXT_LENGTH` into
`Model.spec.env`.
`spec.local.maxOutputTokens` is published as OpenCode consumer metadata but does
not change the server context size. `spec.local.maxNumSeqs` becomes
`--max-num-seqs=<maxNumSeqs>` for vLLM and `OLLAMA_NUM_PARALLEL` for Ollama.

## Compute Targets And Bundled Local Presets

The dashboard reads its local model choices from
`ConfigMap/magicstick-model-presets`; the same identifiers can be used directly
in `ModelActivation.spec.local.preset`. Presets contain engine/compute-target
variants. The separate `ConfigMap/magicstick-compute-target-catalog` maps the
logical target to supported architectures, required capabilities, Kubernetes
resource names, supported engines, and engine-specific KubeAI resource
profiles. vLLM uses CUDA, ROCm, XPU, or CPU images. Ollama uses its standard
CPU/NVIDIA image or its ROCm image. Intel maps
the resource actually published by its device plugin (`xe` or `i915`) to the
matching vLLM profile; Ollama is deliberately unavailable for Intel until a
validated KubeAI/Ollama Intel image exists. Additional engines remain behind
the same target/variant contract.

The Dashboard uses persistent dropdowns for location, inference engine, and
hardware. Selecting `External` reveals the provider form. Selecting `Local`
adds engine and hardware dropdowns without hiding earlier selections. The
hardware list contains only compute targets whose catalog entry supports the
selected engine and whose live availability is `true`. The model form therefore
cannot advertise an Intel, AMD, NVIDIA, or CPU path that the cluster cannot
currently schedule. For vLLM accelerator models, the memory control caps
allocations at the target's available unreserved memory while retaining minimum
and recommended estimate markers in a gray overflow area when the model is
larger than current capacity.

| Preset | Engine | Target | Model | Memory budget | Context | Max output | Max sequences |
|---|---|---|---|---:|---:|---:|---:|
| `qwen2505bcpu` | vLLM | CPU | `hf://Qwen/Qwen2.5-0.5B-Instruct` | 4 GiB RAM minimum; 6 GiB container limit | 2048 | 1024 | 1 |
| `qwen2505bcpu` | vLLM | NVIDIA | `hf://Qwen/Qwen2.5-0.5B-Instruct` | `4Gi` VRAM | 2048 | 1024 | 1 |
| `qwen2505bcpu` | vLLM | AMD ROCm | `hf://Qwen/Qwen2.5-0.5B-Instruct` | `4Gi` VRAM | 2048 | 1024 | 1 |
| `qwen2505bcpu` | vLLM | Intel XPU | `hf://Qwen/Qwen2.5-0.5B-Instruct` | `4Gi` accelerator memory | 2048 | 1024 | 1 |
| `qwen2505bcpu` | Ollama | CPU | `ollama://qwen2.5:0.5b` | 2 GiB RAM minimum; 6 GiB container limit | 2048 | 1024 | 1 |
| `qwen2505bcpu` | Ollama | NVIDIA | `ollama://qwen2.5:0.5b` | `2Gi` planning requirement | 2048 | 1024 | 1 |
| `qwen2505bcpu` | Ollama | AMD ROCm | `ollama://qwen2.5:0.5b` | `2Gi` planning requirement | 2048 | 1024 | 1 |
| `qwen3827b` | vLLM | NVIDIA | `hf://cyankiwi/Qwen3.8-27B-AWQ-INT4` | `24062Mi` VRAM | 20000 | 8192 | 1 |
| `qwen3635b` | vLLM | NVIDIA | `hf://cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit` | `15Gi` VRAM | 8192 | default | 128 |
| `qwen359b` | vLLM | NVIDIA | `hf://cyankiwi/Qwen3.5-9B-AWQ-4bit` | `16Gi` VRAM | 8192 | default | 32 |
| `qwen352bvlembedding` | vLLM | NVIDIA | `hf://LifetimeMistake/Qwen3-VL-Embedding-2B-AWQ-4bit` | `5Gi` VRAM | 4096 | n/a | runtime default |

`spec.local.computeTarget` is immutable; recreate the activation to move a
model between CPU and an accelerator, or between accelerator vendors. Missing
values on existing resources keep legacy `nvidia-gpu` and `VLLM` behavior. The
engine enum contains `VLLM` and KubeAI's exact `OLlama` value. CPU vLLM
variants use an explicit
`--kv-cache-memory-bytes` value; the bundled smoke preset uses 512 MiB so it
also starts on memory-constrained local test nodes. Accelerator variants use a
VRAM budget that the runtime converts to vLLM's memory-utilization limit after
reading physical memory from the CUDA, ROCm, or XPU runtime.

Ollama variants use `ollama://` registry references, keep one model loaded per
pod, map context and parallelism to supported Ollama environment variables,
and persist the Ollama model store on the appliance host. On GPU targets the
declared VRAM value is planning metadata; Kubernetes exposes exactly one GPU to
the model pod and Ollama manages loading and any CPU offload itself.

`qwen3827b` is the validated single-GPU profile for a 24 GB-class NVIDIA GPU.
It deliberately uses a single sequence so the 20000-token KV cache remains
inside the available memory. The vLLM wrapper rejects the activation if the
configured VRAM budget is larger than the memory reported by the GPU; in that
case use a smaller model or create a custom activation with lower limits.

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
| `maxOutputTokens`, `max_output_tokens`, or LiteLLM `max_completion_tokens` metadata | Optional OpenCode output limit. |

## Defaults

The controller reads these deployment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | `auto` | Preferred default chat model id; falls back to the first available chat model. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | `auto` | Preferred default embedding model id; falls back to the first available embedding model. |
| `CATALOG_POLL_SECONDS` | `30` | Retry delay after reconciliation errors. |
| `CATALOG_WATCH_SECONDS` | `15` | Watch timeout for model and external model changes. |
| `CONSUMER_RESTART_ENABLED` | `true` | Delete known consumer pods after catalog changes. |
| `AGENT_TEMPLATE_SYNC_ENABLED` | `true` | Patch configured KubeOpenCode AgentTemplates. |
| `AGENT_TEMPLATE_NAMES` | `litellm-default` | Comma-separated AgentTemplate names to update. |
| `OPENCODE_DEFAULT_CONTEXT_TOKENS` | `131072` | Context limit used when a model exposes no positive limit. |
| `OPENCODE_DEFAULT_OUTPUT_TOKENS` | `8192` | Output limit used when a model exposes no positive limit. |
| `PAPERCLIP_OPENCODE_MAX_OUTPUT_TOKENS` | `4096` | Maximum Paperclip OpenCode output budget; at least three quarters of each model context remains available for agent instructions, tool results, and conversation state. |
| `PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS` | `4096` | Maximum physical-context safety margin hidden from Paperclip OpenCode. The margin is capped at one quarter of small contexts so they remain usable. |

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
| `opencode-providers.json` | OpenCode provider map for the internal LiteLLM endpoint, including required context and output limits. |
| `paperclip-opencode-providers.json` | Paperclip-specific OpenCode provider map with additional context headroom for long agent prompts. |
| `paperclip-adapter-models.json` | Paperclip model-picker entries for OpenCode adapters in `litellm/<model-id>` form. |
| `AI_APPLIANCE_DEFAULT_OPENCODE_MODEL` | Selected chat default in `litellm/<model-id>` form. |

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
  the `AppInstance` preferred model if present in the catalog.
- OpenClaw reads `openclaw.json` through its operator-managed `configMapRef`.
  The generated `litellm` provider and default model are force-applied on every
  pod start so persisted runtime settings cannot silently restore the built-in
  public OpenAI provider. The LiteLLM credential is injected only through the
  `LITELLM_API_KEY` environment variable from its Kubernetes Secret. The same
  managed fragment selects OpenClaw's `coding` tool profile. For a selected
  model with at most 32,768 context tokens, it disables OpenClaw's generic
  20,000-token compaction floor and reserves at most 4,096 tokens instead. This
  keeps the agent's own system and tool prompt usable on small local models;
  larger or unknown context windows retain OpenClaw's 20,000-token safety floor.
- Paperclip reads `paperclip-opencode-providers.json`, `paperclip-adapter-models.json`,
  and `AI_APPLIANCE_DEFAULT_OPENCODE_MODEL`. The adapter model list populates
  the OpenCode model picker with all catalogued chat models. Its OpenCode
  sandbox runtime uses the in-cluster LiteLLM API, and the API key comes only
  from a Kubernetes Secret. Paperclip caps output at 4,096 tokens and at most
  one quarter of its advertised context. It also advertises up to 4,096 fewer
  context tokens than the model physically accepts. This makes OpenCode compact
  before the LiteLLM/vLLM boundary even when a tool turn crosses its local
  compaction threshold through a bounded tool result. Small contexts reserve at
  most one quarter, so they remain usable for agent instructions, tool
  responses, and state.
  Catalog changes include OpenCode limit metadata in the consumer hash, so a
  changed limit follows the normal catalog consumer restart path.
- Dashboard-created KubeOpenCode `AppInstance` resources are reconciled as Flux
  HelmReleases; the instance chart renders `AgentTemplate` and `Agent`
  resources.
- KubeOpenCode `AgentTemplate/litellm-default` and every Magic Stick-managed
  AppInstance template are patched with generated LiteLLM chat models and their
  OpenCode context/output limits. Unmanaged templates are left unchanged.

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

Advanced deployments or runtime operators commonly set:

- `AI_APPLIANCE_DEFAULT_CHAT_MODEL`
- `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL`
- `ConfigMap/ai-external-models`
- local and external `ModelActivation` resources

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
