# Realtime configuration

## Realtime vLLM-Omni profile

`spec.local.realtime` selects the catalog-owned Qwen3-Omni duplex profile under
the existing `VLLM` engine. Its managed Deployment/Service use the same direct
runtime catalog path as FreeToken, not KubeAI. Current-generation Ready evidence
and a namespace-local runtime endpoint are required before publication. The
generated LiteLLM `model_info.mode` and catalog type are `realtime`; it is not a
default ordinary chat model. Disabled or unready activations are withdrawn.
The HF repository selected through search or direct input is persisted in
`local.url` and passed to the runtime; the catalog profile supplies a default and
no model/config compatibility allowlist. Quantized and unknown architectures can
be tried; the runtime decides whether it can load them. Experimental compute
selection includes NVIDIA, AMD, Intel and CPU, with matching runtime images.
Omni can consume one NVIDIA time-slicing or AMD DRA slot alongside ordinary
models. Slot intent is counted before a Pod exists and matched runtime Pods are
not charged twice; a slot is not an isolated GPU-memory quota. Only exclusive
allocation can use the two-physical-GPU stage plan; CPU requests no GPU.
See [Realtime configuration and routing](realtime.md) for exact fields, pinned
images, lifecycle, memory mapping and live acceptance requirements.

Magic Stick provides experimental vLLM-Omni profiles under the existing vLLM
engine, using the existing ModelActivation lifecycle, logs and LiteLLM routing.
The default pipeline is the upstream Qwen3-Omni duplex server. There is no
separate Magic Stick audio frontend or protocol translation service.

## Pinned runtime and support boundary

The CUDA default is `Qwen/Qwen3-Omni-30B-A3B-Instruct` with Omni source revision
`f3f8ebfc25de04ea1e1a7900144e6966a57da4f5` and image
`vllm/vllm-omni@sha256:6132afe16e2d30841ff90e22dc311056d8042cf8b688b51eea3142e3e6dead78`.
It uses vLLM 0.29.0/CUDA 13.0. The stable Omni 0.28 release does not contain
this Qwen duplex implementation. A selectable chip with an incompatible driver
will fail in that runtime; choose a matching image instead of bypassing device
assignment. The pinned development image is not a stable/fully validated release.

Catalog defaults remain digest-pinned for reproducibility. Administrators may
provide a backend-compatible tag or digest in `local.realtime.runtimeImage`.
This changes only that activation's container image, not privileges, device
binding, the namespace, service account or other engines. Custom images receive
no source compatibility patch. Use trusted images and review their licenses;
the image has access to the existing shared model cache. A tag can change; use
a digest for a reproducible experiment. Empty override returns to the catalog.

### Experimental AMD Strix Halo profile

The retained profile ID `qwen3-omni-rocm` is now a **generic AMD** experimental
profile, not restricted to Strix Halo. The heading is retained for existing
documentation links. Its image recipe is
`magic-cluster/platform/ai/realtime/image/Dockerfile.rocm`, based on
`vllm/vllm-openai-rocm:v0.29.0@sha256:e5e47f6aaab675c252c381f0dac237b31b10d87bb74d092b07fb4065efd7f5a1`
and the same pinned Omni source. Image availability is separate from hardware
selection; an empty catalog image requires an explicit runtime override.
A built image and a successful import check do not establish real GPU/audio
support. The conservative ROCm stage defaults remain eager/TRITON_ATTN.

The [dedicated CI workflow](../../.github/workflows/build-omni-rocm-image.yml) builds
this candidate on native AMD64, runs the real offline stage contract, inventories
the final image, and publishes to `ghcr.io/qualityminds/magicstick-omni-rocm` using
the repository's Actions token after source checks and an advisory license report.
No personal GHCR token is required. Manual dispatch with `publish=false` builds
and audits without uploading. The workflow records an attested digest but does
not update the catalog or deploy automatically; see the
[build and promotion procedure](../../magic-cluster/platform/ai/realtime/README.md#ci-build-and-publication).

Shared-GTT GPU allocations and host RAM are one physical memory pool. The
dashboard uses known capacity to suggest a RAM reservation including runtime
headroom, capped by the node's RAM. This is a default/warning, not a mandatory
100-GiB reservation or an OOM guarantee. Unknown GPU memory does not disable the
device. Memory is accounted once; no extra GPU is invented from shared RAM.

### Cooperative GPU sharing

Omni uses the allocation mode configured in **System → Hardware**. NVIDIA
time-slicing requests one `nvidia.com/gpu` slot. AMD DRA directly attaches the
existing shared ResourceClaim without an additional extended-resource request.
Shared mode uses exactly one slot: replicas of one GPU are not multiple GPUs.
Exclusive allocation supports the shipped one-/two-device stage plans.
Selecting Omni does not stop other models or change the sharing policy.

Memory and compute are not isolated between consumers. Users must coordinate
budgets themselves; the 90% default is not automatically reduced in shared mode.
Slot intent is reserved before a Pod exists and is not double-counted once the
Pod starts. Stop releases only the model's runtime; provider mode transitions
drain managed Omni and KubeAI workloads while retaining activations/downloads.

## Configuration contract

Existing profile IDs and saved configurations remain readable. The default
repository is a convenience, not an allowlist. Model source/profile remain
immutable in the existing editor; create a new activation to switch either.
Realtime uses its own typed settings, not ordinary vLLM/Ollama/FreeToken knobs.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ModelActivation
metadata:
  name: omni-experiment
  namespace: ai-system
spec:
  type: local
  enabled: true
  targetNamespace: ai
  local:
    engine: VLLM
    computeTarget: nvidia-gpu
    modelType: chat
    url: hf://example/omni-checkpoint
    contextWindow: 8192
    maxNumSeqs: 1
    realtime:
      profile: qwen3-omni
      gpuNode: example-node
      gpuCount: 1
      systemMemoryMi: 16384
      gpuMemoryFraction: 0.9
      thinkerCpuOffloadGiB: 0
      # Optional: runtimeImage: example.local/omni:experimental
```

| Setting | Runtime mapping |
|---|---|
| HF reference | `local.url` → `MODEL_ID` → `vllm serve`, without metadata approval |
| Compute node/count | Node selector and the selected backend resource; CPU has no GPU request. Shared GPU mode uses one slot. |
| Context / concurrent sessions | Thinker/talker `max_model_len`, stage `max_num_seqs` and `duplex_session.max_sessions` |
| System RAM | Pod request/limit; default 16 GiB, hardware-aware shared-memory suggestion in the UI |
| Thinker CPU offload | Stage 0 `engine_extras.cpu_offload_gb`; zero omits it, estimates are advisory |
| GPU memory fraction | Stage fractions; greater than zero and at most 100%, not isolated VRAM |
| Runtime image | Per-activation container image override; empty uses the backend catalog default |
| Restart | Nonce in the Pod template; settings retained |

For one GPU the fraction is divided 75%/20%/5% among thinker/talker/codec.
For two GPUs, thinker uses GPU 0; talker/codec share GPU 1 in an 80%/20% split.
CPU omits GPU device/fraction overrides. The image must support the selected
three-stage duplex pipeline; choosing another model does not rewrite its
architecture or automatically implement a new pipeline.

The bootstrap starts the existing upstream CLI, without a model-policy guard:

```text
vllm serve <selected-hf-repository> --omni --deploy-config <generated-config>
  --served-model-name <activation-name> --host 0.0.0.0 --port 8000
```

### Pinned CPU-offload compatibility repair

The pinned Omni development build omits a structured owner for vLLM's existing
`cpu_offload_gb` argument. Passing it unchanged fails before CUDA initialization
with `Stage 0 (llm_ar) ... no structured config owner: cpu_offload_gb`.
For positive Thinker offloading, the generated bootstrap applies a narrowly
scoped compatibility repair to the container's `config/omni_config.py`:

- SHA-256 must be exactly
  `cfc1ab70e1405979f5346b1adf1e27eb1cc1fcf9d34bc6f139971391e54188c7`.
- Add the field to the typed load override owner and `OmniStageLoadConfig`;
  its existing projection then passes it to `OmniEngineArgs` and vLLM.
- Accept only finite, nonnegative values. Unowned fields are still rejected;
  ownership checks are never disabled. Talker/codec retain zero offload.
- Unknown or inconsistently patched source fails closed. The repair is
  idempotent and affects only the ephemeral Realtime container, not the host,
  base image, ordinary vLLM, Ollama or FreeToken. Zero offload does not patch.

This is a Magic Stick compatibility change, **not upstream Omni support** for
the argument in that revision. A runtime upgrade requires reviewing/removing
the shim and rerunning the actual-image contract check at
`magic-cluster/platform/magicstick-operator/controller/verify_realtime_image.py`
with `--bootstrap <generated-bootstrap.py>` in a disposable copy of the pinned
image. The check resolves the real Qwen duplex pipeline, verifies per-stage
projection for zero/positive budgets, and checks validation without allocating
a GPU or downloading weights. It does not prove CUDA execution or audio quality.
Both the configuration and bootstrap content are hashed into the Pod template;
repair changes therefore recreate the runtime automatically.

The compatibility repair applies only to catalog-default images. With a custom
runtime image the upstream parser owns its fields and no source is patched.

## Lifecycle and routing

Like the direct FreeToken runtime, the Magic Stick operator creates a managed
Deployment and ClusterIP Service. Realtime also owns a generated ConfigMap for
the stage configuration. KubeAI is neither provisioned for this profile nor
placed in its WebSocket path. Existing RBAC, model slots, revision-bound edits,
log access and runtime finalization are reused.

The operator's `magicstick-realtime-runtime` Role grants ConfigMap
get/create/patch/delete only in the default model namespace `ai`. Server-side
apply needs `patch` even when creating the stage configuration for the first
time; Stop/Remove also need `delete`. No cluster-wide ConfigMap write permission
is added. An advanced deployment using a different target namespace must add an
equivalent Role and RoleBinding there for `ai-system/magicstick-operator`.
Kubernetes permission/admission errors are reported on the activation instead
of leaving an empty status and no Pod. Transient API failures remain Starting;
the controller retries and resumes automatically once the failure is resolved.

Only the CUDA Pod uses the NVIDIA RuntimeClass; ROCm/XPU use their own device
plugin or DRA binding, and CPU requests no GPU. All use no Kubernetes API token and the shared
host model cache at `/root/.cache`. Stop/Remove delete only the runtime resources,
not the downloaded cache. Stop retains the activation. Cache cleanup remains a
separate System action. Recreate prevents a restart from requesting a second
copy of the same GPU allocation. The startup probe allows up to three hours for
download/initialization; failed Pods, image pulls and OOMs are reported separately.

Only the current observed activation generation with a Ready deployment and
successful upstream `/health` is published. LiteLLM receives:

```yaml
model_name: qwen-omni-realtime
litellm_params:
  model: openai/qwen-omni-realtime
  api_base: http://qwen-omni-realtime-realtime.ai.svc.cluster.local:8000/v1
  api_key: none
model_info:
  mode: realtime
```

Clients connect to the existing authenticated LiteLLM endpoint using
`/v1/realtime?model=qwen-omni-realtime`. LiteLLM proxies to the internal Omni
server; no separate public model Service is exposed. Realtime models are not
chosen as default chat/embedding models for other applications or Private Mesh.
The existing Gateway routes already permit long-lived streams.

LiteLLM is updated from 1.84.0 to **1.101.0**, pinned to digest
`sha256:d295634e09c648dcdb72c4cc2dd226f5fb87823a73e88cbbed6f205e4deb044b`.
Its Playground accepts the GA `response.output_audio.delta` events emitted by
the pinned Omni runtime as well as the older event names. Back up the LiteLLM
PostgreSQL database before deployment; review upstream migration notes and test
existing keys, routing, OIDC and Private Mesh after the upgrade. A code-level
regression test does not validate a live database migration.
