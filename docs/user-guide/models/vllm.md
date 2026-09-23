# Run a vLLM model

## Before you start

Choose a model architecture and artifact supported by the selected vLLM runtime
and compute target. A Hugging Face search result alone is not proof of compatibility.
You need Operator/Administrator access, memory headroom and download space.

## Create

1. Open **Models → Create**, select a local model and **vLLM**.
2. Choose an eligible CPU, NVIDIA, AMD or Intel target as offered by the dashboard.
3. Search Hugging Face or enter `hf://<publisher>/<repository>` and select the artifact.
4. Review the context length, maximum sequences, KV precision and resource budget.
   Begin with one sequence and a moderate context for a new model/hardware combination.
5. Review engine-specific deployment options only when needed. An AMD vision
   attention backend must exist in the selected runtime image; the selector does
   not install missing libraries.
6. Create the model and inspect its status and **Logs**.

## Verify and tune

After **Ready**, send a request through [API Access](../api-access.md). Increase context
or concurrency gradually and test your actual workload. The memory estimator is
planning assistance, not protection from every GPU allocator or attention-kernel failure.

Explicit CPU offloading, where offered, uses RAM on the same node. It can slow
responses and needs enough host memory in addition to the GPU budget.

Ordinary vLLM uses KubeAI. Duplex audio is a separate [vLLM-Omni profile](realtime.md),
not a switch that makes every chat model implement `/v1/realtime`.

See [model lifecycle](manage.md), [runtime contracts](../../reference/kubeai-models.md)
and [offloading diagnostics](../../administration/troubleshooting/offloading.md).
