# Model catalog integration

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
