# Model catalog integration

## Shared local-model configuration

The web client uses `LocalModelConfigurationForm` for Create and Edit of Ollama,
vLLM and Omni. `packages/contracts` defines a discriminated local-model draft;
`packages/core/local-model-configuration` loads saved intent and serializes
engine-specific create/update payloads. Shared source and memory components
contain no independent submit paths. Engine changes remount the draft while
preserving the name; asynchronous discovery and estimates discard outdated
responses. Editing retains the opening snapshot and revision across polling.

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
saving. Preserve individual-card validation and existing saved definitions.
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

For differently sized NVIDIA GPUs, the wrapper uses vLLM 0.23.0's native
`--worker-cls` extension point to select `budget_worker.BudgetWorker`. Each CUDA
worker converts the saved MiB budget to its own physical-memory utilization
before native startup checks free memory after NCCL initialization and profiles
model/runtime memory. Explicit KV-cache byte/block overrides are rejected on
this path because they bypass the total budget. Identical capacities retain the
standard worker. Parent processes never initialize CUDA; exact UUID/count and
model tensor/pipeline checks remain in the child probe. Upstream contracts:
[worker selection](https://github.com/vllm-project/vllm/blob/v0.23.0/vllm/v1/worker/worker_base.py),
[memory request](https://github.com/vllm-project/vllm/blob/v0.23.0/vllm/v1/worker/utils.py),
[GPU worker](https://github.com/vllm-project/vllm/blob/v0.23.0/vllm/v1/worker/gpu_worker.py).

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
