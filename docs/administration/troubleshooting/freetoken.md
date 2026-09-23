# FreeToken troubleshooting

### FreeToken v0.1.3

FreeToken is a third local inference engine, alongside vLLM and Ollama. The
bundled path is pinned to upstream `v0.1.3` and uses a Magic Stick-built Linux
`amd64` CUDA 13 image. It is intentionally NVIDIA-only: do not select it for
CPU, AMD/ROCm, or Intel. Before FreeToken becomes selectable, Magic Stick checks
the shared capability catalog, an eligible NVIDIA whole-GPU resource, driver
r580 or newer, and CUDA 13 runtime availability. The adapter requests the
selected number of whole `nvidia.com/gpu` devices on one node and rejects
NVIDIA time-slicing, MIG/slices, mixed GPU models, and an unexpected number of
visible devices. Multiple whole homogeneous GPUs use FreeToken tensor
parallelism; this is not a claim that memory controls isolate a shared GPU.

The `freetoken` runtime module publishes its exact descriptor in
`ai-system/ConfigMap/magicstick-freetoken-runtime`:

```bash
kubectl -n ai-system get configmap magicstick-freetoken-runtime \
  -o jsonpath='{.data.promotionState}{" "}{.data.image}{" digest "}{.data.imageDigest}{" FreeToken "}{.data.version}{" port "}{.data.port}{" health "}{.data.healthPath}{"\n"}'
```

The operator activates that module with a FreeToken `ModelActivation`, reads the
image/version/port/health path from the descriptor, and owns the matching
Deployment and Service. Do not install FreeToken manually in a KubeAI Pod or
replace the descriptor with an unreviewed image.

#### FreeToken runtime-image promotion

The public base pins a verified FreeToken v0.1.3 image digest. An unpromoted
development descriptor uses `promotionState: pending` and an empty `data.image`;
it does **not** silently deploy the readable `v0.1.3` tag while its exact image
digest is still unknown. The version tag and
commit-derived SHA tag produced by
`build-freetoken-image.yml` are build outputs for discovery only; neither is a
GitOps runtime reference. The build publishes the OCI image, generates an SBOM,
and creates a signed GitHub build-provenance attestation for the exact image
digest.

After a successful build on `main`, take its **Digest** and **Source revision**
from the workflow summary and run **Promote MagicStick FreeToken runtime
digest** on `main`. That promotion workflow:

1. validates the supplied SHA-256 digest and source revision;
2. verifies that the exact GHCR manifest exists;
3. verifies its GitHub provenance attestation against this repository,
   `refs/heads/main`, and `.github/workflows/build-freetoken-image.yml`; and
4. creates or refreshes a reviewable PR that changes the descriptor to
   `ghcr.io/qualityminds/magicstick-freetoken@sha256:…` with
   `promotionState: verified`.

Merge that PR before enabling a FreeToken model. Flux then applies a
digest-pinned descriptor. The promotion workflow requires GitHub Actions to be
allowed to create branches and pull requests with its `GITHUB_TOKEN`; if the
repository policy forbids this, perform the same reviewed descriptor change
manually only after running the equivalent `gh attestation verify` command
shown in the workflow. Never substitute a mutable tag for a digest.

Locally, validate either the intentionally pending base descriptor or a
promoted descriptor with:

```bash
bash magic-cluster/platform/ai/freetoken/verify-runtime-descriptor.sh
```

The normal model source is a capability-approved `hf://` Hugging Face
safetensors or FTW checkpoint. The server-side supported-family policy is
deliberately narrower than a generic text-generation search: a model outside
that policy is rejected before a workload exists. This avoids presenting
unverified FreeToken support as a dashboard option. See the upstream
[FreeToken v0.1.3 release](https://github.com/FlashML-org/FreeToken/releases/tag/v0.1.3),
[CLI reference](https://github.com/FlashML-org/FreeToken/blob/v0.1.3/docs/cli.md),
and [supported-model guidance](https://github.com/FlashML-org/FreeToken/blob/v0.1.3/docs/models.md)
when advancing the pin or policy.

FreeToken settings are isolated under `spec.local.freetoken`. They never reuse
vLLM CPU offloading or Ollama KV-cache settings:

| Magic Stick setting | Runtime mapping | Meaning |
|---|---|---|
| `local.url: hf://…` | `MAGICSTICK_FREETOKEN_MODEL` → `ft serve --model` | Allowed Hugging Face model ID, including a supported FTW repository. |
| `local.contextWindow` | `MAGICSTICK_FREETOKEN_CONTEXT_LENGTH` → `--max-seq-len-override` | Context-length override. |
| `local.maxNumSeqs` | `MAGICSTICK_FREETOKEN_MAX_RUNNING_REQUESTS` → `--max-running-requests` | Concurrent request limit. |
| `local.maxOutputTokens` | `MAGICSTICK_FREETOKEN_MAX_OUTPUT_TOKENS` → `--max-output-tokens` | Default output-token budget. |
| `freetoken.gpuCount` | Pod `requests.nvidia.com/gpu` and `limits.nvidia.com/gpu` → `--tensor-parallel-size` | Whole homogeneous GPUs on one selected node. `1` remains the default; MIG and time-slicing are rejected. |
| `freetoken.gpuMemoryMi` | `MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI` → calculated `--memory-ratio` | Aggregate planned amount across the assigned GPUs. Magic Stick divides it conservatively per GPU and fails if that amount exceeds the lowest live free VRAM. |
| `freetoken.systemMemoryMi` | Pod `requests.memory` and `limits.memory` | Kubernetes reservation/limit. FreeToken v0.1.3 has no separate total host-RAM CLI limit. |
| `freetoken.memoryStrategy` | `MAGICSTICK_FREETOKEN_MOE_STRATEGY` → `--moe-strategy` | `auto`, `fused`, `offload`, `cpu`, or `hybrid`; `auto` is the default. |
| `advanced.cacheType` | `MAGICSTICK_FREETOKEN_CACHE_TYPE` → `--cache-type` | `radix` or `naive`. |
| `advanced.kvReserveTokens` | `MAGICSTICK_FREETOKEN_KV_RESERVE_TOKENS` → `--kv-reserve-tokens` | KV-cache token floor before automatic MoE cache sizing. |
| `advanced.moeCacheSize` | `MAGICSTICK_FREETOKEN_MOE_CACHE_SIZE` → `--moe-cache-size` | Explicit GPU expert-cache slots. |
| `advanced.maxPrefillLength` | `MAGICSTICK_FREETOKEN_MAX_PREFILL_LENGTH` → `--max-prefill-length` | Chunked-prefill token limit. |
| `advanced.cudaGraphMaxBatchSize` | `MAGICSTICK_FREETOKEN_CUDA_GRAPH_MAX_BS` → `--cuda-graph-max-bs` | CUDA graph capture batch limit. |
| `advanced.cpuThreads` | `MAGICSTICK_FREETOKEN_MOE_CPU_THREADS` → `--moe-cpu-threads` | CPU-worker count; omit it for FreeToken's automatic choice. |
| `advanced.expertLoad` | `MAGICSTICK_FREETOKEN_EXPERT_LOAD` → `--expert-load` | `auto`, lower-memory `serial`, or faster `parallel` expert-bank loading. |
| `advanced.dtype` | `MAGICSTICK_FREETOKEN_DTYPE` → `--dtype` | `auto`, `float16`, `bfloat16`, or `float32`. |

The container binds `--host 0.0.0.0 --port 1919 --gpu 0[,1,…]
--tensor-parallel-size <gpuCount>`. Kubernetes assigns the selected whole GPUs
first; these are resulting container-local indices, not host-global indices.
The adapter constructs a fixed argument array from the table above and
intentionally has no generic extra-arguments environment variable.
It accepts **either** a VRAM budget or a literal `MAGICSTICK_FREETOKEN_MEMORY_RATIO`,
never both. The dashboard/operator use the budget form.

The FreeToken cache directory is an `emptyDir` mounted at
`/var/lib/freetoken` with `fsGroup: 10001`. The runtime sets
`FREETOKEN_HOME`, `HF_HOME`, `HOME`, and `XDG_CACHE_HOME` below that mount. It
downloads weights again after a Pod recreation; persistent model storage is not
part of the initial FreeToken contract.

Check a runtime without guessing its generated resource name:

```bash
kubectl -n ai-system get modelactivation example-freetoken -o yaml
kubectl -n ai get deploy,svc \
  -l appliance.magicstick.dev/modelactivation=example-freetoken
kubectl -n ai logs -l appliance.magicstick.dev/modelactivation=example-freetoken \
  -c freetoken --tail=200
```

`GET /health` is the readiness/liveness gate. After it is Ready, FreeToken's
`GET /v1/stats` supplies the optional runtime throughput, latency, VRAM, and
pool metrics that Magic Stick records when available. The installed-model
**Logs** action uses the same activation label, so it shows startup validation,
model loading, and FreeToken errors next to vLLM/Ollama logs.

Typical failures have direct remedies:

- **No supported FreeToken GPU**: inspect the NVIDIA operator, node architecture,
  current driver, compute capability, and time-slicing/MIG configuration. Do not
  force an AMD or Intel node into the FreeToken path.
- **VRAM gauge has values but FreeToken reports capacity unavailable**: check
  that the DCGM sample identifies the selected Kubernetes node. Both `hostname`
  and the legacy `Hostname` label are supported; unbound samples cannot provide
  a node-specific FreeToken budget.
- **Driver/CUDA validation fails**: upgrade the node's NVIDIA driver to r580 or
  newer and restore the CUDA 13-capable NVIDIA runtime; the container will not
  silently use an older host driver.
- **CDI GPU assignment**: `NVIDIA_VISIBLE_DEVICES=void` can be present even when
  the assigned GPU is injected correctly. The adapter checks `nvidia-smi` and
  PyTorch CUDA device count, not this legacy-hook switch. Do not override it
  with `all`, which would bypass the intended device selection.
- **Requested VRAM exceeds current free VRAM**: stop or resize competing GPU
  workloads, lower the FreeToken VRAM budget/context/concurrency, or choose a
  smaller supported model. A stale dashboard reading cannot override the
  start-time check.
- **Editing an active FreeToken model**: the replacement can retain its own
  previous GPU/RAM budget on the same node (and same GPU count). This is not
  additional free capacity: the Deployment uses `Recreate`, and startup repeats
  the live memory check after the old Pod is gone. Edit and lifecycle controls
  compare object identity and configuration generation, so background status
  updates do not cause a false concurrent-edit error. A real configuration
  change still requires reloading the form.
- **Pod is Pending**: retain the selected `systemMemoryMi` request/limit and
  make capacity available rather than removing it. It protects the host from an
  unbounded offload workload.
- **Health remains loading or fails**: use the activation-labelled Pod logs;
  FreeToken model-format, dependency, memory, and server errors are preserved
  there. The model is not routed through LiteLLM until health succeeds.
