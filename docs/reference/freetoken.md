# FreeToken configuration

## FreeToken Runtimes

FreeToken is pinned to upstream `v0.1.3`. It exposes OpenAI-compatible `/v1/*`
routes itself, so Magic Stick does not try to pass it through KubeAI's engine
enum. The existing `ModelActivation` remains the single desired-state resource:
the Magic Stick Operator creates one managed Deployment and Service, and the
model catalog publishes the Service's `/v1` endpoint to LiteLLM only after the
Deployment and FreeToken health check are ready. Model removal or disabling the
activation deletes that managed runtime; changing its restart nonce rolls it out
again.

The Magic Stick adapter assigns **one or more whole, homogeneous NVIDIA GPUs on
one eligible node** per FreeToken runtime. It requests the selected count as
`nvidia.com/gpu`; it does not use MIG instances or NVIDIA time-slicing slots.
Kubernetes maps the assigned devices into the container and the adapter invokes
`ft serve --gpu 0[,1,…] --tensor-parallel-size <count>`. Those are
container-local indices, never host-global GPU IDs, and the runtime verifies
the exact device count before it starts. This makes a tensor-parallel
activation deterministic on the current NVIDIA device-plugin path without
accepting arbitrary extra CLI arguments.

The shared capability catalog is the authority for FreeToken availability. The
bundled `v0.1.3` path requires Linux on `amd64`, one or more non-timesliced
whole homogeneous NVIDIA GPUs on one eligible node, NVIDIA driver r580 or
newer, and CUDA 13. Its
conservative catalog policy recognizes the upstream-documented RTX 30/40/50
generation capability labels only; it does not infer support for another NVIDIA
architecture just because Kubernetes exposes it. It is not offered for CPU,
AMD/ROCm, or Intel. The runtime validates the device assignment, driver, CUDA
availability, and the current free VRAM before it starts; it fails with an
actionable status rather than silently using another GPU or a different backend.

`ConfigMap/magicstick-freetoken-runtime` in `ai-system` is the small runtime
descriptor consumed by the operator. After its reviewed release promotion, it
contains one Magic Stick-built **digest-pinned** image plus the FreeToken
version, port `1919`, and `/health` path. The public base deliberately leaves
that image empty while the descriptor is `promotionState: pending`, rather than
pretending that an unknown digest is a reproducible runtime. The `freetoken`
module owns the descriptor; users do not install Python packages in model Pods.
See [FreeToken runtime-image promotion](../administration/troubleshooting/freetoken.md#freetoken-runtime-image-promotion)
before enabling the module.

FreeToken takes a Hugging Face safetensors or FTW reference through `hf://`.
The capability catalog contains the documented compatible model-family policy;
the server rejects a model outside that policy before creating a workload.
This is intentionally stricter than a generic Hugging Face text-generation
search, because discovery metadata cannot prove that an arbitrary checkpoint
will work with FreeToken.

The engine-specific settings live under `spec.local.freetoken`; they do not
inherit vLLM's CPU-offloading fields or Ollama's KV-cache format. Basic settings
are `gpuDevice`, `gpuCount`, `gpuMemoryMi`, `systemMemoryMi`, and
`memoryStrategy`. `gpuCount` is both the whole-GPU Kubernetes request and the
FreeToken tensor-parallel size. `gpuMemoryMi` is the aggregate budget across
those GPUs; Magic Stick derives an equal conservative per-GPU budget. The
`advanced` object only exposes documented v0.1.3 options: `cacheType`,
`kvReserveTokens`, `moeCacheSize`, `maxPrefillLength`,
`cudaGraphMaxBatchSize`, `cpuThreads`, `expertLoad`, and `dtype`. `Auto` maps
to FreeToken's documented automatic MoE strategy. The system-RAM setting is a
Kubernetes Pod request/limit; FreeToken has no CLI flag that imposes a separate
total host-RAM ceiling.

The VRAM setting is a planned budget, not a GPU cgroup limit. At container
start, the adapter samples every assigned GPU's current free VRAM and converts
the aggregate `gpuMemoryMi` budget to a conservative equal per-GPU
`--memory-ratio` using the lowest free device. A budget larger than that live
per-GPU free memory fails clearly. This preserves the user's selected total
limit without pretending that a host-wide, dynamic GPU allocator is an
isolated VRAM reservation.

FreeToken readiness uses `GET /health`; status and optional runtime metrics use
`GET /v1/stats`. The normal installed-model log action selects the same
activation-labelled Pod as it does for vLLM and Ollama, so engine startup and
upstream error output remain in one dashboard log view.
