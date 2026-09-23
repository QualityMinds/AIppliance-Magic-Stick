---
search:
  exclude: true
---

# FreeToken integration review — 21 September 2026

This dated review preserves the implementation evidence recorded at that time.
It is not a current hardware certification. Use the [current guide](../../user-guide/models/freetoken.md)
and [catalog-derived compatibility](../../reference/compatibility.md) for today's configuration.

**Implementation state:** 21 September 2026
**Upstream baseline:** [FreeToken v0.1.3](https://github.com/FlashML-org/FreeToken/tree/v0.1.3)

## Result

FreeToken is integrated as a third local inference engine without changing the
existing KubeAI execution path for vLLM or Ollama. `ModelActivation` remains
the single desired-state resource. For FreeToken, the Magic Stick Operator
creates an owned Deployment and Service because KubeAI does not offer a
FreeToken backend; the generated model catalog routes that Service's
OpenAI-compatible `/v1` endpoint through LiteLLM only after the runtime is
healthy.

The initial adapter deliberately has a narrow, verified runtime boundary:

- Linux `amd64`, NVIDIA CUDA 13, NVIDIA driver r580 or newer;
- one or more whole, homogeneous physical NVIDIA GPUs on one node per model
  server, with Tensor Parallelism matching the requested device count;
- no MIG, time-slicing, CPU, AMD/ROCm, Intel, or implicit device fallback;
- only the documented FreeToken v0.1.3 model policy and CLI settings; and
- one replica per model server.

This boundary is enforced centrally by the compute-target capability catalog,
again by the dashboard before saving a configuration, and again by the
operator before it creates workload resources.

## Reviewed integration contracts

| Area | Implemented contract |
|---|---|
| Engine configuration | `spec.local.engine: FreeToken` with isolated `spec.local.freetoken`; generic vLLM/Ollama KV-cache and CPU-offloading values are rejected rather than inherited. |
| GPU selection | The dashboard offers only fresh, capability-approved NVIDIA node devices. Unsupported devices remain visible with a reason but are not selectable. |
| Memory controls | GPU budget is bounded by physical/currently usable VRAM; system RAM is a bounded Pod request/limit on the selected node. The automatic RAM value is one quarter of node RAM, bounded to 8–32 GiB and current capacity. Missing node RAM telemetry disables the control rather than falling back to cluster-wide CPU memory. |
| Runtime mapping | The image adapter maps named settings to the documented `ft serve` arguments and accepts no arbitrary extra arguments or environment injection. |
| Lifecycle | Create, stop, start, restart, status, health, and bounded activation-owned logs use the existing model lifecycle/API surface. Restart changes an operator-owned rollout nonce. |
| Routing | A Ready, healthy FreeToken activation publishes an `openai/<model>` LiteLLM route; starting, failed, stopped, or endpointless activations are withdrawn. |
| Observability | The operator normalizes `/v1/stats` into `status.freeTokenStats`; the dashboard displays optional VRAM, cache, throughput, request, and latency values without changing the existing Ollama usage contract. |
| Cross-node accounting | A `node:<name>` FreeToken selection carries a node binding through reservation accounting. It never charges another NVIDIA node when its own telemetry is missing. |
| Runtime supply chain | The public descriptor pins a verified image digest. A main-only build attests that digest, and a separate promotion workflow verifies it. If repository policy prevents automatic PR creation, the documented manual promotion performs the same checks. |

## Safety checks covered in code

- GPU admission is checked against the actual NVML and PyTorch CUDA device
  counts. CDI's `NVIDIA_VISIBLE_DEVICES=void` is not treated as missing hardware;
  visibility variables are never rewritten. Missing, extra, or MIG devices
  still fail validation.
- Whole-device scheduling is recorded in `status.gpuSharing.mode: exclusive`;
  the separate unified-memory accounting field `gpuAllocationMode` remains
  empty for discrete NVIDIA GPUs, as required by the ModelActivation schema.
- A JSON `/health` response with `status: error` fails the image-level,
  startup, readiness, and liveness probes even if its HTTP status is `200`.
- The operator rejects a direct/stale `ModelActivation` whose VRAM budget
  exceeds detected GPU capacity or whose system-RAM reservation exceeds the
  selected node's allocatable RAM.
- The runtime samples *current free* VRAM on every assigned device immediately
  before deriving `--memory-ratio`; the aggregate budget is divided
  conservatively per tensor-parallel rank using the lowest free device. A race
  therefore produces an actionable runtime failure instead of silently
  expanding the budget.
- An empty, mutable, malformed, or unattested runtime descriptor never creates
  a Deployment. Its activation remains in `WaitingForRuntime` until a verified
  digest promotion exists.
- vLLM and Ollama retain their KubeAI resource reconciliation and do not call
  the FreeToken Deployment path.

## Local validation completed

- Dashboard API tests, including FreeToken capability, persistence, lifecycle,
  log authorization, node-bound reservation, and zero-capacity cases.
- Magic Stick Operator tests, including direct deployment/service generation,
  rejection of AMD/MIG/time-slicing/old-driver cases, descriptor gating,
  static VRAM/RAM limits, health semantics, stats normalization, and a vLLM
  regression path.
- Model-catalog tests for publication and withdrawal of FreeToken routes.
- Dashboard type checking and focused UI tests for engine selection, the
  separated configuration panel, unavailable GPUs, edit persistence, and
  normalized status values.
- Shell syntax, descriptor validation, Kustomize rendering, and whitespace
  checks.
- Full entrypoint shell tests execute the final `ft serve` handoff with mocked
  hardware/CLI providers, both with omitted optional settings and with explicit
  zero-valued cache settings. They cover `set -e` behavior beyond GPU preflight.

## Required release and hardware gates

The following cannot be proven by static or mocked local tests and remain
required before enabling the feature on an appliance:

1. The CUDA 13 image was built on `main` and its registry manifest and signed
   provenance verified before digest promotion on 21 September 2026. Repeat
   those release checks for every runtime-image update.
2. On a supported NVIDIA node, start a documented v0.1.3 model, send an
   OpenAI-compatible inference request through LiteLLM, and verify `/health`,
   `/v1/stats`, logs, stop, restart, and removal.
3. Repeat one existing vLLM and one existing Ollama start/request/lifecycle
   flow on the same target environment.
4. Exercise a VRAM contention case and a model-load failure, verifying that the
   dashboard shows the actionable operator/runtime state rather than a generic
   exit code.

Multi-GPU tensor parallelism is supported only through the explicit same-node
whole-GPU contract: Kubernetes reserves the selected `nvidia.com/gpu` count,
the controller rejects MIG/time-slicing and mixed cards, and the image adapter
maps the assigned container-local devices to `--gpu 0,1,…` and the matching
`--tensor-parallel-size`. Cross-node placement and synthetic GPU slots remain
unsupported.
