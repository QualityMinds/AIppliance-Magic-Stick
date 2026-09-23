# Compute targets and model presets

## Compute Targets And Bundled Local Presets

The dashboard reads its local model choices from
`ConfigMap/magicstick-model-presets`; the same identifiers can be used directly
in `ModelActivation.spec.local.preset`. Presets contain engine/compute-target
variants. The separate `ConfigMap/magicstick-compute-target-catalog` maps the
logical target to supported architectures, required capabilities, Kubernetes
resource names, supported engines, and engine-specific runtime profiles. vLLM
uses CUDA, ROCm, XPU, or CPU images. Ollama uses its standard
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
slider caps allocations at the target's unreserved memory (`total memory -
active model reservations`), independent of the separate live free-memory
measurement, while retaining minimum and recommended markers in a gray
overflow area when the model is larger than unreserved capacity.
The numeric budget field can exceed this ceiling. Uncertain or insufficient
memory shows an explicit creation warning; **Add Local Model** remains enabled
for valid inputs and records `local.allowMemoryRisk: true` when accepting the
risk. This permits a startup attempt, not a guarantee of schedulability or fit.

vLLM calculations use public HuggingFace weight and architecture metadata.
Ollama calculations use exact model-layer bytes from the public registry
manifest and read a bounded GGUF-header range for attention, recurrent-state,
GQA, hybrid-layer, and context dimensions. If that range is unavailable, the
estimator reports and uses its conservative manifest-only fallback. Both RAM
and VRAM views preserve the weights, KV-cache, and reserve breakdown. Each value
has an info overlay with the server-provided formula, substituted inputs and
assumptions. Attention cache uses the sum of per-layer KV heads × (key dimensions
+ value dimensions) × bytes/value × context × sequences, rounded up to MiB.
Recurrent state is separate and context-independent. Runtime reserves and
recommended headroom explicitly remain heuristics; changing the explanation
does not change the estimator's numerical behavior.

**KV Cache** is an independent runtime choice beside **Context Size**. It does
not change the checkpoint or weight quantization. Ollama offers F16, Q8_0, and
Q4_0 on CPU, NVIDIA, and AMD. F16 uses two bytes per cached value; llama.cpp's
Q8_0 stores each 32-value block in 34 bytes including its two-byte scale, and
Q4_0 stores the same block in 18 bytes. The estimator applies those exact block
sizes to attention K and V; recurrent state remains FP32 and is not reduced.
The operator enables Flash Attention and sets `OLLAMA_KV_CACHE_TYPE` on the
single-model pod.

vLLM offers `auto` everywhere and FP8 only on the pinned CUDA/NVIDIA and
ROCm/AMD runtimes. `auto` lets vLLM use the model precision and is estimated
conservatively as two bytes per cache value; FP8 uses one. CPU and Intel XPU do
not advertise FP8 because the pinned upstream compatibility contract does not
guarantee it. The operator supplies `--kv-cache-dtype` and requests startup
scale calculation for FP8. The memory API immediately recalculates attention
cache, minimum, recommendation, and offloading when the selection changes; its
info overlays show the selected format, per-token bytes, F16 baseline, and
estimated saving.

The terminal UI can create the same local and external activation types without
a JSON file. A local TUI form lists only live engine/compute-target pairs,
accepts a direct `hf://` or `ollama://` reference, obtains the normal server-side
memory estimate, offers only KV-cache formats compatible with the selected
runtime/target, and rounds an automatic recommendation upward to the same
100 MiB planning increment as the browser. An explicit reservation remains
possible. NVIDIA models also expose the opt-in **Use additional system RAM**
choice and a separate total host-RAM budget. Leaving that budget empty uses the
server recommendation; inadequate or unverifiable budgets are rejected.

The FreeToken form is intentionally separate: it permits only a live
capability-approved NVIDIA GPU and a capability-approved `hf://` model, shows
the engine's own VRAM and Kubernetes system-RAM budgets, defaults its strategy
to `Auto`, and keeps documented runtime controls under **Advanced Settings**.
The RAM control requires a fresh capacity reading from that exact GPU node; it
never substitutes a cluster-wide CPU total when node telemetry is missing.
It does not display vLLM CPU-offloading controls or Ollama cache-format choices.
Dynamic catalog search and tested-preset browsing remain richer in
the browser; the non-interactive CLI continues to accept the complete API
payload with `model create-local --file`.

CPU-backed variants use a RAM reservation slider. The slider is capped at
unreserved system memory and writes `spec.local.memoryRequiredMi`. The operator
rounds the reservation in units of 16 MiB, then materializes a count-one
KubeAI profile with independent CPU resources. KubeAI applies the chosen
reservation as the generated model pod's `resources.requests.memory`.
Values that do not align to 16 MiB are
rounded up. Dashboard requirements and selections use safe 100 MiB planning
increments: values round upward, while the unreserved slider ceiling rounds
downward. The legacy fixed CPU profiles remain available so existing KubeAI
Model resources can finish their migration.

### CPU scheduling policy

CPU requests are per model replica, never proportional to RAM or VRAM. The
engine catalog publishes these automatic defaults:

| Runtime | CPU request | CPU limit |
|---|---:|---:|
| Ollama on a GPU | 0.5 cores | none |
| vLLM on a GPU (NVIDIA, AMD or Intel) | 1 core | none |
| Ollama or vLLM on CPU | 2 cores | 8 cores |
| FreeToken (including CPU-assisted strategies) | 4 cores | 8 cores |

Requests affect placement and relative CPU time under contention; they do not
pin dedicated cores. GPU models can burst into spare capacity without a CPU
quota. CPU inference keeps a default quota to limit contention. These are
starting values, not claims about peak use: tokenization, model loading,
compilation and CPU offloading can require substantially more CPU. Measure
under representative inference load before tuning.

`spec.local.cpuResources.requestMillicores` and `limitMillicores` optionally
override the defaults. `1000` means one logical CPU; a limit of `0` means no
quota. Omitted fields inherit the engine/target defaults. A positive limit
must be at least the resolved request. `status.cpuResources` reports the
resolved policy. Changing RAM alone does not change either CPU value.

For KubeAI the final profile is derived after UMA, offloading and sharing
placement, preserving all non-CPU resource quantities and DRA references.
Existing activations without CPU overrides automatically adopt this policy;
their model Pods may restart during migration. Existing memory budgets and
limits do not change. FreeToken applies the same policy directly to its
Deployment, with its more conservative CPU-assisted default unchanged.

Host reservations remain separate: the K3s configuration reserves 250m CPU
for system services and 250m for Kubernetes. Those 500m are excluded from
node allocatable CPU; this is not a hard isolation guarantee for system
processes.

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
engine enum contains `VLLM`, KubeAI's exact `OLlama` value, and `FreeToken`.
The Dashboard **Edit** action follows that boundary: it keeps the activation
name, namespace, model URL/preset/artifact, engine, and compute target fixed,
but can update context/output limits, maximum sequences, KV-cache type, memory
budgets, and NVIDIA CPU offloading. Its estimator excludes the activation being
edited from planned RAM/VRAM and slot use. The final write includes the
previous Kubernetes resource version, so a concurrent change returns a conflict
instead of being overwritten.
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

`spec.local.kvCacheType` stores the requested cache representation. Existing
activations default to `auto` for vLLM and `f16` for Ollama. The operator reports
that intent as `status.requestedKvCacheType`; it reports
`status.effectiveKvCacheType` only after a pod with the generated runtime
configuration is Ready. A missing effective value therefore means pending or
failed confirmation, not a silent fallback to the requested low-memory format.

Ollama variants use `ollama://` registry references, keep one model loaded per
pod, map context and parallelism to supported Ollama environment variables,
and persist the Ollama model store on the appliance host. The dashboard resolves
the public registry manifest plus a bounded GGUF-header range before creation.
It derives attention KV and recurrent-state memory from the actual architecture,
so CPU and accelerator variants receive comparable minimum and recommended
planning values. On GPU
targets the declared VRAM value is planning metadata; Kubernetes exposes exactly
one GPU to the model pod. Existing activations without an explicit offloading
policy retain Ollama's automatic loading behavior.

### vLLM vision attention deployment

`spec.local.vllm.visionAttention` selects the multimodal vision encoder attention
path for vLLM on AMD. The compute-target catalog publishes the default, target
allowlist, option labels, and runtime mapping under
`engines.VLLM.deploymentSettings.visionAttention`. Both dashboard API and
controller validate against it. The CRD restricts the values and engine.
Ollama, FreeToken, CPU, NVIDIA and Intel do not receive these AMD overrides.

| Stored value | vLLM vision backend | Additional Pod environment |
|---|---|---|
| `auto` | no override; vLLM decides | no opt-in flag from this setting |
| `aotriton` | `TORCH_SDPA` | `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` |
| `triton` (new-model default) | `TRITON_ATTN` | none |
| `flash-attn-triton` | `FLASH_ATTN` | `FLASH_ATTENTION_TRITON_AMD_ENABLE=TRUE` |

The backend maps to vLLM's `--mm-encoder-attn-backend`, not its text decoder
attention flag. The model's existing context, KV-cache settings and CPU/RAM/VRAM
budgets remain unchanged. The opt-in environment applies within that model Pod;
in particular the AOTriton switch enables PyTorch ROCm SDPA kernels process-wide.
For text-only models without a vision encoder, the vision backend override has
no vision workload to affect.

These mappings were checked against the [vLLM 0.26.0 CLI](https://docs.vllm.ai/en/v0.26.0/cli/serve/#--mm-encoder-attn-backend)
and [ROCm vision backend selector](https://docs.vllm.ai/en/v0.26.0/api/vllm/platforms/rocm/).
The AOTriton opt-in is present in [PyTorch's ROCm attention checks](https://github.com/pytorch/pytorch/blob/main/torch/testing/_internal/common_cuda.py).
The FlashAttention route requires the [AMD Triton implementation and its dependencies](https://github.com/Dao-AILab/flash-attention#amd-rocm-support)
inside the runtime image. No packages are installed by selecting an option.
Compatible GPU kernels, model shapes and dtypes still need an inference test
with the deployed image. AOTriton is experimental on the affected GPUs and can
still fall back to math attention. Auto preserves vLLM's selection behavior and
can also choose memory-intensive Torch SDPA; it is not an OOM fix or a memory
guarantee. The UI/configuration tests do not certify any manual backend on hardware.

Omitting `local.vllm` preserves legacy arguments and environment exactly. An
explicit choice takes ownership of `--mm-encoder-attn-backend` (both argument
spellings/forms) and the two opt-in environment variables in the table. It
replaces conflicting values; explicit `auto` removes them from the generated
Model. Other args/env remain intact. The generated KubeAI Model annotation
`appliance.magicstick.dev/vllm-vision-attention` records the requested policy,
not a measured/verified kernel. Runtime logs reveal the actual backend. Existing
activations are not migrated to the new default; unrelated edits preserve the
stored policy. New AMD vLLM models use `triton`; existing models remain on their
stored policy (or keep their legacy args/environment when no policy is stored).
Changing it uses normal ModelActivation reconciliation.

### AMD unified-memory reservations

An additional AMD compatibility profile is not a portable-runtime guarantee.
The experimental Strix Halo profile requires current host evidence, an
allocatable GPU and the configured KubeAI runtime. Engine validation is optional
and manual; untested, failed or stale results do not disable either engine.
Availability is not proof that an arbitrary model will run. The initial path supports one
eligible unified-memory node; mixed/different candidate nodes require explicit
hardware placement and are rejected rather than scheduled ambiguously.

The API reports `memoryArchitecture: unified` and `sharedPools`. Fresh,
corroborated KFD evidence selects `gpuAllocationMode: firmware-reserved` or
`shared-gtt`; missing evidence leaves GPU capacity unknown. These are allocation
domains of one GPU, not two selectable GPU targets, and their capacities are
never added. `sharedPools[].physicalMemoryMi` is Linux `MemTotal`, excluding
firmware-reserved GPU RAM. `gpuAccessibleMi` is the dynamic mapping ceiling;
`gpuCapacityMi` is the corroborated driver capacity used for GPU planning.

The runtime requests one AMD GPU and one Linux RAM request. Exclusive mode uses
`amd.com/gpu`; optional [DRA sharing](../administration/gpu-sharing.md) uses one shared claim while
retaining the same RAM accounting and per-model planning budgets:

- Firmware-reserved allocations: the greater of explicit host RAM and the
  engine baseline (4096 MiB Ollama, 8192 MiB vLLM), not the GPU weight budget.
- GTT or unknown allocations: at least the GPU budget, explicit host RAM and
  engine baseline. GPU and CPU demand are intersected with remaining Linux RAM
  after a system reserve, never counted as additional physical capacity.

`ModelActivation.status.sharedPoolId` identifies the Node UID,
`gpuAllocationMode` records the domain and `memoryRequiredMi` records the actual
host request. Existing larger host requests stay charged until operator
convergence updates them; missing host evidence does not silently free them.
No host memory limit is attached as a substitute for an unverified GPU limit.

`memoryAccountingVerified` stays false until GPU/cgroup accounting is actually
demonstrated; neither model readiness nor a planning budget proves a hard GPU
memory limit. This is not the discrete-GPU CPU-offloading feature. Validated
experimental image digests are published in
`flux-system/magicstick-gpu-runtime-images` and consumed by KubeAI through
Helm `valuesFrom`; upstream release pins remain the catalog defaults. See
[GPU compatibility](gpu-compatibility.md) for the experimental support and
hardware acceptance boundaries.

### Explicit CPU offloading for NVIDIA models

[GPU sharing](../administration/gpu-sharing.md) is independent of CPU offloading. Managed NVIDIA
time-slicing/exclusive profiles keep the selected node, runtime and offloading
RAM requests/limits while requesting one device-plugin allocation per model.
Sharing slots do not create VRAM partitions or additional physical GPUs.

The browser and TUI offer **Use additional system RAM** for a single NVIDIA
GPU-backed vLLM or Ollama replica. It is opt-in, does not use disk swap or another
node's RAM, and can substantially reduce inference speed. AMD/Intel offloading,
multi-GPU placement, and distributed inference are not part of this path.

Keep the GPU's VRAM budget and select a separate **Host RAM reservation**. This
second value is the total model-container RAM budget, including offloaded
weights, host runtime, and selected startup headroom; it is not extra VRAM.
The API derives the engine controls from model metadata and both budgets. The
breakdown distinguishes estimated weights and KV cache on GPU/RAM, runtime
reserves, recommendation headroom, and download size. Ollama values are a
proportional planning estimate; the runtime makes the effective placement from
the memory that is actually available when the model loads.

- **vLLM:** the selected VRAM budget determines the estimated weight deficit.
  The wrapper passes the derived MiB amount as `--cpu-offload-gb` in GiB with
  the UVA backend. KV remains on the GPU. Offloading cannot make an oversized
  GPU KV/runtime budget fit; reduce context/concurrency or increase VRAM.
- **Ollama:** CPU offloading has one policy: GPU-first auto-fit. The operator
  enables `LLAMA_ARG_FIT` and does not set a fixed GPU-layer count. Ollama places
  as many layers as possible in the actually free VRAM and uses the bounded host
  RAM for the remainder. Layer sizes and hybrid cache placement are not uniform,
  so the preflight split is not a byte-exact VRAM limit. After loading, the
  operator samples `/api/ps`; the installed-model card distinguishes
  engine-reported RAM/VRAM buffers from requests and total process memory and
  warns if reported buffers exceed the planned budget.

The operator creates a named KubeAI resource profile with exactly one GPU and
the chosen host RAM as both `requests.memory` and `limits.memory`. Increasing
RAM never multiplies the GPU request. Host availability is based on allocatable
RAM minus workload requests on an eligible GPU node, not the sum of CPU gauges
across the cluster; unscheduled requests are accounted for conservatively.
Kubernetes remains the final scheduling authority. Per-device placement is a
separate feature: the current VRAM packing view is still a planning estimate.

Existing resources that omit `cpuOffloading` are unchanged. New NVIDIA models
explicitly use `false` when the switch is off: vLLM weight offloading is disabled,
and Ollama requests all layers on GPU. When the switch is on, Ollama always uses
GPU-first auto-fit; there is no balanced, fixed-budget, or manual-layer mode.
Metadata is required for `true`; without explicit `local.allowMemoryRisk: true`, the API
rejects unknown host/VRAM capacity or allocations that cannot fit. The risk flag
allows a trial with unchanged requests/limits and may result in Pending or OOM.
It does not bypass metadata, engine, target, replica or positive-budget validation.
Runtime startup peaks and layer compatibility still require
validation on the selected model and GPU; the recommendation is not a guarantee
against OOM. See [the runtime fields](kubernetes-resources.md#cpu-offloading-fields) and
[operational checks](../administration/troubleshooting/offloading.md#cpu-offloading-checks).

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
