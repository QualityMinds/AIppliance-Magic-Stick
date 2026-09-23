# Run an Ollama model

## Before you start

You need Operator/Administrator access, a supported CPU/GPU target and disk space
for the model download. Intel is not an ordinary Ollama target in this integration;
check the [current matrix](../../reference/compatibility.md).

## Create

1. Open **Models → Create**, select a local model and **Ollama**.
2. Select the compute target. Use the library search, a model family, or an explicit
   `ollama://<model>:<tag>` reference. Check the selected tag, not only the family name.
3. Set a unique deployed name, context size and maximum sequences. Start with one
   sequence. Context metadata is a model capability, not a memory-fit guarantee.
4. Review the memory budget and compatible KV-cache option. Enable additional
   system RAM only if the selected configuration supports offloading and you accept
   the possible performance cost.
5. Create and inspect **Logs** while the source model downloads and initializes.

## Verify

Wait for **Ready** and send a small request through [API Access](../api-access.md)
or the LiteLLM Playground. The deployed name is the shared API model name; it may
differ from the source Ollama tag. The controller prepares that alias before routing.

## Common issues

- Source tag missing: check the exact registry tag.
- Memory failure: lower context/concurrency or choose a smaller quantization.
- GPU pending: inspect provider readiness and free slots.

Use [model lifecycle](manage.md) for start/stop/edit. The ordinary Ollama integration
does not expose the OpenAI Realtime WebSocket API; use the separate [Realtime profile](realtime.md).
