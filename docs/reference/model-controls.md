# Model configuration and API

## Model Controls

**Create → Location: Local → Inference Engine: (Experimental) vLLM-Omni** opens a separate form for
the catalog's experimental Omni profiles for NVIDIA CUDA, AMD ROCm, Intel XPU
and CPU. GPU choices use schedulable Kubernetes resources, not chip/driver or
Strix-Halo allowlists. Shared mode uses one slot; exclusive mode offers the
one-/two-GPU stage plans. CPU does not request a GPU. A matching runtime image
is still required; CPU/XPU need an explicit image in **Advanced Settings**.
The same section contains context, concurrency, memory and optional image
overrides. RAM estimates are advisory; actual node capacity and slot checks stay.
**Model source** offers HF search and direct repository paths. Quantization,
architecture, stage completeness and `config.json` are not pre-approved.
Any valid HF reference can be tried without an online configuration check;
the runtime reports actual load failures in Status/Logs. Selection is not a
hardware/model support guarantee. The selected repository is saved in
`local.url` and retained on edit.
Location distinguishes only Local and External; vLLM-Omni is offered
alongside the other local engines when the catalog advertises a Realtime profile.
It still persists as `engine: VLLM` with `local.realtime`, not a new backend engine
type. It does not inherit the normal model form's vLLM/Ollama/FreeToken
knobs. Installed Realtime models reuse Edit, Logs, Start/Stop, Restart and
Remove. Speech testing uses LiteLLM's existing Realtime Playground, not a new
dashboard conversation UI. See [Realtime](realtime.md), including the pinned
development-runtime and hardware acceptance boundaries.

Local model creation and editing include one collapsed **Advanced** section.
Its CPU subsection is independent of memory controls. Blank fields use the
engine defaults advertised by the compute-target catalog. Users can set a CPU
reservation and optional limit in logical cores; limit `0` removes the CPU
quota. **Use automatic CPU settings** removes stored overrides. Saving only CPU
changes preserves RAM/VRAM and model identity, and may restart the model Pod.
See the [CPU scheduling policy](compute-targets.md#cpu-scheduling-policy) for
defaults.
An unschedulable model shows Kubernetes' actual scheduling reason (for example,
`Insufficient cpu`) instead of only waiting for a ready replica.

For **vLLM on AMD**, the Deployment subsection of **Advanced** exposes the
**Vision attention backend**. It defaults to **vLLM Triton attention** for new
AMD models; Automatic (vLLM default), PyTorch SDPA + AOTriton, and
FlashAttention (AMD Triton) remain selectable. The compute-target catalog owns
the options and eligible targets. Info icons explain runtime dependencies;
selecting an option is not a successful hardware/model test. Editing saves
only the changed selection and may restart the runtime. Switching engine or
hardware in Create clears the AMD-specific draft. This setting does not change
the memory reservation, context, KV precision, or text decoder backend. See
[vision attention deployment](compute-targets.md#vllm-vision-attention-deployment)
for mappings and the distinction between an omitted setting and explicit Auto.

Local and external models are runtime requests stored as `ModelActivation`
resources in namespace `ai-system`.

The **Create** button beside **Installed Models** opens the model form directly
in that section. The form starts with a persistent location dropdown containing
`Local` and `External`. The external choice reveals the existing provider form.
For a local model, inference engine and hardware appear as additional dropdowns
above the model form. Every completed selection remains visible and can be
changed directly; there are no wizard steps or back buttons. Engine and hardware
choices are filtered by current cluster capability. Unavailable CPU or
accelerator targets are omitted instead of being presented as disabled choices.
The engine dropdown sorts regular engines alphabetically first (**Ollama**,
**vLLM**), followed by **(Experimental) FreeToken** and
**(Experimental) vLLM-Omni**, also alphabetically. The first offered engine is the
default for a new form. These are display labels only; catalog availability and
persisted engine identifiers are unchanged.

For vLLM, **Model source** offers three persistent choices:

- **Hugging Face search** accepts a model name or prefix and provides normal
  full-width dropdowns, one below the other, for the matching model and its
  original or quantized artifacts. A stable model-family row provides Qwen,
  DeepSeek, GLM, Llama, and Gemma searches, while a second row comes from
  Hugging Face's live `trendingScore` order. Additional result pages can be
  loaded without losing the current selection.
- **Tested preset** retains the allowlisted catalog flow and its **Precision /
  Quantization** dropdown.
- **Direct Hugging Face URL** retains the existing `hf://` escape hatch.

The discovery backend returns only public, non-gated, non-disabled repositories.
Quantizations must declare a direct `quantized` relationship to the exact
selected model; name similarity, adapter, fine-tune, and merge relationships do
not qualify. Publisher, formats, parameter metadata, revision, trust
classification, and runtime-compatibility guidance remain visible after
selection. When Hugging Face publishes `usedStorage`, the dashboard also shows
the repository download size. The artifact resolver and estimator read the
selected repository's public `config.json`, including nested language-model
configuration such as `text_config`; this is necessary because Hugging Face
search and detail payloads can omit the advertised context limit. When the
configuration advertises a maximum context, that value becomes the initial
**Context Size** while remaining editable. If a quantization repository does
not publish its own context metadata, discovery inherits the directly related
base model's value and labels it accordingly. A new dynamic model starts
with **Max Num Seqs = 1**. A dynamic result is labelled experimental until the
chosen runtime has loaded it; the dashboard does not claim that arbitrary
community artifacts are validated. Selecting an artifact writes its `hf://`
repository to a custom activation and reuses the same server-side memory
estimator as a direct URL.
GGUF and MLX repositories are excluded from the current vLLM selection because
that path cannot select the required GGUF file/plugin and does not run MLX.

For Ollama, **Model source** offers three persistent choices:

- **Ollama Library** provides stable Qwen, DeepSeek, GLM, Llama, Gemma, and
  Mistral family shortcuts, a live popular-model row, prefix search, and two
  full-width dropdowns for model and tag/quantization.
- **Tested preset** retains the validated catalog variants.
- **Direct Ollama model reference** retains the `ollama://model:tag` escape hatch.

The tag selection displays the download size and advertised context from the
public Ollama tag page and starts with **Max Num Seqs = 1**. After selection, the
registry manifest supplies exact model-layer bytes and the estimator reads only
a bounded GGUF-header range for architecture dimensions. It can also refine the
quantization from source metadata. Cloud-only tags are not
offered. The public Ollama Library is an HTML interface rather than a documented
catalog API, so the backend uses a bounded, cached adapter and leaves presets and
direct references available when discovery fails. Hugging Face discovery remains
separate because the current runtime contract pulls `ollama://` registry models
and cannot import an arbitrary Hugging Face GGUF repository automatically.

For **FreeToken**, the model source is a capability-approved `hf://` Hugging
Face safetensors or FTW checkpoint. The form does not treat a broad Hugging Face
search result as a compatibility promise: it shows only the documented
FreeToken-family policy returned by the server, and the API repeats that check
before it accepts a write. FreeToken `v0.1.3` is shown only for its supported
Linux `amd64` NVIDIA path. AMD/ROCm, Intel, CPU, a GPU slice, an unavailable
device, and a node whose standard FreeToken adapter cannot receive one whole
GPU are not selectable; the GPU choice explains the non-sensitive reason.

The FreeToken form replaces the vLLM/Ollama memory controls with **GPU**,
**VRAM**, **System RAM**, and **Memory Strategy**. It exposes one
capability-approved whole GPU per runtime. The VRAM slider is bounded by the
selected device's physical/currently usable memory and stores a planned budget.
NVIDIA DCGM samples retain their node association with either the current
`hostname` label or the legacy `Hostname` label, so FreeToken uses the same
measured VRAM shown in the device gauge.
When editing an active FreeToken model on the same node and GPU count, its own
reservation is reusable by the replacement Pod. The form labels this as
**available on restart**, keeps the existing limits unchanged, and does not add
the old allocation to live free memory. Physical capacity and other models'
reservations still bound the replacement. New or stopped models cannot borrow
an active model's allocation.
At startup the runtime converts that budget to FreeToken's documented fraction
of *current free* VRAM. A race or another workload can therefore still make a
previously valid budget fail clearly at start rather than silently growing it.
The System RAM value is the Pod's Kubernetes reservation and limit, not an
invented FreeToken host-RAM flag. It is bound to a fresh available-RAM reading
from the selected GPU node; it is intentionally unavailable rather than
falling back to a cluster-wide CPU aggregate when that reading is absent.
**Auto** is the default strategy; the only
additional choices are the documented FreeToken `fused`, `offload`, `cpu`, and
`hybrid` strategies. **Advanced Settings** is collapsed initially and contains
only documented options such as cache mode, cache/graph sizing, CPU workers,
expert loading, and dtype.

vLLM and FreeToken accept `hf://` model references; Ollama uses `ollama://`
references.
`cpu` is available on a compatible Ready Linux node. `nvidia-gpu`, `amd-gpu`,
and `intel-gpu` are shown only when the matching provider is `Ready` and
Kubernetes reports its allocatable resource. Intel automatically resolves
`gpu.intel.com/xe` or `gpu.intel.com/i915`. vLLM supports all four targets.
Ollama supports CPU, NVIDIA, and AMD; Intel is absent from the Ollama choices
because no validated KubeAI/Ollama Intel profile is bundled. FreeToken supports
only its capability-approved NVIDIA option and never falls back to another
engine or hardware target.

For an experimental AMD profile, the selected engine needs current host evidence
and an adopted runtime configuration; GPU validation remains optional. Upstream provider readiness and an allocatable
resource alone do not satisfy that additional gate.

Beside **Context Size**, the local form shows a **KV Cache** dropdown. Ollama
offers F16, Q8, and Q4. vLLM offers model precision on every target and FP8 only
for CUDA/NVIDIA and ROCm/AMD. The options come from the selected compute
target's live API contract, so CPU and Intel never show an unsupported FP8
choice. Changing the cache format immediately reruns both the normal memory
estimate and, when selected, the CPU-offloading estimate.

An Ollama pod is not sufficient by itself for a Ready model. KubeAI addresses
the runtime with the `ModelActivation` name, while the downloaded registry tag
can have a different name. The Magic Stick Operator therefore waits for the
source download and verifies or repairs that runtime alias before the model is
published to LiteLLM. During this phase the installed-model status remains
`Starting` instead of exposing a route that would return `404 model not found`.

The dashboard calls `POST /api/models/estimate-memory` for every supported
vLLM/Ollama local combination: vLLM on CPU, NVIDIA, AMD, and Intel, plus Ollama
on CPU, NVIDIA, and AMD. vLLM estimates use public HuggingFace weight and model-configuration
metadata. Ollama estimates use the exact runtime-layer byte total from the
public registry manifest and attention, recurrent-state, GQA, hybrid-layer, and
context dimensions from the GGUF header. Only the first bounded header range is
requested; model tensors are not downloaded by the estimator. If a registry
proxy cannot serve that range, the API retains the conservative manifest-only
calculation and reports that fallback explicitly.

FreeToken does not reuse that vLLM/Ollama estimator because its documented
`--memory-ratio` spans weights, MoE cache, and KV cache together. Its form uses
the selected GPU's live capacity plus the requested FreeToken budget and marks
the result as a runtime allocation plan, not an engine-independent fit proof.
The API rejects impossible values and lets the runtime make a second check
against the live device immediately before `ft serve` starts.

Both the RAM and VRAM controls use unreserved memory (`total memory - active
model reservations`) as their 100-percent slider maximum. The separate live
free-memory value does not change that planning limit. Minimum and recommended
values are marked on the same scale. If either estimate exceeds unreserved
capacity, its marker remains visible in a gray overflow section to the right of
the slider. The slider stays bounded; the numeric field also accepts larger
budgets, with an explicit memory-risk warning before creation.
The React dashboard's collapsible **Breakdown** separates model weights, the base KV-cache
estimate, recurrent state where applicable, hybrid-allocator safety, engine
runtime components, recommendation headroom, and download size. For vLLM hybrid models, the UI labels the
architecture-derived KV value as **Theoretical KV cache** and shows the extra
compatibility budget independently instead of presenting their sum as physical
cache use. Ollama hybrid models show attention KV and their context-independent
recurrent state separately. CPU vLLM runtime reserve is split into compile/warm-up headroom, the
multimodal processor cache, and a quantization working copy when applicable.
Download size is storage/network information and is explicitly not included in
the memory total. Every displayed recommendation and selectable reservation is
rounded upward to a 100 MiB planning step. The safe slider maximum is rounded
down to the same step. Each summary/Breakdown value has an **info (i)** button:
hover or focus previews its explanation; click/Enter pins it, and Escape,
the close button, or an outside click dismisses it. Overlays show the formula,
substituted current inputs, binary units and rounding. Cache explanations include
bytes per token per sequence and assumed KV precision, independent of weight
quantization. Quantized-cache overlays also show the exact format storage rule,
the F16/native-16-bit baseline, and the resulting saving. Ollama Q8_0 uses
34 bytes per 32-value block and Q4_0 uses 18 bytes per block, including their
two-byte scales; only attention cache changes. Runtime allowances and fallback heuristics are labelled as estimates,
not measurements. The API supplies additive `calculations` entries containing
`formula`, `substitution`, and `notes`; an older API shows an honest unavailable
message instead of invented dimensions.

For CPU targets, the selected value is stored as
`spec.local.memoryRequiredMi`. The operator rounds it up to a 16 MiB unit and
turns it into the model pod's Kubernetes `requests.memory`. For accelerator
targets, the selected VRAM remains scheduling/planning metadata; old Ollama
models without an explicit offloading policy retain their automatic fit.
Live memory metrics currently come
from NVIDIA DCGM, so AMD and Intel estimates can show minimum, recommendation,
and breakdown without an adjustable maximum until matching memory metrics are
available.
For CPU vLLM, the dashboard API derives `spec.local.kvCacheMemoryBytes`
server-side from public model architecture metadata, context size, and maximum
parallel sequences. The browser cannot supply an arbitrary runtime value. The
operator passes that value to vLLM as `--kv-cache-memory-bytes`; 512 MiB remains
only as a compatibility fallback for older or directly created resources that
do not contain the derived field.

The installed-model card distinguishes **KV requested** from **KV active**.
The second value remains pending until the operator observes a Ready replica
created with the requested vLLM argument or Ollama environment. This confirms
the applied pod configuration rather than claiming a separate engine-memory
measurement; a runtime that rejects the mode never receives a misleading
active label.

For NVIDIA GPU models, **CPU offloading → Use additional system RAM** is an
opt-in setting below the VRAM control. Keep VRAM and host RAM separate: the new
**Host RAM reservation** slider/number field includes offloaded weights and
host runtime, while **Use recommended RAM allocation** adjusts only host RAM.
Budgets use 100 MiB steps. The host ceiling is the largest eligible node's
allocatable RAM after workload requests, with pending requests deducted
conservatively; it is not the cluster-wide CPU gauge. Unknown capacity,
uncertain estimates, or inadequate budgets show a warning, not a disabled
**Add Local Model** button. Clicking the warning-styled button accepts the
memory risk and stores `spec.local.allowMemoryRisk: true`. The API/controller
then allow estimated under-reservation and unverifiable/oversubscribed capacity
without raising the selected budgets or removing requests/limits. Pods may remain
Pending, fail to load, or OOM/restart. Invalid inputs, unsupported hardware/engine
combinations, missing metadata needed to derive an offloading plan and replica
restrictions are still errors. Manual RAM choices survive recalculation, and changing engine or
hardware resets opt-in so a previous policy cannot silently carry over.

The expanded breakdown separates estimated GPU/RAM weights and KV placement,
host/GPU runtime, and headroom. vLLM offloads weights, not KV; Ollama always uses
GPU-first auto-fit and chooses the exact maximum layer placement when loading.
The proportional preflight split is not a VRAM hard limit. The installed
model card shows the host reservation separately and displays Ollama's `/api/ps`
RAM/VRAM buffer reports when available. Missing measurements remain explicitly
unknown, never zero. These reports are not process RSS or the Kubernetes
reservation. See [CPU offloading behavior and limits](compute-targets.md#explicit-cpu-offloading-for-nvidia-models).

The estimator prefers exact public Safetensors file sizes, checks the requested
context against the model's advertised maximum, and adds a CPU-specific
start-up envelope for working tensors, compilation/warm-up, and the default
multimodal processor cache. Hybrid attention models are labelled **Estimated**
and receive a conservative cache compatibility factor because current vLLM
hybrid cache grouping can allocate more memory than the pure full-attention
formula suggests. The shared API returns both values as
`theoreticalKvCacheMi` and `hybridAllocatorSafetyMi`; runtime components are
returned in `runtimeDetails`, while `recommendedReserveMi` is the separate
recommendation headroom. CPU reservations below the computed minimum require
the explicit memory-risk acceptance described above. API/CLI clients that omit
`local.allowMemoryRisk` retain the stricter preflight checks.

Accelerator availability uses the Ready, schedulable node's allocatable vendor
resource as the final runtime signal. An enabled vendor operator that is
temporarily reported as `Reconciling` by Flux therefore does not hide NVIDIA,
AMD, or Intel once Kubernetes already publishes the matching GPU resource. If
the resource is still absent, the operator phase remains the blocking reason.

Above the installed-model list, the Models screen renders only a small
**Compute memory** heading and one semicircular gauge per compute device. Ordinary
CPU/discrete-GPU gauges have two rings: violet for unreserved memory
(`total - active model reservations`), cyan for current availability. The full
arc represents that reading's capacity. On unified-memory CPUs both rings
use Linux-visible RAM; the unreserved value excludes system headroom. The
center shows current availability, or the unreserved budget if live metrics are
missing. A small legend and an info symbol replace inline explanation paragraphs.
CPU totals are aggregated across Ready,
schedulable appliance nodes, reservations come from active CPU models and
GPU models with explicit CPU offloading via `ModelActivation.status.memoryRequiredMi`
(falling back to the requested value), and current availability
comes from fresh host `/proc/meminfo` `MemAvailable` samples when available.
Ordinary nodes retain the Kubelet summary/metrics API fallback. Unified-memory
nodes never use that fallback: driver-owned GPU allocations can be absent from
Kubelet working-set accounting, overstating both CPU and shared GPU availability.

NVIDIA gauges use one DCGM record per physical GPU. Kubernetes exposes the
whole-GPU request but not the chosen GPU UUID on the `ModelActivation`, so the
dashboard packs planned `vramRequiredMi` reservations deterministically across
the detected devices; the actually-free inner ring always comes directly from
DCGM. AMD and Intel device-plugin resources are also listed individually. Until their installed
operator supplies a compatible memory exporter, unavailable readings use a
dashed ring and `—`, not an invented zero, total, percentage, or free value.
This preserves an honest UI while keeping the response contract
ready for additional vendor metric adapters.

An explicitly configured unified-memory AMD profile shows one GPU, not separate
fixed/shared GPUs. Fresh, PCI-matched KFD evidence determines the ordinary
allocation domain and GPU planning capacity. GTT/TTM bounds alone do not prove
model capacity. Fixed GPU allocations are outside Linux RAM; only their host
runtime requests count there. Dynamic GPU allocations consume Linux RAM and
intersect its remaining budgets after safety headroom. Missing metrics and
unverified GPU cgroup accounting remain explicit.

GPU gauges add an outer segmented **model-slot** ring (gold: free, grey: occupied)
and exact free/total counts, independently of memory. Fully occupied GPUs remain
visible but disabled in the Hardware selector, with a `no free slots` hint.
The model form refreshes every 15 seconds; if its selected GPU becomes full,
submission is disabled without clearing the form or switching hardware.
The API also checks current slots before writing a local model; accepting a
memory-estimate risk does not bypass slot exhaustion. CPU models are unchanged.
See [slot accounting](../administration/gpu-sharing.md#model-slot-accounting) for counting rules.

On unified-memory hosts, **Models → Compute Memory** keeps one GPU gauge with
four memory rings inside the slot ring: dedicated unreserved (violet), dedicated
free (cyan), shared unreserved (blue), shared free (green). The compact legend
groups each pair under its own capacity. These are separate scales, not an
additive model budget or two deployment targets.

Dedicated free uses PCI-matched AMD `mem_info_vram_total - mem_info_vram_used`;
dedicated unreserved is attributed only to a confirmed firmware-reserved model
allocation domain. Without live metrics, the free ring stays unknown and the
center falls back to the applicable **unreserved** budget. Shared free is
`max(0, min(Linux MemAvailable, dynamic GPU ceiling - mem_info_gtt_used))`.
Linux availability already reflects those GPU allocations; they are not
subtracted from `MemAvailable` a second time. This is remaining reported
capacity, not a guarantee that any individual allocation will fit.
For example, 38.2 GiB Linux availability, a 108 GiB shared ceiling and 78.7 GiB
reported GTT usage yield `min(38.2, 108 - 78.7) = 29.3 GiB` shared free.
A separate 95 GiB reservation leaves a 13 GiB GPU planning budget; it does not
change that measured free value. Calculations use bytes before conversion to
MiB; compact gauge labels round GiB for display.
Shared unreserved is limited by remaining Linux budgets after system headroom
and model requests; when the confirmed model domain is shared/GTT, remaining
GPU reservations also constrain it. Missing pool metrics, unknown domains and
non-matching pool IDs are not replaced with another node's values. The dynamic
ceiling is part of Linux-visible RAM, not an additional bank or protected reserve.
A confirmed shared/GTT domain remains valid when its Linux-capped capacity is
smaller than the fixed firmware reservation; that comparison alone must not
erase the unreserved budget. The host corroborates the domain using raw KFD/GTT
evidence before applying capacity bounds.
The lightweight host sampler refreshes every 30 seconds. The API requires a
sample no older than 90 seconds matching the Node UID, boot ID and kernel;
missing, invalid or stale counters stay unknown, never zero usage. Current
sample time and the formula are available through the info symbol.

Hovering or focusing the info symbol previews the explanation. Clicking/tapping
pins it open; Escape, the close button or an outside click dismisses it. The
popup includes installed RAM, fixed GPU reservation, Linux-visible RAM, dynamic
ceiling, driver capacity, data sources and accounting caveats. The full inventory
remains in **System → Hardware → GPU nodes**; it is not a separate card on Models.
Unknown driver capacity remains unknown. Only separately confirmed hardware controls change memory
settings. See the [inventory contract](gpu-compatibility.md#kernel-and-shared-memory-constraints).
CLI hardware output and the physical TUI's Models/Hardware views expose the same
values and the same non-additive relationship. The dynamic ceiling and
Kubernetes requests are not protected reservations against other processes;
the UI does not promise guaranteed dynamic AI capacity.

The preset selector is populated from `ConfigMap/magicstick-model-presets` and
shows only variants compatible with the selected engine and target. Each
variant may declare `defaultArtifact` and `artifacts[]`; the artifact entries
carry their own checkpoint/tag, precision, quantization method, and planning
budget. The selected ID is stored in `spec.local.artifact` and displayed on the
installed-model card. Existing resources without that field continue to use the
variant default. For catalog presets, the URL is derived from the artifact and
remains read-only; selecting `Custom` is the explicit path for a user-supplied
URL. An artifact `compatibilityNote`, for example an FP8 hardware requirement,
is shown directly below the dropdown. Such a note is a warning rather than a
replacement for accelerator-generation acceptance testing.
`qwen2505bcpu` remains the portable smoke preset. The expanded Qwen3.5,
Qwen3.6, and Qwen3.8 catalog uses official Hugging Face checkpoints plus
target-specific FP8/GPTQ/AWQ artifacts where the runtime supports them, and
explicit Q4_K_M/Q8_0/BF16 Ollama tags on CPU, NVIDIA, and AMD. Qwen3.5 4B fills the useful
capacity gap between the 2B and 9B presets. `qwen3827b` retains its validated
single-NVIDIA-GPU AWQ default and adds official FP8 and BF16 alternatives.
Selecting a preset and artifact fills its target-specific context, output-token,
concurrency, memory, and runtime values before the activation is submitted. The
model catalog propagates consumer limits into managed KubeOpenCode templates.

The default dashboard is GPU-neutral. External models do not require or activate
GPU or KubeAI modules. CPU model creation remains available without any GPU
driver and lets the operator install KubeAI on demand. An unavailable target is
disabled with a concrete reason. The API enforces the same live availability
check and engine/target compatibility matrix and returns HTTP `409` if a client
attempts to bypass the UI. It resolves the engine-specific resource profile
server-side instead of accepting arbitrary args, environment values, or profile
names from the browser.

The Models screen treats unavailable device metrics as a neutral, per-device
state. Runtime removal remains outside the memory display and is exposed only
when no local model still depends on the automatically enabled runtime.

The **System → System Status** screen renders all three GPU providers even on a CPU-only
appliance. Each card shows the pinned operator version, driver mode, detected
and compatible nodes, management owner, allocatable resource count, phase, and
the controller's non-sensitive explanation. `NotRequired` means no matching
hardware was found and the vendor operator consumes no cluster resources;
`Installing` lasts until the vendor resource becomes allocatable.

The Services screen uses this hardware lifecycle rather than the Flux revision
of the operator module. For NVIDIA it keeps the service in `Installing` after
the extended resource appears until the DCGM exporter can provide GPU telemetry.
This prevents a successfully applied chart from being presented as an
operational GPU before the Models screen can observe the device.

Catalog-only models are read-only in the Models screen. Remove actions are shown
only for `ModelActivation` rows that the dashboard can delete.

Operators and administrators can **Stop** and **Start** every managed model from
its installed-model card. This uses the existing `spec.enabled` flag for Ollama,
vLLM, FreeToken, and external providers, preserving the activation and all saved
settings. Local runtimes are removed on Stop; their resources become available
as the Pods and allocations are released. Start recreates the runtime with its
saved settings through the normal readiness and scheduling checks. For external
providers, Stop only withdraws the Magic Stick route; it does not shut down the
remote service. FreeToken also retains its existing **Restart** action.
The button follows the desired enabled state, prevents duplicate requests, and
waits for runtime removal before allowing Start. Writes carry the current
configuration revision; errors remain visible without removing the model card.
See [stopping and resuming models](../administration/troubleshooting/models.md#stop-and-resume-models), including
the temporary FreeToken cache behavior.

Operators can open **Edit** on every managed installed model. Local edits keep
the model reference, inference engine, hardware target, name, and namespace
fixed while exposing the applicable engine settings: context/output limits,
sequence concurrency, KV-cache/memory/offloading controls for vLLM/Ollama, or
FreeToken's GPU budget, Kubernetes system-RAM reservation, strategy, and
advanced settings. The memory estimate is recalculated against capacity with the
model's own existing reservation removed, so an unchanged deployment is not
counted twice. External edits cover provider parameters and can replace an API
key; leaving the key blank preserves the existing Secret. **Save changes**
remains disabled until a parameter differs. Saving reconciles the activation and
can restart its runtime. The object identity and configuration generation
captured when the dialog opens prevent an older form from overwriting a
concurrent change or a recreated model. Status-only updates do not invalidate
the form. Writes still use an atomic Kubernetes resource-version precondition;
one status-only race can be retried without accepting a concurrent spec edit.

Administrators can open **Logs** on each local installed-model card. The dialog
refreshes a bounded tail from every declared runtime and init container and also
shows the previous container run after a restart. It remains useful while a
model is starting; if KubeAI or the FreeToken adapter has not created a Pod, or
Kubernetes has no output yet, the dialog says so without turning that expected
state into a dashboard failure. External providers have no local Pod and
therefore no Logs button.
Because model input and provider output can be sensitive, this API and control
are restricted to `magicstick-admin`. The backend accepts only a
`ModelActivation` name, validates the target namespace, uses KubeAI model labels
plus its controller owner reference, strips terminal control sequences, and
never accepts a browser-supplied namespace, Pod, or container name.

A local model first shows `WaitingForPod` while no model Pod exists. After two
minutes without a Pod it becomes `Degraded` with reason `ModelPodCreationStalled`,
and a hint to inspect KubeAI/controller admission errors. Retries continue;
the status recovers automatically when a Pod appears. This timeout does not
apply to downloads or engine startup in an existing Pod.
An owned Pod that has permanently failed is automatically replaced with bounded
backoff. Its original failure appears in the model message; after five failed
recovery attempts the model stays Degraded until its configuration is reviewed.
A local model with a Pod is shown as `Starting` until KubeAI reports a ready vLLM or Ollama replica.
The status message includes the ready-replica count, for example `0/1 replicas
ready`. `Ready` therefore means both that the local runtime is serving its
health endpoint and that the generated catalog has published the model.
