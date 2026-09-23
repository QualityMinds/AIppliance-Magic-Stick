# External model configuration

## External Models

External models are configured through `ConfigMap/ai-external-models` in the
`ai` namespace. The `models.json` value can be either an object with a `models`
array or a raw array.

Runtime external models can also be configured through
`ModelActivation` resources in `ai-system`. This is the Dashboard write path
and avoids patching the Flux-owned `ai-external-models` ConfigMap.

The same Dashboard **Edit** action updates provider model, API base, type,
provider-specific fields, rate limits, and context/output limits. Leaving the
API-key field blank preserves the existing Secret. A replacement key is first
written to a new managed Secret and becomes active only through the
resource-version-bound activation update; the previous managed Secret is then
removed.

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
