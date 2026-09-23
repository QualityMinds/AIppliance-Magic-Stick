# vLLM and Ollama runtime contracts

## KubeAI Models

KubeAI v0.23.2 can count a terminal Pod as a replica after reboot/admission
failure. The Magic Stick controller replaces only `Failed`/`Succeeded` Pods
whose controller owner exactly matches the current KubeAI Model name and UID.
Deletion includes Pod UID/resourceVersion preconditions; it never deletes
Running/Pending Pods or GPU ResourceClaims. `status.podRecovery` retains the
original failure and at most five attempts with 30/60/120/240-second backoff.
Readiness clears the tracker; a new desired model revision starts a new retry
budget. Exhaustion is `Degraded/ModelPodRecoveryExhausted`, not endless Starting.

The dashboard's GPU gauges show model slots separately from memory. Enabled
models reserve slots while starting; their Pods are not counted a second time.
Full GPUs stay visible but disabled in the Hardware selector, and the API checks
slots before accepting a local model write. Accepting an uncertain memory budget
does not bypass this scheduling limit. See [GPU slot accounting](../administration/gpu-sharing.md#model-slot-accounting).

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

Before any model Pod exists, an activation reports `WaitingForPod`, not runtime
startup. Two minutes without a Pod produces `Degraded` /
`ModelPodCreationStalled`; the controller keeps retrying and recovers when a
Pod appears. Existing Pods can download models or initialize without this
no-Pod timeout. See [model readiness](../concepts/controllers.md#module-and-model-readiness).
