# Collect logs safely

## Logs

```bash
kubectl -n ai logs deploy/litellm
kubectl -n ai logs deploy/anything-llm
kubectl -n ai logs deploy/ai-model-catalog-controller
kubectl -n ai logs statefulset/paperclip
```

For operator-backed apps, also check the operator namespace:

```bash
kubectl -n hermes-operator-system logs deploy/hermes-operator-controller-manager
kubectl -n openclaw-operator-system logs deploy/openclaw-operator-controller-manager
kubectl -n paperclip-operator-system logs deploy/paperclip-operator-controller-manager
```

Deployment names can vary by chart version. Use `kubectl -n <namespace> get
deploy,pods` if a command does not match the running resource name.
