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

For Ollama, the registry source tag and the Kubernetes model name are separate
identities. Before the generated catalog exposes the Kubernetes name, the
operator confirms the source tag has finished downloading and ensures the same
name exists as an Ollama alias on every Ready model pod. This prevents a
KubeAI-ready pod from publishing a LiteLLM entry that still returns `404 model
not found`.

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
selected engine and whose live availability is `true`.

For vLLM, the model source can be a dynamic Hugging Face search, a tested
preset, or a direct `hf://` repository. The search accepts names and prefixes,
normalizes human input such as `Qwen 3.6`, and returns paginated public model
repositories. Selecting a model loads the original repository plus related
quantized repositories into a second, vertically stacked dropdown. The
first shortcut row keeps stable family searches for Qwen, DeepSeek, GLM, Llama,
and Gemma. A separate row is populated from Hugging Face's live
`trendingScore` result. A candidate must declare a direct `quantized` or
`quantization` relationship to the exact selected model.
Name-only matches and `adapter`, `finetune`, or `merge` relationships are not
selectable. Private, gated, and disabled repositories are excluded because
this release has no Hugging Face token flow. Model type and Hub pipeline must
also agree; unrelated image, audio, and classification pipelines are rejected.

Discovery metadata is advisory, not a new compatibility promise. Dynamic
artifacts are marked experimental until runtime validation, and clearly
incompatible formats are filtered out for the selected engine/compute target.
The current vLLM path excludes MLX and GGUF: MLX is not a Kubernetes vLLM
checkpoint, while a GGUF repository often contains multiple files and the
runtime contract has neither a concrete GGUF-file selector nor the required
plugin lifecycle.
The backend uses bounded Hugging Face requests, short-lived caching, response
size limits, fixed public API hosts, and continuation cursors. If discovery is
unavailable or rate-limited, tested presets and direct references remain usable.
The selected dynamic repository becomes a custom `ModelActivation` URL and is
then handled by the existing estimator, operator, KubeAI, and readiness gates.
When available, Hugging Face `usedStorage` is displayed as the download size.
The selected repository's public `config.json` supplies its advertised maximum
context as the initial editable context value. Newly configured dynamic models
start conservatively with one parallel sequence.

Ollama adds an **Ollama Library** source beside tested presets and direct
`ollama://` references. It provides the same compact model-family shortcuts as
the Hugging Face flow plus a live list from Ollama's popularity order. Search is
prefix-oriented. Selecting a model loads its public tags; each locally runnable
tag becomes a selectable artifact with its advertised download size, context,
parameter count when encoded in the tag, and quantization when encoded in the
tag. Cloud-only tags are excluded because they are not local model artifacts.

The Ollama website does not publish a documented remote catalog API. The
dashboard therefore reads only the public `ollama.com` search, library, and tag
pages through a bounded server-side adapter with a short-lived cache, fixed host
allowlist, response limit, and timeout. If that presentation changes or the
service is unavailable, tested presets and direct references remain usable.
After tag selection, the existing registry-manifest lookup replaces the
advertised size with exact model-layer bytes and also refines the quantization
when the manifest's source metadata declares it. This is discovery of published
Ollama tags, not an import of arbitrary Hugging Face GGUF files; the latter still
requires a separate import or Modelfile lifecycle.

After a preset is selected, **Precision / Quantization** lists only the
artifacts declared by that engine/target variant. Selecting an artifact changes
the checkpoint or Ollama tag and recalculates memory; it does not quantize a
model during pod start.
Every supported local artifact receives a minimum and recommended memory
estimate: vLLM on CPU/NVIDIA/AMD/Intel and Ollama on CPU/NVIDIA/AMD. The memory
control caps allocations at the target's unreserved memory (`total memory -
active model reservations`), independent of the separate live free-memory
measurement, while retaining minimum and recommended markers in a gray
overflow area when the model is larger than unreserved capacity.

vLLM calculations use public HuggingFace weight and architecture metadata.
Ollama calculations use exact model-layer bytes from the public registry
manifest and read a bounded GGUF-header range for attention, recurrent-state,
GQA, hybrid-layer, and context dimensions. If that range is unavailable, the
estimator reports and uses its conservative manifest-only fallback. Both RAM
and VRAM views preserve the weights, KV-cache, and reserve breakdown.

The terminal UI can create the same local and external activation types without
a JSON file. A local TUI form lists only live engine/compute-target pairs,
accepts a direct `hf://` or `ollama://` reference, obtains the normal server-side
memory estimate, and rounds an automatic recommendation upward to the same
100 MiB planning increment as the browser. An explicit reservation remains
possible. Dynamic catalog search and tested-preset browsing remain richer in
the browser; the non-interactive CLI continues to accept the complete API
payload with `model create-local --file`.

CPU-backed variants use a RAM reservation slider. The slider is capped at
unreserved system memory and writes `spec.local.memoryRequiredMi`. The operator
represents the value with a KubeAI resource-profile multiplier whose unit is 16
MiB. KubeAI therefore applies the chosen reservation as the generated model
pod's `resources.requests.memory`. Values that do not align to 16 MiB are
rounded up. Dashboard requirements and selections use safe 100 MiB planning
increments: values round upward, while the unreserved slider ceiling rounds
downward. The legacy fixed CPU profiles remain available so existing KubeAI
Model resources can finish their migration.

Every portable Qwen preset exposes vLLM on CPU, NVIDIA, AMD, and Intel plus
Ollama on CPU, NVIDIA, and AMD. Each engine/target variant now contains an
allowlisted artifact set and one `defaultArtifact`. Portable BF16 checkpoints
cover the broad vLLM matrix; FP8, GPTQ, or AWQ is offered only on target classes
supported by the runtime. Ollama uses explicit GGUF Q4/Q8/full-precision tags.
Existing `ModelActivation` resources that omit `spec.local.artifact` continue
to resolve the former artifact through `defaultArtifact`.

| Preset | Model family | Selectable vLLM artifacts | Selectable Ollama artifacts | Context |
|---|---|---|---|---:|
| `qwen2505bcpu` | Qwen2.5 0.5B Instruct | BF16; NVIDIA AWQ Int4/GPTQ Int4/GPTQ Int8; Intel GPTQ Int4/Int8 | Q4_K_M, Q8_0, FP16 | 2048 |
| `qwen3508b` | [Qwen3.5 0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B) | BF16 | Q8_0, BF16 | 32768 |
| `qwen352b` | [Qwen3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B) | BF16 | Q4_K_M, Q8_0, BF16 | 32768 |
| `qwen354b` | [Qwen3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B) | BF16 | Q4_K_M, Q8_0, BF16 | 32768 |
| `qwen359b` | [Qwen3.5 9B](https://huggingface.co/Qwen/Qwen3.5-9B) | BF16; NVIDIA AWQ Int4 | Q4_K_M, Q8_0, BF16 | 32768 |
| `qwen3527b` | [Qwen3.5 27B](https://huggingface.co/Qwen/Qwen3.5-27B) | BF16; NVIDIA GPTQ Int4/FP8; AMD FP8; Intel GPTQ Int4 | Q4_K_M, Q8_0, BF16 | 16384 |
| `qwen3535b` | [Qwen3.5 35B A3B](https://huggingface.co/Qwen/Qwen3.5-35B-A3B) | BF16; NVIDIA GPTQ Int4/FP8; AMD FP8; Intel GPTQ Int4 | Q4_K_M, Q8_0, BF16 | 16384 |
| `qwen3627b` | [Qwen3.6 27B](https://huggingface.co/Qwen/Qwen3.6-27B) | BF16; NVIDIA/AMD FP8 | Q4_K_M, Q8_0, BF16 | 16384 |
| `qwen3635b` | [Qwen3.6 35B A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) | BF16; NVIDIA AWQ Int4/FP8; AMD FP8 | Q4_K_M, Q8_0, BF16 | 16384 |
| `qwen3827b` | [Qwen3.8 27B](https://huggingface.co/Qwen/Qwen3.8-27B) | BF16; NVIDIA AWQ Int4/FP8; AMD FP8 | Q4_K_M, Q8_0, BF16 | 20000 |
| `qwen352bvlembedding` | Qwen3 VL Embedding 2B | NVIDIA AWQ Int4 | n/a | 4096 |

The catalog uses explicit Ollama quantization tags rather than mutable aliases.
Q4_K_M is the default where available; Q8_0 trades more memory for higher
fidelity, while BF16/FP16 retains full precision. The 0.8B Qwen3.5 registry set
has no Q4_K_M tag, so Q8_0 remains its default.
Shared vLLM CPU variants deliberately remain BF16 because the same preset must
run on both `amd64` and `arm64`, while vLLM's integer-quantization support is
architecture-specific. CPU users who need a smaller quantized artifact can
choose the Ollama engine and its pinned GGUF Q4_K_M or Q8_0 artifact. A future
vLLM CPU quantized variant must be split and accepted per architecture rather
than advertised as portable.
The bundled Ollama runtime is pinned to `0.33.2` (and `0.33.2-rocm`) so it can
parse the Qwen3.5, Qwen3.6, and Qwen3.8 model formats. The native Qwen context
windows are larger than the safe defaults above; users can raise context after
the dashboard recalculates weights, KV cache, runtime reserve, and available
memory for the selected target.

[Qwen3.8 Flash Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) is
intentionally not selectable yet. Its official
vLLM recipe requires a dedicated Qwen3.8-Flash-Next image and a multi-GPU
deployment, while the current Magic Stick contract assigns one whole GPU to a
model and does not shard a model across devices. The Ollama registry likewise
offers no portable CPU/AMD Q4/Q8 artifact for this model. Add it only together
with an explicit multi-GPU runtime design, capability detection, license review,
and end-to-end acceptance.

`spec.local.computeTarget` is immutable; recreate the activation to move a
model between CPU and an accelerator, or between accelerator vendors. Missing
values on existing resources keep legacy `nvidia-gpu` and `VLLM` behavior. The
engine enum contains `VLLM` and KubeAI's exact `OLlama` value.
`spec.local.artifact` selects one ID from the resolved preset variant. Omitting
it selects `defaultArtifact`; an unknown ID is rejected by the operator. The
resolved artifact URL remains catalog-controlled. Its artifact ID, precision,
quantization, and resolved memory requirement are reported in
`ModelActivation.status`. CPU vLLM
variants use an explicit `--kv-cache-memory-bytes` value. For models created
through the dashboard, the API derives `spec.local.kvCacheMemoryBytes` from
architecture, context, and maximum sequences; the operator passes it through
unchanged. The bundled smoke preset and legacy resources retain 512 MiB only as
a fallback. Accelerator variants use a
VRAM budget that the runtime converts to vLLM's memory-utilization limit after
reading physical memory from the CUDA, ROCm, or XPU runtime. Small allocations
use the exact budget-to-physical-memory ratio; the wrapper does not silently
raise them to a five-percent minimum. A 98-percent upper safety cap remains so
runtime overhead cannot consume the entire device.

Ollama variants use `ollama://` registry references, keep one model loaded per
pod, map context and parallelism to supported Ollama environment variables,
and persist the Ollama model store on the appliance host. The dashboard resolves
the public registry manifest plus a bounded GGUF-header range before creation.
It derives attention KV and recurrent-state memory from the actual architecture,
so CPU and accelerator variants receive comparable minimum and recommended
planning values. On GPU
targets the declared VRAM value is planning metadata; Kubernetes exposes exactly
one GPU to the model pod and Ollama manages loading and any CPU offload itself.

`qwen3827b` retains its validated single-GPU NVIDIA AWQ profile for a 24 GB-class
GPU and now also offers the official FP8 and BF16 checkpoints. NVIDIA FP8
requires a compatible accelerator generation; AMD FP8 requires a compatible
GPU/ROCm runtime. These choices therefore carry an explicit compatibility note
and remain alternatives rather than changing a conservative BF16 default on
AMD. Every
new chat variant defaults to one sequence. The vLLM wrapper rejects an
activation if its configured VRAM budget is larger than the memory reported by
the selected GPU; in that case choose a smaller or more strongly quantized
model, reduce context, or use a target with more memory.

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
