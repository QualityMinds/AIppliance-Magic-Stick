# Model catalog integration

The ordinary vLLM startup wrapper fails closed if argument qualification raises
an exception; Python's normal `sitecustomize` exception handling must never let
the original unchecked invocation proceed. CPU defaults respect the actual
container quota as described in [CPU scheduling](../reference/compute-targets.md#cpu-scheduling-policy).
Bounded startup/NCCL diagnostics stay private to the model Pod; see
[troubleshooting](../administration/troubleshooting/models.md#multi-gpu-communication-or-host-memory-failures).

## Shared local-model configuration

The web client uses `LocalModelConfigurationForm` for Create and Edit of Ollama,
vLLM and Omni. `packages/contracts` defines a discriminated local-model draft;
`packages/core/local-model-configuration` loads saved intent and serializes
engine-specific create/update payloads. Shared source and memory components
contain no independent submit paths. Engine changes remount the draft while
preserving the name; asynchronous discovery and estimates discard outdated
responses. Editing retains the opening snapshot and revision across polling.

`ModelNameField` and the shared core's `modelNameError` validate local and external
creation before a request: a unique, 1–63-character DNS label with lowercase
letters, numbers and hyphens. The API validates the same syntax and maximum
length independently. Saved names remain immutable in Edit. Cover this boundary
with DISC-01 component, contract and desktop/mobile browser variants.

The existing compute-target catalog's `configuration` metadata declares source,
discovery, memory and task modes plus output-limit availability. Realtime
profiles override this policy; older installed catalogs retain the established
behavior through the shared compatibility resolver. KV options, GPU strategies,
CPU defaults and target availability continue to use their existing
catalog/API contracts.

Omni persists `engine: VLLM` plus `local.realtime` and retains its direct runtime
adapter. Common context/concurrency and CPU scheduling settings already reach
the stage plan/Pod. Ordinary KV cache, vision overrides, tensor/pipeline knobs
and MiB budgets remain rejected: enabling them requires a separately verified
stage mapping against the pinned Omni revision, not copying a UI field.
Memory estimates and exact NVIDIA-card DRA remain ordinary-model paths; Omni
uses its existing node/count placement and advisory stage-fraction/RAM plan.

Cover changes with `LocalModelConfigurationCore.test.ts`, existing model
discovery/edit/GPU/offload suites and `RealtimeModelForm.test.tsx`. The Phase 2
browser profile covers ordinary Create/Edit and engine changes; RT-01 covers
Omni Create/Edit, CPU resets and reload at desktop/mobile widths. Its installed
workflow creates Omni through the actual form with an exact request fence,
records acknowledged ownership, then checks independent Pod/catalog/inference
evidence. Fixture success is not physical acceptance.

## GitOps Patterns

Render the base:

```bash
kubectl kustomize magic-cluster/apps/ai/model-catalog
```

Advanced deployments or runtime operators commonly set:

- `AI_APPLIANCE_DEFAULT_CHAT_MODEL`
- `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL`
- `ConfigMap/ai-external-models`
- local and external `ModelActivation` resources

The public repository must keep `ai-external-models` empty and must not commit
real API keys. Store provider keys in Kubernetes Secrets created by a private
overlay, secret manager, or runtime bootstrap process.

For ordinary NVIDIA DRA groups, `local.vram`/`local.vramMi` and memory estimates
remain **per device**. The split-model Create/Edit control displays group totals:
multiply per-card estimates and the smallest selected card's rounded unreserved
maximum by the GPU count, and divide numeric/slider input by that count before
saving. The Breakdown uses the same group totals and exposes exact MiB arithmetic
in its explanations, rather than mixing per-card components with total estimates.
All exact cards are selected in one checkbox list; count follows that selection,
without a primary-card dropdown or automatic count. Missing saved identities stay
visible until explicitly removed. Preserve individual-card validation and
existing saved definitions.

The estimator keeps checkpoint size separate from engine/rank planning.
vLLM GPU KV uses local TP heads (at least one head per rank; MLA remains
replicated) or local PP layers, plus separately itemized recurrent and QSA
side-cache envelopes. Ollama uses a whole-layer placement estimate with one
extra cache layer over the average as uneven-placement allowance. Runtime
reserve is based on local shard bytes; the separate 10% partition allowance
does not inflate the displayed weight count. GPU totals are Estimated, not
high-confidence runtime measurements.

The additive API `systemMemory` object contains per-Pod/per-copy serving,
startup lower/upper and recommended MiB values, worker count, CPU weights/cache,
transfer buffers, reclaimable file cache and formula notes. vLLM uses public
checkpoint shard sizes for its transfer envelope when available; Ollama
distinguishes mmap/streaming buffers from the whole GGUF file-cache envelope.
Missing weights stay unknown. NVIDIA capacity is bound to the selected/eligible
node; other uncorroborated host capacities remain unknown rather than borrowing
the NVIDIA or cluster-wide budget. The ordinary single-GPU non-offloading
resource-profile contract is unchanged.

Large PLE/N-gram tables are flagged for native placement review, not silently
moved to CPU by the estimator. Current source contracts include
[vLLM per-rank KV and local layers](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/model.py),
[QSA side caches](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/models/qwen4_exp/common/qsa_cache.py),
[PLE storage](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/models/qwen4_exp/common/ngram_embedding.py)
and [Ollama buffer versus mmap accounting](https://github.com/ollama/ollama/blob/v0.40.3/llm/llama_server.go).
Logical estimates do not replace native allocator profiling or cgroup peak
measurement. MEM-01/05/06 and MGPU-01/02 owning/browser selections cover formulas,
RAM defaults, manual/saved-budget retention and explicit risk admission.
Replicated copies keep their full per-copy control; host RAM/CPU are reserved
once for a split Pod or once per replicated copy. See
[model controls](../reference/model-controls.md) and
[GPU sharing](../administration/gpu-sharing.md#one-model-across-several-nvidia-gpus).

NVIDIA group eligibility uses one source for all cards: the current DRA
inventory's exact node identity and known positive physical `gpuCapacityMi`
(`gpuCapacitySource: nvidia-dra-inventory`). Keep DCGM `totalMi`/`freeMi` and
reservation budgets separate. Equal inventory cards may have different live
totals or no live sample. Different GPU models and capacities are also allowed;
the smallest unreserved/physical ceiling bounds an equal budget on every card.
Unknown inventory capacity still blocks group
selection and is checked again by API/controller admission. Older API responses
without inventory-capacity metadata use `totalMi` as a legacy fallback;
different-card grouping requires the updated API and controller. Never compare
one inventory value against another card's legacy telemetry value.

For differently sized NVIDIA GPUs, the wrapper uses vLLM 0.31.0's native
`--worker-cls` extension point to select `budget_worker.BudgetWorker`. Each CUDA
worker converts the saved MiB budget to its own physical-memory utilization
before native startup checks free memory after NCCL initialization and profiles
model/runtime memory. Explicit KV-cache byte/block overrides are rejected on
this path because they bypass the total budget. Identical capacities retain the
standard worker. Parent processes never initialize CUDA; exact UUID/count and
model tensor/pipeline checks remain in the child probe. Upstream contracts:
[worker selection](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/worker_base.py),
[memory request](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/utils.py),
[GPU worker](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/gpu_worker.py).

The NVIDIA wrapper accepts a one-card assignment for each independent copy.
For a split group it first runs a bounded native NCCL all-reduce and bidirectional
send/receive probe on the exact assigned UUIDs in a separate process group.
If default transport fails, a second probe may qualify `NCCL_P2P_DISABLE=1`
for this Pod; it also disables vLLM's custom all-reduce, which bypasses NCCL.
An explicit operator transport setting is preserved. Both probes have deadlines;
failure stops startup with a communication diagnosis. This qualification checks
communication, and still requires model readiness and real inference acceptance.
See [NVIDIA transport troubleshooting](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting/gpu_troubleshooting.html).

### Ordinary vLLM runtime upgrades

NVIDIA, CPU, AMD ROCm and Intel XPU use the published 0.31.0 images with immutable
digests. Keep the KubeAI image map, operator-owned AMD runtime source/checksum,
hardware diagnostic catalog and Mesh CPU fixture in sync. A catalog update
invalidates an old optional AMD image-validation pin; it must not retain that
older image as the effective runtime. vLLM-Omni uses a separately pinned source
and base image and is not changed by an ordinary vLLM upgrade.

`test_vllm_wrapper.py` is selected by MGPU-01 owning contracts in both Phase 3
and Phase 4. It checks exact groups, Tensor/Pipeline strategy, equal per-card
budgets, guarded native model probing, revision forwarding and visible failures
without a one-GPU fallback. The `vllm-runtime-contracts.yml` workflow also runs
`verify_vllm_runtime.py` in the actual pinned CPU image, offline and without
weights. It checks the native model registry/configuration, GPU adapter argument
parser and wrapper activation through the image's `vllm serve` entrypoint.
The CLI parser moved to `vllm.entrypoints.launchers.cli_args` in this release;
do not keep testing a fake old import path.
The native checker receives the operator manifest through `--controller-manifest`
and extracts its actual KV-cache argument producer, testing both Auto and FP8
against the installed parser rather than a manually selected flag list.

vLLM 0.28 removed `--calculate-kv-scales`. The controller no longer generates
that switch for the current 0.31.0 pins. The wrapper still checks package
metadata without initializing CUDA and removes legacy saved switches on 0.28+.
The requested FP8 cache type
is retained, with checkpoint scales or upstream defaults instead of runtime
calibration. Unknown runtime versions fail explicitly rather than guessing.
See [upstream removal](https://github.com/vllm-project/vllm/releases/tag/v0.28.0)
and [0.31.0 cache configuration](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/cache.py).

The wrapper has a **disabled-by-default qualification backport** for the FP8
PLE pinned-host lookup in the reviewed NVIDIA 0.31.0 image. Upstream
[fix #60142](https://github.com/vllm-project/vllm/commit/b0b23a48d466712d18d390e73b62b169842f65e2)
postdates that release and copies storage bytes instead of asking Triton to
lower FP8 E4M3FN on pre-SM89 GPUs. It does not convert weights, change KV
precision, or change the model's automatic PLE CPU offload.

Only an administrator-managed test activation explicitly setting
`MAGICSTICK_VLLM_PLE_BACKPORT` to that full commit ID opts in. Native package
version, NVIDIA target and both original/result file checksums must match;
otherwise startup fails closed. The atomic changes affect only files in the
model container's writable layer and disappear when its Pod is removed.
Ordinary runtimes, Ollama and other providers do not apply the patch. Keep
rollback state for any temporary wrapper ConfigMap override and remove the
opt-in after moving to a separately qualified upstream image containing the fix.
The normal dashboard API still rejects arbitrary runtime environment injection.

The existing MGPU-01 owning suite also checks byte-width forwarding, exact
version/checksum guards, all-files-before-write validation, idempotence and
fatal startup rejection. These are local contracts, not native GPU acceptance.
For an authorized hardware trial, compare the real pinned-UVA lookup's output
bytes for FP8/BF16/FP32, reproduce the original SM86 compilation failure as a
negative control, then require full model readiness and actual routed inference.
Record the image digest **and** effective native-source hashes for a patched run.

On 13 October 2026, one local four-RTX-A6000 trial of the official FP8
Flash-Next checkpoint passed complete startup, health and a synthetic chat
through KubeAI's shared OpenAI route with Marlin, expert parallelism and standard
model-precision KV cache. The native pinned-UVA check was byte-exact for FP8,
BF16 and FP32 and reproduced the original SM86 failure as a negative control.
Explicit FP8 KV still failed in QSA sparse attention. This finite trial is not
full Phase 3/4 acceptance, a LiteLLM public HTTPS/key test, an upstream image
publication, long-context qualification or validation of other GPU providers.

This native CPU contract is not GPU, model-loading or inference acceptance.
Run compatible small models through the existing installed workflows after an
authorized rollout, covering single-card, split and replicated NVIDIA modes
and each other available provider. Record the actual source and image IDs.
In particular, registration of `qwen4_exp` does not establish support for the
NVFP4-packed PLE tables in every community Flash-Next checkpoint; see
[startup troubleshooting](../administration/troubleshooting/models.md#unsupported-model-architecture-or-quantization).

### Ollama runtime upgrades

CPU and NVIDIA use `ollama/ollama:0.40.3` and AMD uses
`ollama/ollama:0.40.3-rocm`, each with its published immutable index digest.
Keep the KubeAI image map, operator-owned AMD image/source/checksum and
hardware diagnostic catalog aligned. The standard image publishes Linux AMD64
and ARM64 variants; the ROCm image publishes Linux AMD64 only. These platform
manifests are availability evidence, not successful model or GPU inference.
Changing the AMD catalog image invalidates an older optional validation pin;
adoption must use the new effective image and checksum rather than keeping an
old passed result as proof of the new runtime.

Registry references, the persistent `/root/.ollama` mount, source-to-activation
alias repair, context/concurrency settings, KV-cache choices and
`OLLAMA_SCHED_SPREAD` retain their existing contract. Do not copy vLLM arguments
into Ollama or silently migrate/re-pull model data. The selected upstream still
defines these environment settings in its
[0.40.3 configuration](https://github.com/ollama/ollama/blob/v0.40.3/envconfig/config.go).

There are two upgrade boundaries to review:

- [0.34.1](https://github.com/ollama/ollama/releases/tag/v0.34.1) changes local
  Safetensors-to-GGUF creation/conversion. Magic Stick pulls existing registry
  tags; this upgrade does not add an arbitrary HF/Safetensors import path.
- [0.40.2](https://github.com/ollama/ollama/releases/tag/v0.40.2) introduced
  background upgrades of older downloaded models, retaining originals as
  backups. [0.40.3](https://github.com/ollama/ollama/releases/tag/v0.40.3) pauses
  that background work. Do not delete old manifests or backups during runtime
  qualification. Any explicitly converted cache and rollback to an older
  image need their own test; version selection alone is not rollback proof.

The selected `test_vllm_wrapper.VllmWrapperTests` owning suite also checks the
Ollama image/diagnostic/checksum contract and writable persistent cache mount.
Existing controller tests cover alias repair, KV environment, split versus
replicated deployment, effective AMD runtime adoption and stale validation.
Existing CPU and GPU installed scenarios cover ENG-01/02/03/09,
LIFE-01/03/04/06/07, ROUTE-01/02 and LOG-01. No new user-facing runtime setting
is introduced, so their selectors and fixture settings remain unchanged.

After an authorized rollout, qualify a small registry model on CPU and each
available GPU provider. Check source-name alias repair, actual image version,
chat through the normal route, KV modes, parameter persistence, Stop/Start and
cache reuse. NVIDIA also needs one-, two- and four-card split/replicated checks
before claiming those modes accepted on the new image. Leave unrelated running
models untouched. Record native/container and hardware checks separately from
source contracts; missing Docker or occupied GPUs are not a passing live gate.

## Application defaults and regression checks

The [generated catalog contract](../reference/model-catalog.md) defines the
per-instance OpenClaw configuration, KubeOpenCode provider refresh and AnythingLLM
initialization. Catalog defaults must not replace explicit instance preferences
or an existing embedding index. Unknown context/output metadata uses conservative
planning limits; successful rendering does not establish physical capacity.

Keep task detection separate from application model selection. Local creation
resolves `modelType: auto` in the dashboard API, persists only the concrete task,
and asks for a manual task when metadata is inconclusive. Extend
`test_model_tasks.py`, `ModelDiscovery.test.tsx` and DISC-01 browser/live coverage
when changing this contract. Application model selectors use catalog parameters
with `type: model` and `modelType: chat|embedding`; UI filtering and API validation
must agree. AnythingLLM's initial selectors must preserve saved preferences and
embedding indexes; cover changes with `anythingllm_model_defaults.test.cjs`,
`ServicesPage.test.tsx` and MOD-06 regression checks.

Run the catalog and deployment regression suites from the repository root:

```sh
python -m unittest discover -s magic-cluster/platform/magicstick-operator/controller -p 'test_*.py'
python -m unittest discover -s magic-cluster/apps/ai/model-catalog -p 'test*.py'
python -m unittest discover -s magic-cluster/apps/ai/tests -p 'test_*.py'
node --test --test-isolation=none magic-cluster/apps/ai/tests/anythingllm_model_defaults.test.cjs
node --test --test-isolation=none magic-cluster/apps/ai/tests/hermes_dashboard_proxy.test.cjs
node --test --test-isolation=none magic-cluster/apps/ai/tests/paperclip_runtime.test.cjs
node --test --test-isolation=none magic-cluster/apps/ai/tests/pi_coding_runtime.test.mjs
```

Inference consumers declare `litellmKey` in their application or module catalog
entry. The common controller creates owner-scoped `llm_api` keys, puts them only
in managed Secrets, forwards a reference/revision to instance charts and handles
suspension, rotation and finalizer cleanup. See
[Instance inference keys](../reference/application-controls.md#instance-inference-keys).

Capability regressions must cover true, false, unknown, removed declarations and
mixed fallback groups through the native exports. Extend the existing
[model capability contract](../reference/model-catalog.md#model-capabilities), not
a parallel model-name allowlist. The current LiteLLM model PATCH endpoint updates
metadata; its legacy update endpoint does not. Removed declarations need the
canonical unknown mask because upstream merge/cost-map caches retain old fields.

Run `magic-cluster/apps/ai/tests/litellm_service_keys_runtime.py` inside the pinned
LiteLLM image with an isolated PostgreSQL database and the synthetic `fixture`
mock-response route. Copy `service_keys.py` and the catalog `controller.py` to
`/fixture/service_keys.py` and `/fixture/catalog.py`. The fixture checks actual
key generation, inference, rejected admin access, block/resume, rotation grace,
revocation, owner isolation and capability metadata updates. Use the synthetic
admin key named in that checker, never a live appliance key, and remove the
owned containers/network afterwards. This validates the native HTTP/database
boundary; controller convergence, upgrades and rollback still need a test appliance.

For an AnythingLLM image update, also run
`magic-cluster/apps/ai/tests/anythingllm_runtime.cjs` inside the selected image
with networking disabled. Mount that test directory at `/test`, synthetic storage
at `/app/server/storage`, and its `anythingllm.env` at `/app/server/.env`. Run the
native Node process from `/app/server` with `STORAGE_DIR=/app/server/storage` and
`DISABLE_TELEMETRY=true`. Seed a synthetic catalog with `default-chat` (8,192
context tokens), `selected-chat` (32,768 tokens) and `default-embedding` first.
The test checks the upstream adapters' chat, SSE and embedding requests against
an in-container HTTP fixture, then uses the native GUI settings writer to save
`selected-chat`, a 12,000-token limit and `selected-embedding`.

Change the fixture's catalog defaults, rerun `model-bootstrap.cjs`, recreate the
container with the same mounted settings file, and invoke
`node /test/anythingllm_runtime.cjs preserved`. This verifies that the bootstrap
and native restart retain user preferences. All responses and credentials in
this test are synthetic; actual model inference, controller convergence and
database upgrade/rollback acceptance require separate checks on a test appliance.

For an OpenClaw image update, run `magic-cluster/apps/ai/tests/openclaw_runtime.mjs`
inside that image with networking disabled and a synthetic `LITELLM_API_KEY`.
Mount the controller-generated `small-chat.json` (8,192-token model) and
`large-chat.json` (128,000-token model) at `/fixtures`, each selecting its matching
primary model. The checker validates the native schema, `keepRecentTokens` budgets
and model-picker defaults. This catches runtime schema changes that Kubernetes
CRD validation cannot detect.

For a Hermes image update, run `magic-cluster/apps/ai/tests/hermes_runtime.py`
through the selected image's native entrypoint with networking disabled. Mount a
rendered configuration at `/opt/data/config.yaml`, replacing only the model and
provider endpoint with `synthetic-chat` and `http://127.0.0.1:9001/v1`.
Mount the proxy file directory at `/proxy` and the test directory at `/validation`.
Set the synthetic provider context to 128,000 tokens. Use the operator's
`HERMES_UID=1000`, `HERMES_GID=1000`, `HERMES_HOME=/opt/data`, dashboard loopback
host/port and `API_SERVER_*` environment; mount `synthetic-litellm-key` at
`/var/run/secrets/magicstick-litellm/api-key` and use a synthetic gateway key. The checker
verifies native provider selection, an authenticated gateway request through an
in-container chat fixture, and the dashboard through the proxy. The Node proxy
suite separately exercises Host/Origin rejection and WebSocket forwarding.

For a Paperclip update, validate the rendered `Instance` against the selected
operator's CRD and feed it to the upstream Go resource builder. Check the effective
last values of `PAPERCLIP_BIND`, `HOST`, `PAPERCLIP_API_URL` and `NODE_OPTIONS`,
including their appearance in the generated Pod. Execute the rendered adapter
init script against the selected application filesystem; its SHA-256 and exact
source guards must pass before that patch is mounted.

Start the native server with synthetic persistent storage and `local_trusted`
loopback settings. Install the exact npm Kubernetes plugin through its real API,
then restart without networking and confirm version `2026.1001.0` is `ready`.
Run `paperclip_runtime.cjs <installed-plugin-root> <runtime-preload.cjs>` with
the image's native `--import ./server/node_modules/tsx/dist/loader.mjs` loader
from `/app`. Set `PAPERCLIP_TEST_SERVER_URL=http://127.0.0.1:3100` to include
the running server checks. OpenSSL creates a short-lived fixture certificate;
the real Kubernetes client's TLS verification stays enabled. The checker
exercises workspace realization, actual WebSocket exec, safe cwd/argument
handling, the native callback environment helper and plugin manifest loading.
The Node regression suite covers upgrading a persisted older plugin, preserving
an explicit agent model and keeping parent secrets out of plugin worker environments.

Run `paperclip_opencode_runtime.cjs <generated-provider-config.json>` in the pinned
official OpenCode sandbox filesystem with networking disabled and UID/GID 1000.
Wrap the catalog's `paperclip-opencode-providers.json` fragment in `provider` and
provide a synthetic chat model. The checker supplies a local endpoint and
synthetic key, validates model selection, streams a native request and checks
the agent-shim launch contract. These fixtures do not establish Kubernetes
controller convergence, real-model tool use or database migration/rollback safety;
those remain test-appliance acceptance checks. If a flattened image filesystem
is used for local checks, restore its runtime environment/user explicitly and
record that the original OCI startup metadata was not exercised.
