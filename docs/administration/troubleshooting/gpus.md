# GPU runtime diagnostics

## Local Inference And Hardware-Driven GPU Operators

### Reboot recovery and rollout order

1. Run the updated K3s host role first. It predeclares the optional NVIDIA
   containerd v3 runtimes in `90-magicstick-nvidia.toml`, without changing runc
   as the default. Fresh installations receive this before K3s starts.
2. Existing hosts need the runtime declaration already loaded (or one planned
   restart) before setting toolkit `RUNTIME_RESTART_MODE=none`. Sending SIGHUP
   to K3s-managed containerd exits K3s; the Toolkit must not do this every boot.
   The Toolkit still installs its binaries and persistent `99-nvidia.toml`.
   Upgrading an old Toolkit Pod can cause one final reload on its shutdown.
3. Build/publish the pinned AMD DRA recovery image, then deploy the operator,
   ModelActivation status schema and terminal-Pod delete permission together.
4. Apply the GPU host-evidence role: first check at 20 seconds, periodic checks
   every minute, and a 10-second service retry for transient API failures.
   No package installation, GPU validation or reboot is triggered by this check.
5. Verify a real reboot with AMD/NVIDIA workloads: current-boot host evidence,
   CDI claim files, no Toolkit-induced K3s restart, and actual inference replies.
   A green driver Pod alone is insufficient. Retain kernel, driver, API,
   preflight, device-registration and model-ready timestamps.

The conventional NVIDIA R595 container still installs/builds its kernel module
after boot. Do not enable precompiled mode solely from the OS support table:
first verify that an image for the exact running kernel is available. A missing
precompiled tag would turn a startup delay into a driver outage.

Use [GPU sharing](../gpu-sharing.md) for common management of optional AMD DRA and
NVIDIA device-plugin time-slicing, provider-local transitions and rollback.
New installations default to one model per GPU. Before upgrading older NVIDIA
installations, follow the [profile-preservation steps](../gpu-sharing.md#upgrading-older-nvidia-defaults)
so changing the shipped default does not change an existing inherited allocation.
NVIDIA status is in `hardwareOperators.gpu.sharing`; verify its selected
`nvidia.com/device-plugin.config` label, device-plugin readiness and advertised
slots. Its driver and ClusterPolicy are retained. In AMD DRA mode, check the actual
`ResourceSlice`/`ResourceClaim` allocation instead of expecting `amd.com/gpu` on
the node. Model slots are not additional physical GPUs or isolated VRAM quotas.
In Hardware, check both provider sections, unchanged/changed/reverted Apply states,
and the final confirmation without sharing checkboxes. AMD advanced profiles and
collapsed GPU-memory controls must stay in the AMD section.
Both provider sections start collapsed. In Models, verify the segmented slot
ring against allocatable resources (or the ready AMD shared-claim limit), enabled
ModelActivations and live GPU Pods. A full GPU stays visible but disabled in the
Hardware selector even when it has spare memory. Slot polling and the API write
check must block new starts without discarding an open form. See
[slot accounting](../gpu-sharing.md#model-slot-accounting) for pending, terminating
and multi-node workloads. No GPU validation run is required just to view slots.

Ubuntu package maintenance is under **System → Settings → Updates**. Daily security updates
default to 03:00–05:00 UTC with no automatic restart; saved policy is preserved by
host convergence. See [Ubuntu updates](../ubuntu-updates.md) for held hardware
packages, service coordination, manual actions and recovery.

Network administration is under **System → Settings → Network**, alongside
Domains, Mesh, Federated SSO, and Updates. Previous direct links to the moved
System tabs redirect into Settings; authorization and license checks remain
unchanged. Follow
[network management and recovery](../network.md) for DHCP/static IPv4,
Wi-Fi credentials, temporary application and rollback. Page loading and source
publication must never initiate a network connection change.

Use [post-install host management](../host-management.md) for reviewed GPU package
preparation and mixed-system experiments, and **System → Computer power** for
administrator-confirmed reboot/shutdown. Computer power is a separate,
administrator-only tab next to **System Status** (`#/system/power`); its controls
are not shown on other System tabs. Check the host worker's journal and
`HostOperation` phase separately from GPU operator and model readiness. Request
acceptance is not confirmation of a completed power action.

The Hardware page starts with GPU operator status. **GPU nodes → Host preparation**
is the main kernel/driver and runtime-profile setup path. **Advanced · AMD runtime
profile** is a collapsed manual override in the same section, not a second setup
requirement. Optional validation is inside each GPU node and uses the saved
profile. Info icons retain background explanations and diagnostic messages;
final disruption confirmations remain explicit.

**System → Hardware → GPU nodes → GPUs → GPU Configuration AMD → Shared GPU memory** configures supported Strix Halo
firmware reservations and dynamic TTM limits through the same host worker.
Inspect current versus requested values and retain console access before
confirming the possible two-reboot workflow. Unsupported/mixed systems and
conflicting local overrides stay blocked. An interrupted memory operation must
be diagnosed before resubmission; never delete its state to force a retry.
If the firmware reservation changed but the dynamic limit did not, inspect the
host-management journal and compare both **current** values with the draft.
The two stages can stop between restarts. The corrective draft is bounded by
actual Linux RAM minus the configured safety allowance and still requires a new
explicit confirmation. Updating the worker does not replay a terminal failed request.
See the [memory safety and recovery contract](../host-management.md#fixed-and-dynamic-gpu-memory).

KubeAI is installed only after a local model requests it. NFD is always present,
but a healthy CPU/external-only appliance has no NVIDIA, AMD, or Intel
`ModuleActivation` and no vendor operator workloads.

```bash
kubectl -n node-feature-discovery get pods
kubectl get nodes --show-labels
kubectl -n ai-system get appliance local \
  -o jsonpath='{.status.hardwareOperators}{"\n"}'
kubectl -n ai-system get moduleactivations
kubectl get nodes -o custom-columns='NODE:.metadata.name,NVIDIA:.status.allocatable.nvidia\.com/gpu,AMD:.status.allocatable.amd\.com/gpu,INTEL_I915:.status.allocatable.gpu\.intel\.com/i915,INTEL_XE:.status.allocatable.gpu\.intel\.com/xe'
kubectl -n gpu-operator get pods
kubectl -n amd-gpu-operator get pods
kubectl -n inteldeviceplugins-system get pods
kubectl -n ai get models.kubeai.org
kubectl -n ai get pods -l app.kubernetes.io/name=kubeai
```

For any local activation, inspect the resolved engine, target, profile, and
model-server logs:

```bash
kubectl -n ai-system get modelactivation qwen2505bcpu \
  -o jsonpath='{.status.engine}{" "}{.status.computeTarget}{" "}{.status.resolvedResourceProfile}{"\n"}'
kubectl -n ai get model qwen2505bcpu -o yaml
kubectl -n ai logs -l model=qwen2505bcpu --tail=200
```

If model pods fail to start, check:

- the provider phase and message in `status.hardwareOperators`
- the matching NFD detection label and vendor support; for an additional AMD
  profile, inspect explicit consent, current host evidence and per-engine
  validation instead of forcing the vendor support label
- vendor operator pods and node GPU allocatable resources
- KubeAI `Model` status
- vLLM or Ollama model pod logs
- model cache space under the host cache path

The bundled `qwen3827b` preset reserves `24062Mi` and targets a single 24
GB-class GPU. Its OpenCode output limit is 8192 tokens inside the 20000-token
vLLM context window. Paperclip uses a separate 4096-token cap and advertises a
15904-token context with a 3976-token output limit to OpenCode, retaining 4096
physical tokens as safety headroom for compaction and tool-turn overhead. If
the vLLM wrapper reports that this budget is larger than the physical GPU
memory, choose a smaller preset or create a custom activation with lower VRAM,
context, output, and concurrency values.

The portable `qwen2505bcpu` preset can also be created with `computeTarget`
`nvidia-gpu`, `amd-gpu`, or `intel-gpu`. Intel resolves to
`magicstick-intel-xe-gpu:1` or `magicstick-intel-i915-gpu:1` according to the
allocatable resource. If neither resource is present, the dashboard omits the
Intel target from the Create Model hardware dropdown and the API rejects a
forged request.
The same omission rule applies to unavailable CPU, NVIDIA, and AMD targets.

In the Dashboard, open **Models > Create Model**, choose `Local`, select the
engine, and then select one of the compute targets actually offered. A missing
target is an availability signal, not a stale disabled option: inspect the
hardware-operator state and allocatable resources above.

For vLLM, choose **Hugging Face search** to search a model name or prefix. Pick
the repository from the first full-width dropdown and then the original or
quantized artifact from the dropdown below it. The first shortcut row searches
stable model families; the second lists live Hugging Face trending models. Use
**More models** or **More quantizations** when the API reports another page.
Review the displayed publisher, format, revision,
trust, conditional download size, context, and compatibility note before
creation. The advertised model context is used as the initial **Context Size**;
reduce it when the corresponding memory estimate exceeds the selected target.
New models begin with **Max Num Seqs = 1**. Community quantizations
are discovery candidates rather than Magic Stick-tested presets. Use **Tested
preset** when a validated engine/target combination is required, or **Direct
Hugging Face URL** when the repository is already known.

For Ollama, choose **Ollama Library** to search a model-name prefix, use the
stable family shortcuts, or start from the live popular row. Select the model
and then its tag/quantization in the dropdown below. The dashboard copies the
tag's advertised download size and context into the form, starts with one
parallel sequence, and excludes cloud-only tags. Once selected, the registry
manifest refines the size and, where declared, quantization used by the memory
estimate. **Tested preset** and **Direct Ollama model reference** remain
available if public discovery is unavailable. This does not import arbitrary
Hugging Face GGUF artifacts into Ollama.

For accelerator models, 100 percent on the VRAM slider is the unreserved memory
(`total memory - active model reservations`), not the separate live free-memory
value. Gray minimum or recommended markers to the right of that limit mean the
model does not fit at that estimate; reduce model size, context, or concurrency
rather than treating the gray area as allocatable capacity.

After choosing a preset, use **Precision / Quantization** to select one of the
artifacts allowed for that exact engine and compute target. The selection
changes the checkpoint or Ollama tag and recalculates the memory plan; Magic
Stick does not quantize a full-precision checkpoint while the model starts.
For example, a Q4 Ollama artifact is a pinned GGUF registry tag, while a vLLM
AWQ, GPTQ, or FP8 entry points at a separately published Hugging Face artifact.
The selected artifact ID is stored in `spec.local.artifact` and appears in the
installed-model card and `ModelActivation.status`.

Do not copy artifact IDs between hardware targets. The operator checks the
artifact against the selected preset variant and rejects unknown combinations.
FP8 entries additionally require a GPU generation and runtime with FP8 support;
the presence of a vendor device alone does not prove this capability. If an FP8
model fails during loading, select the target's BF16 or supported integer
artifact, or use hardware with the required FP8 support.

For accelerator-backed vLLM models, the wrapper converts the selected MiB value
directly into `selected / physical GPU memory`. It does not impose a hidden
five-percent minimum; only the 98-percent upper safety cap remains. A very small
reservation can therefore still fail during model loading when weights,
activations, and the minimum KV cache do not fit, but it is never increased
silently.

For every supported local engine/target pair, the form calculates minimum and
recommended memory before creation. vLLM supports CPU, NVIDIA, AMD, and Intel;
Ollama supports CPU, NVIDIA, and AMD. The CPU RAM slider and accelerator VRAM
slider both end at the target's unreserved memory. Values beyond that capacity
appear as minimum/recommended markers in the gray overflow area; a manually
entered numeric budget may exceed capacity after the creation warning.
Displayed requirements and selections use 100 MiB planning increments. Values
round upward; the safe slider ceiling rounds downward. The React dashboard breakdown separates weights, theoretical
or estimated KV cache, hybrid-allocator safety, compile/warm-up headroom,
multimodal processor cache, quantization working copy, generic engine reserve,
and recommendation headroom. Download size is shown as storage/network context
and is not added to the memory requirement. For Ollama, exact model-layer bytes
come from the registry manifest and cache dimensions come from a bounded range
of the GGUF header. Hybrid models show attention KV and recurrent state
separately. If a registry proxy blocks ranged blob reads, the API reports and
uses the conservative manifest-only fallback.

Use the **info (i)** buttons on memory values to inspect the API's formula and
current substituted numbers. Check context tokens, maximum sequences, KV precision
and full-attention layers before comparing cache estimates. Runtime/headroom
formulas are planning heuristics, not engine measurements. Missing calculation
metadata is displayed as unavailable; 100 MiB reservation rounding is separate
from compact GiB display formatting.

The **KV Cache** selector is independent of model-weight quantization. Ollama
F16, Q8_0, and Q4_0 use approximately full, half, and quarter attention-cache
memory; exact block-scale overhead is included. vLLM FP8 halves the assumed
16-bit attention-cache storage and is offered only for CUDA/NVIDIA or ROCm/AMD.
Recurrent state, hybrid allocator padding, and runtime reserve are not silently
scaled with the attention cache.

The warning-styled **Add Local Model** remains usable for uncertain or
insufficient memory. Clicking it records `spec.local.allowMemoryRisk: true`;
equivalent API/CLI JSON can supply the same boolean explicitly. This skips only
memory-estimate/capacity preflight guards, including CPU vLLM and offloading host
coverage. Required positive values, supported targets, offloading metadata and
single-replica constraints still apply. Requests/limits and derived cache budgets
are not reduced or removed. Inspect Pod events and previous logs after such a
trial: Pending, OOMKilled and CrashLoopBackOff remain possible. A warning is not
a promise that the runtime can load the model.

For a CPU target, the selected value becomes the model pod's Kubernetes memory
request in 16 MiB units. Check the requested value after creation:

```bash
kubectl -n ai get pods -l app.kubernetes.io/name=kubeai \
  -o custom-columns='POD:.metadata.name,MEMORY-REQUEST:.spec.containers[*].resources.requests.memory'
```

If the reservation exceeds memory schedulable on any eligible node, Kubernetes
keeps the model pod Pending. Reduce the reservation or make capacity available;
do not remove the request because it protects other appliance workloads from an
unbounded inference process.

With `engine: OLlama`, portable presets use explicit registry tags such as
`ollama://qwen3.5:9b-q4_K_M`; CPU, NVIDIA, and AMD are supported. Intel remains
unavailable for Ollama until a validated image/profile is added. The server
images are pinned to the same upstream Ollama release for standard and ROCm
runtimes. Ollama model blobs persist below `/root/.ollama` on the appliance
host, so a model-pod restart does not normally download the complete model
again.
