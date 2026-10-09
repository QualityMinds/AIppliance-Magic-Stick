# Generated model catalog

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
| `OPENCODE_DEFAULT_CONTEXT_TOKENS` | `8192` | Conservative planning context when a model exposes no positive limit. |
| `OPENCODE_DEFAULT_OUTPUT_TOKENS` | `2048` | Unknown output budget, capped at one quarter of context. |
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
| `pi-models.json` | Pi-ready LiteLLM provider with chat models, environment-based authentication, and bounded context/output budgets. |
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

## Model capabilities

Chat entries may include `capabilities` with optional `tools`, `vision` and
`reasoning` booleans. Omitted fields mean unknown; `false` explicitly means
unsupported. Only real booleans are accepted. Model names, text-generation
support and an OpenAI-compatible URL do not establish these capabilities.

Native LiteLLM `model_info.supports_function_calling`, `supports_vision` and
`supports_reasoning` supply known route metadata. Explicit
`ModelActivation.spec.local.capabilities` or `.external.capabilities` declarations
take precedence for their fields. The shared create/update API also accepts these
nested settings. For example, a partial local configuration can declare:

```yaml
local:
  capabilities:
    tools: true
    vision: false
    reasoning: true
```

Declare the effective runtime's support, including its tool parser and API
transport; these flags do not enable backend features or add reasoning parameters
to every request. Unspecified local capabilities remain unknown even if a local
alias resembles a public provider's model name. The operator carries local
declarations through `ai-appliance.io/capabilities` on the KubeAI Model; direct
runtimes and external routes carry the equivalent LiteLLM metadata.

Synchronization uses LiteLLM 1.101's `PATCH /model/{model_id}/update` endpoint;
the legacy `/model/update` does not update stored model metadata. LiteLLM also
retains old capability fields in merge/cost-map caches. The catalog records
removed declarations as unknown in `ai_appliance_unknown_capabilities`, so these
cached fields cannot re-enable a removed capability in generated configurations.
Consumers should read the canonical catalog rather than those raw cached flags.

For a logical model with multiple fallback routes, a capability is enabled only
if every route confirms it; any explicit denial disables it, and an unknown route
prevents a positive promise. Capability changes affect the normal catalog hash
and consumer refresh path. Context and output budgets retain their existing rules.

| Consumer | Native capability fields |
|---|---|
| OpenClaw | `reasoning`, `input`, and `compat.supportsTools` per model. |
| KubeOpenCode / Paperclip OpenCode | `tool_call`, `reasoning`, and `modalities.input/output` per model. |
| Hermes | `model_overrides` for the runtime `custom` provider and named `custom:litellm` profile; `supports_vision` also reaches provider-model image routing. The instance chart receives its selected model's metadata through the generic application catalog. |
| Pi | Native `reasoning` and `input`; the selected model's explicit tool denial uses the native `--no-tools` launch flag. Unknown image/reasoning support uses conservative Pi defaults because its schema requires concrete values. |

AnythingLLM and Odysseus keep their native provider behavior; their current
integrations have no supported per-model configuration fields for all three
capabilities. They still share the canonical catalog and instance authentication.
No unsupported native configuration fields are injected into these applications.

## Replicated local models

An ordinary NVIDIA DRA vLLM/Ollama activation with `local.gpuDeployment: replicated`
has several internal KubeAI Models but **one public model name**. Each ready
copy becomes a LiteLLM deployment with a distinct stable `model_info.id` and
the same `model_name`. Its internal KubeAI model name is the upstream request
target, not another user-visible model entry. Existing LiteLLM load balancing
distributes independent requests; no client-side fan-out is required.

The controller checks parent UID, selected GPU, parent/child generation,
enabled/deletion state and per-copy readiness before publishing a deployment.
An unhealthy copy is withdrawn individually. Healthy copies remain available
even while the parent is Starting or Degraded. Stop withdraws all copies; Remove
also deletes their owned runtimes. Reconciliation is asynchronous and does not
rescue already failing or in-flight requests.

Synchronization updates and removes replica deployments by ID rather than by
their shared alias. It does not adopt unmanaged or Private Mesh deployments
that happen to share a name. The generated catalog deduplicates replicas into
one model entry, so consumers continue using `litellm/<activation-name>`.

This reuses [LiteLLM model groups](https://docs.litellm.ai/docs/proxy/load_balancing)
and the existing KubeAI runtime integration. A local routing-contract test is not
proof of live multi-GPU inference or throughput scaling.

## Consumers

Apps should treat `ConfigMap/ai-model-catalog` as the model source of truth
instead of discovering models directly from KubeAI or LiteLLM.

Current consumers include:

- AnythingLLM waits for `defaults.env` to contain
  `AI_APPLIANCE_MODEL_CATALOG_READY=true`. Its init container seeds missing chat,
  context and embedding preferences from the JSON catalogs into the native
  settings file on its PVC. A fresh LiteLLM configuration requires a catalogued
  chat default. Embedding defaults are seeded only when available; document
  indexing requires an embedding model. Unknown chat context uses 4,096 tokens.
  Existing model, context, embedding and provider choices are preserved, including
  a model removed from the catalog. Catalog updates rerun initialization without
  switching an existing embedding index. Managed endpoints and credentials remain
  deployment environment variables and Secret references. See the
  [first-upgrade migration](../administration/updates-rollback.md#anythingllm-persistent-settings-migration).
- Hermes uses the native operator's inline `spec.config.raw`: the
  `AppInstance.spec.values.model` choice selects `model.default`, with an explicit
  `custom:litellm` provider and `chat_completions` transport. The native supported
  `key_cmd` reads the mounted LiteLLM Secret for main and profile-scoped auxiliary
  calls, so a stale or empty persisted `.env` cannot shadow the managed credential.
  The proxy does not receive that Secret. The native instance does not mount the exported `hermes.yaml`
  fragment or automatically replace its selected model on catalog changes.
  An unset choice remains `CHANGEME_MODEL` until an administrator selects a model.
  Its network policy explicitly permits only LiteLLM Pods on TCP 4000 for this
  connection. Native configuration is an operator-managed read-only ConfigMap;
  change the managed model through the saved AppInstance, while sessions and
  workspace data persist under `/opt/data`. The chart rolls the Pod when its
  managed model/context or proxy changes, because operator 0.2.0 does not hash
  the read-only configuration mount. The application catalog declares
  `modelContextValue: modelContextTokens` and `minimumModelContextTokens: 64000`:
  the generic instance controller forwards the selected model's actual
  `contextWindow` into Helm values. Hermes 0.21.5 requires at least 64,000 tokens;
  small or unknown contexts produce an actionable instance status error before
  upgrade, without inflating the model's capacity. Advanced
  `AppInstance.spec.values.modelContextTokens` can declare the actual supported
  context when catalog metadata is unavailable. Suspension remains possible.
- OpenClaw reads `openclaw.json` through its operator-managed `configMapRef`.
  For Dashboard-managed instances the catalog controller publishes
  `<instance-name>-model-catalog` in namespace `ai`, with the common provider list
  and that instance's `ai-appliance.io/preferred-model` annotation as its primary
  model. The annotation is derived from `AppInstance.spec.values.model`; an empty
  choice follows the catalog default. An unavailable explicit choice is retained
  rather than silently replaced. Each ConfigMap is owned by its native
  `OpenClawInstance` and is collected when that resource is deleted. Existing
  global or custom ConfigMap references are left unchanged.
  The generated `litellm` provider and default model are force-applied on every
  pod start so persisted runtime settings cannot silently restore the built-in
  public OpenAI provider. Inline `config.raw` does not supplement `configMapRef`,
  so the per-instance file contains both the provider and selected model.
  The LiteLLM credential is injected only through the
  `LITELLM_API_KEY` environment variable from its Kubernetes Secret. The same
  managed fragment selects OpenClaw's `coding` tool profile. For a selected
  model with at most 32,768 context tokens, `compaction.keepRecentTokens` retains
  at most 4,096 tokens and one quarter of its context; larger or unknown contexts
  use the upstream 20,000-token recent-history budget. OpenClaw 2026.9.8 manages
  the embedded reserve itself and caps it at one quarter of the active model's
  context. Its schema no longer accepts `reserveTokens` or `reserveTokensFloor`.
  Supplying known model context limits is therefore essential for small models.
  The recent-history budget is derived from the instance's selected model. OpenClaw operator
  0.40.0 watches the external ConfigMap and rolls the workload when it changes;
  these instances opt out of the catalog controller's additional Pod deletion.
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
- Pi Coding Agent reads `pi-models.json` through a managed symlink in its persisted
  agent directory. The selected model must exist at startup. Known context limits
  come from the shared catalog; unknown limits use an 8,192-token planning budget.
  Output is capped at the published model limit, 8,192 tokens and one quarter of
  context; unknown output limits use 2,048 tokens. These conservative defaults do
  not establish a model's physical capacity or tool-calling support. Per-model
  compaction budgets remain within the same context. The API key is resolved from
  `LITELLM_API_KEY`, and catalog changes use the existing consumer-restart path.
- Dashboard-created KubeOpenCode `AppInstance` resources are reconciled as Flux
  HelmReleases; the instance chart renders `AgentTemplate` and `Agent`
  resources.
- KubeOpenCode `AgentTemplate/litellm-default` and every Magic Stick-managed
  AppInstance template are patched with generated LiteLLM chat models and their
  OpenCode context/output limits. Withdrawn routes are removed from the provider
  list. The shared `litellm-default` template follows the global default; instance
  `model` and `small_model` choices are retained, including unavailable choices.
  Empty or initial placeholder selections are filled once. Provider connection
  settings and unrelated Pod settings are preserved. A hash in
  `podSpec.annotations["ai-appliance.io/catalog-hash"]` triggers a native rolling
  update when the effective configuration changes. KubeOpenCode 0.1.9 and its
  updated CRDs are required for this annotation field. Unmanaged templates are
  left unchanged.

The OpenCode fallback budgets also apply to Paperclip's generated provider map,
before its additional context headroom is applied. These defaults do not prove
physical model capacity or tool-calling support.

Consumers that should be restarted after catalog changes can add either a label
or annotation:

```yaml
ai-appliance.io/model-catalog-consumer: "true"
```

The controller also recognizes the built-in selectors for AnythingLLM, Hermes,
OpenClaw, and Paperclip. An explicit `"false"` label or annotation opts out even
when a built-in selector matches; use it when the native operator handles updates.
