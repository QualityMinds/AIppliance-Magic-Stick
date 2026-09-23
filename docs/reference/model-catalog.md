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
