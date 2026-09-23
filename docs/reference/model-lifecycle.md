# Model lifecycle contract

## Saved model lifecycle

The Models screen provides the same **Start/Stop** action for Ollama, vLLM,
FreeToken, and external provider activations. Both actions update only
`ModelActivation.spec.enabled`; identity, engine-specific settings, namespace,
and provider Secret references remain unchanged. Stop keeps the activation for
later reuse. For ordinary vLLM/Ollama, the operator deletes the generated KubeAI
`Model`; for FreeToken and Realtime it deletes the managed Deployment and Service
(plus Realtime's stage ConfigMap). Local status passes
through `Removing` to `Disabled`. Kubernetes releases runtime resources as the
dependent Pods and allocations disappear. Start resumes the normal reconciliation
path and recreates the selected engine runtime from the saved configuration.

Disabled FreeToken, Realtime and external activations are excluded from the desired
LiteLLM routes; ordinary vLLM/Ollama routes are withdrawn when their generated KubeAI
Models are removed. External Stop is only a local routing change, not a remote
server shutdown. Catalog-only models without an activation remain read-only.
See [operational notes](../administration/troubleshooting/models.md#stop-and-resume-models) before stopping a
model with active requests or a temporary download cache.
