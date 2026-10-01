# Installed-appliance regression test concept

Design baseline: 1 October 2026. Status: **incremental implementation**. The
read-only Phase 0 live preflight, selected Lease/API-key safety subsets, and a
run-owned CPU/Ollama model smoke subset have passed on the test appliance.
This is not acceptance of the full Phase 0 matrix or of other model, app, GPU,
inference or host-maintenance workflows.
The [test case catalog](regression-test-catalog.md)
defines the cases to implement incrementally. All new live cases start as
**Planned**, even where related unit or fixture tests already exist.

## 1. Objective and scope

Detect regressions in everything Magic Stick manages **after installation**:
login and authorization, dashboard navigation, services and application
instances, model configuration and lifecycle, real inference, GPU selection and
sharing, memory and slots, API access, identity, licensing, Mesh, and installed
host administration. A successful API write or a green operator is not sufficient
evidence that a model can answer a request.

The first execution environment is a **Linux test container on the development
Mac plus the existing test appliance**. The Mac needs no GPU: the appliance
executes workloads. Later, the same suite can run on a dedicated CPU-only Linux
runner on the appliance's LAN.
The runner should not share the appliance's operating system or reboot lifecycle.

Explicit boundaries:

- USB image boot, disk installation, Subiquity, first-run installation and Azure
  VM provisioning are deferred. They need a separate installation suite once the
  quota/environment issue is resolved. An already configured login session and
  setup-to-dashboard handoff can still have browser regressions tested here.
- Ordinary regression runs must not change firmware, switch networks, install OS
  packages, change software channels or restart/power off the appliance.
  Deliberate maintenance profiles cover those operations separately.
- Verify Magic Stick's provisioning, access, routing and basic model-backed
  operation of bundled applications, not every upstream application's internal
  feature. Each app adapter defines its smallest meaningful functional probe.
- Model quality, maximum model size and throughput benchmarks are not functional
  acceptance. Test models are compatibility fixtures, not product recommendations.
- Intel remains in contract/negative tests; physical inference is deferred until
  suitable hardware exists. Multi-node, multiple same-vendor GPUs, MIG, MPS and
  NVIDIA DRA are not silently treated as supported sharing configurations.

## 2. Source of truth and coverage

Derive capabilities, parameters and required modules from the deployed API and
the reviewed repository catalogs. Do not copy engine allowlists or launch flags
into a second test-engine implementation.

| Product boundary | Authoritative contract and observation |
|---|---|
| Client/API and roles | [Dashboard development](dashboard.md), [API and authorization](../reference/dashboard-api.md), shared contracts/client/core |
| Modules and applications | [Module catalog](../reference/module-catalog.md), [application controls](../reference/application-controls.md), deployed module/app catalogs |
| Models and engines | [Model controls](../reference/model-controls.md), [compatibility](../reference/compatibility.md), compute-target and preset catalogs, `ModelActivation` |
| Routing and consumers | [Generated model catalog](../reference/model-catalog.md), LiteLLM/Gateway requests, consumer configuration |
| GPU resources and memory | [GPU sharing](../administration/gpu-sharing.md), [memory accounting](../concepts/memory.md), host samples, Pods, allocatable resources and DRA claims |
| Installed host | [Host management](../administration/host-management.md), [network](../administration/network.md), [Ubuntu updates](../administration/ubuntu-updates.md), [software channels](../administration/updates-rollback.md), [model cache](../administration/model-cache.md) |
| Identity, access and license | [Identity validation](identity-validation.md), [instance sharing validation](sharing-validation.md), [license management](../administration/licenses.md), root legal sources |
| Optional integration | [Mesh validation](mesh-validation.md), [Realtime validation](realtime-validation.md), their current capability limits |

Inventory every dashboard page and every public API operation against this
catalog during implementation. An added page, action, app type or engine setting
needs a catalog case or an explicit scoped exclusion in the same change.
Existing configuration compatibility is part of regression acceptance.

## 3. Test layers: use API and browser together

Use Playwright Test as the shared orchestration/reporting tool for new live API,
UI and combined cases. Keep existing Python, controller, host, CLI and component
tests at their owning layer; do not rewrite them just to use one runner.

| Layer | What it proves | Environment |
|---|---|---|
| `U` — unit/component | Calculations, validation, role rules, state transitions, dirty forms, serialization, engine-specific settings | Local/ordinary CI, synthetic fixtures |
| `C` — contract/render | API shapes, old saved objects, catalog/profile mappings, CRDs, RBAC and manifests | Local/ordinary CI, no physical GPU claim |
| `B` — fixture browser | Built frontend in a real browser: navigation, controls, responsive layout, errors, keyboard interaction | Existing isolated Playwright suite |
| `A` — live API/integration | Authenticated product API → saved intent → controllers → runtime/status | Installed appliance; no mock in the path being accepted |
| `E` — live combined E2E | Browser action plus independent API/Kubernetes/inference assertions, and API action reflected in UI | Mac/runner and installed appliance |
| `O` — operational/resilience | Reboots, hardware backend transitions, cache deletion, network rollback, updates and recovery | Explicitly authorized maintenance window |
| `N` — non-functional | Bounded response/startup times, resource leaks, accessibility, concurrency and security boundaries | Fixtures or explicitly selected live/soak profile |

The broad engine/GPU matrix should be API-driven. Each distinct engine form and
important dashboard action also needs a browser test. Do not repeat every
precision/context combination through mouse clicks. Conversely, API tests alone
will not find an unclickable slider or a form overwritten by polling.

For example, one sharing test should:

1. Change the provider's slot limit in Hardware and confirm the disruption.
2. Read the saved intent and wait for the **observed** backend configuration.
3. Check actual allocatable slots or the ready AMD shared claim and admission.
4. Read `/api/models` and compare slot counts with the Models ring/selector.
5. Start small compatible models via API, verify device binding and inference.
6. Check full-device selection is disabled and a direct API request cannot bypass
   the live slot check. Stop one model and verify the released capacity in both.

This is deliberately broader than checking that the Save button returns HTTP
200. Playwright supports direct API requests for setup and postconditions,
including [API and UI tests in one suite](https://playwright.dev/docs/api-testing).
Use that mechanism without bypassing the product's authentication boundary.

## 4. Execution profiles and gates

Profiles select cases and required capabilities, not different product behavior.
The profile matrix is the planned coverage boundary. The runner currently
provides `selftest`, read-only `preflight`, `locktest`, restricted API-key
`ownedtest`, and an opt-in **CPU-only** `smoke` subset. Implementing that command
does not make the entire profile or any GPU path accepted.

| Profile | Scope | Allowed effects |
|---|---|---|
| `fast` | Existing/new `U`, `C`, `B` tests and security checks | No appliance access |
| `smoke` | Installed login, pages, inventory, one CPU model, a disposable API key and routed inference | Run-owned models/keys only; no global configuration changes |
| `functional` | Services/apps, discovery, local/external model actions, editing, logs, users/access fixtures, engine-specific UI | Run-owned resources; selected optional modules only with approved ownership/restoration |
| `gpu` | Exclusive CPU/NVIDIA/AMD engine matrix and cross-vendor independence | Run-owned GPU models; stable current backend |
| `sharing` | NVIDIA time-slicing, AMD DRA, transitions, concurrent models and slot exhaustion | Provider/global changes; serialized maintenance window |
| `identity` | Role/access changes, disposable SSO providers and license fixtures | Dedicated disposable identities; license/SSO replacement only in an approved isolated environment |
| `mesh` | Opt-in module, membership, invitations, exports/imports and companion | Disposable mesh; two appliances/endpoints where required |
| `realtime` | Advertised Omni profile, stages, authenticated WebSocket, audio and lifecycle | Compatible runtime/model, enough storage, approved GPU budgets |
| `maintenance` | Host policy, cache cleanup, network trials, channel changes, reboot/recovery | Explicit per-operation consent and independent recovery access |
| `soak` | Repeated lifecycle/inference, telemetry and resource-growth observation | Reserved lab window; no unplanned host changes |

The `smoke` preflight requires its shared inference/runtime dependencies to be
ready. Test on-demand runtime bootstrap separately in `functional`; a missing
dependency is not permission for the smoke harness to enable arbitrary modules.

Priority is independent of profile:

- `P0`: security boundary, data/state safety or a broken core workflow. Required
  cases for the selected profile must pass before that profile is accepted.
- `P1`: normal feature coverage and important compatibility/negative paths.
- `P2`: wider configurations, cross-browser, long runs and secondary scenarios.

A missing optional GPU does not make the entire CPU run fail. It does prevent
claiming GPU acceptance. A required capability missing from a selected `gpu` or
`sharing` run is **Blocked**, not a successful skip. Unsupported combinations
have negative cases that should execute and pass, rather than disappearing.

## 5. Engine and hardware matrix

Read the effective capability policy at run start; the following is the current
contract baseline, not certification of all models/devices.

| Runtime path | CPU | NVIDIA whole GPU | AMD exclusive / DRA | Intel |
|---|---|---|---|---|
| Ollama | Positive | Positive | Positive / positive on eligible AMD profile | Negative: no bundled validated profile |
| vLLM | Positive | Positive | Positive / positive on eligible AMD profile | Contract-positive; physical test blocked until hardware is available |
| FreeToken | Negative | Positive only when central capability, whole-device and telemetry checks pass | Negative / negative | Negative |
| Experimental vLLM-Omni | Separate advertised profile; explicit compatible image where required | Separate Realtime profile | Separate Realtime profile / cooperative sharing where admitted | Contract/profile check; physical test deferred |
| External provider | No local GPU or KubeAI requirement | Same external route test | Same external route test | Same external route test |

Ollama and vLLM must each complete create → Ready → inference → edit → Stop →
Start → inference → Remove on CPU and on each available supported vendor. In
sharing runs test two small same-vendor models with a mixed-engine pair as well
as one pair using the same engine. Also test an AMD and NVIDIA model at the same
time: their backend, slots and settings must remain independent.

FreeToken receives its own supported model fixture, form, memory policy and
whole-GPU binding checks. A time-slicing slot is not a whole GPU. FreeToken
capacity must not be made to look valid by borrowing another node's RAM or by
falling back to vLLM/Ollama. Its public catalog policy may not admit a tiny
generic model; fixture selection must respect that policy and the actual lab
capacity. If no admitted fixture fits, report Blocked.

Do not compare text output byte-for-byte across engines/GPUs. Assert a valid
non-empty completion, correct requested model identity, bounded tokens,
termination/stream structure and no runtime error. Strong semantic assertions
can be used only for fixtures whose output is demonstrably stable.

## 6. Test environment, access and fixtures

### Linux container on the Mac first

The local harness uses the workspace's locked Node/pnpm/Playwright dependencies
and the digest-pinned Playwright Ubuntu 26.04 image. Run natively as Linux ARM64
on Apple Silicon; the pinned image also declares Linux AMD64 support. No AMD64
run or appliance-kernel equivalence is implied by an ARM64 browser test.
Use a fresh automated browser context, not the developer's personal Chrome
session. Initial execution is headless. Later derive a GitHub Runner variant
from this test environment; local mode must continue to work without GitHub
registration. Runner credentials and lab secrets never belong in the image.

### Local Phase 0 runner

Implementation lives under
[`dashboard/apps/web/regression`](../../dashboard/apps/web/regression/), outside
the existing `e2e` suite's automatic discovery. The entry point is
[`tools/regression.sh`](../../tools/regression.sh). Prerequisites are a running
Docker-compatible Linux runtime with Compose (Docker Desktop or Rancher Desktop)
and Internet access for the initial image/dependency build.

From the repository root:

```bash
bash tools/regression.sh build
bash tools/regression.sh typecheck
bash tools/regression.sh selftest
```

`selftest` runs only synthetic harness cases: identity/capability rejection,
verified TLS, offline/busy errors, independent lease-owner CAS races, expired/lost
leases, owned UID cleanup, atomic-delete conflicts, interrupted journals,
revision-safe restoration, current-generation polling, failed/blocked reporting,
secret redaction and an actual Chromium login to a loopback fixture. This is
**not** proof of real dashboard authentication, model cleanup or GPU behavior.
There is no GitHub registration, CI schedule, model start or host operation.

For the optional live read-only check, copy
[`lab.example.json`](../../dashboard/apps/web/regression/lab.example.json) to
`.regression/inputs/lab.json`, fill the approved hosts, Appliance UID, node
names/UIDs and expected engine matrix, and supply:

- `username.txt` and `password.txt` for a dedicated dashboard administrator.
- `observer.yaml`, a **read-only, no-Secret** kubeconfig. An administrator
  kubeconfig, wildcard/subresource grants, insecure TLS or an executable
  credential plugin is rejected. GET permission on exec/proxy subresources is
  not considered a safe observation-only grant.
- `appliance-ca.pem`, the approved CA certificate bundle, not a private key or
  leaf certificate; omit `caFile` only for publicly trusted TLS.

Keep the inputs directory mode `0700` and credential/config/kubeconfig files mode
`0600`. Relative input paths resolve beside `lab.json`. All inputs and outputs
under `.regression/` are ignored by Git and excluded from the Docker build.
The example's `CHANGEME` values intentionally fail validation. Do not discover
an arbitrary target and automatically accept its current UID as the lab pin.

The Phase 0
[`lab-rbac-observer.example.yaml`](../../dashboard/apps/web/regression/lab-rbac-observer.example.yaml)
grants only the observations required by preflight. The opt-in
[`lab-rbac.example.yaml`](../../dashboard/apps/web/regression/lab-rbac.example.yaml)
also defines a separate credential that can update exactly one pre-provisioned,
appliance-labelled Lease for `locktest` and `ownedtest`. The latter creates and
revokes only uniquely named API keys through the authenticated dashboard API;
the Lease account has no workload, Secret or production-intent permissions.
Set up these identities on the selected lab with its owner. Use short-lived
ServiceAccount credentials and refresh them out of band; do not put the
bootstrap administrator kubeconfig inside the runner.

Configure an optional `expected.flux` (`namespace`, `name`, `revision`) and
`expected.images` (`namespace`, `deployment`, `container`, `digest`) to require
exact deployed-revision/image acceptance. An optional node `bootId` pins the
approved boot. The baseline records which pins were configured: omitted pins
are inventory-only observations, not acceptance of a requested source change.

```bash
bash tools/regression.sh preflight
```

The live command verifies HTTPS/DNS, a real Keycloak browser login and the
authenticated shared API, independent Kubernetes identity/boot observations,
read-only permissions in every namespace, expected capabilities, maintenance
and active-local-model exclusion, and any requested Flux/image pins. It never
creates/acquires a Lease or mutates a product resource. If a private `lock`
selection is configured, it only reads that Lease; stale/busy ownership remains
Blocked. The separate commands below exercise only selected live safety
subsets; full model/app cleanup acceptance remains a later gate.

With an independently provisioned `regression-locker` ServiceAccount, a free
`magicstick-regression/lab-lock` labelled with the pinned Appliance UID, and a
private `lock` entry pointing to its short-lived kubeconfig, the following
selected safety checks are available:

```bash
bash tools/regression.sh locktest
bash tools/regression.sh ownedtest
```

`locktest` starts two separate Node processes. Exactly one may acquire and
release the Lease. It also tests revision-conflict refusal against a temporary
annotation on that **test Lease** and bounded read-only polling against the
pinned Flux Kustomization. It does not change GPU sharing or another product
setting. `ownedtest` logs in as the dedicated dashboard administrator, checks
the idle lab, acquires the Lease, and creates/revokes three run-owned LiteLLM API
keys through the product API. The private journal records each returned immutable
key ID before further work; teardown verifies their absence and preservation
of pre-existing key IDs. An ambiguous create or failed cleanup remains a failed
gate requiring manual inspection, not a blind retry. These are representative
HAR-04–09 **subsets**: live lost-heartbeat fencing, same-name replacement of a
ModelActivation, actual model/app/Pod/route cleanup, process-kill recovery,
borrowed product-setting restoration and delayed model status after a new
generation are not yet accepted.

Do not rely on the Mac's `.local` resolution automatically being present in the
container. A private Compose override can map the configured dashboard, identity,
inference and Kubernetes hostnames to the approved lab IP using `extra_hosts`.
Keep the real hostnames for certificate/SNI checks and OIDC redirects; a bare IP
URL or `host.docker.internal` is not a substitute for the appliance hostname.
Set `REGRESSION_COMPOSE_OVERRIDE` to that private override's absolute path.
Dynamic application hosts will require lab DNS or reviewed mappings in later
phases. The initial fixture run does not test mDNS discovery itself.

Optional local environment overrides:

| Variable | Meaning |
|---|---|
| `DOCKER_CLI` | Docker CLI executable if it is not on Bash's PATH |
| `REGRESSION_INPUT_DIR` | Private host input directory, mounted read-only at `/inputs` |
| `REGRESSION_PRIVATE_DIR` | Private host output directory, mounted at `/private` |
| `REGRESSION_COMPOSE_OVERRIDE` | Explicit private Compose override for lab networking |
| `REGRESSION_RUNNER_UID`, `REGRESSION_RUNNER_GID` | Host bind-mount ownership; defaults to the current local user |

The container runs non-root, read-only, with dropped capabilities and a private
temporary browser HOME; it has no Docker socket or published ports. Node and
Chromium explicitly trust the supplied CA, including the isolated Chromium NSS
database. Browser TLS verification is never bypassed. The container is for trusted
tests/targets, not a security boundary for executing public fork code.

Each run writes mode-`0600` `summary.txt`, allowlisted `summary.json` and `junit.xml`
under `.regression/private/runs/<run-id>/`. A configured live attempt creates an
empty resource journal before connecting; successful identity/capability checks
add a fingerprinted `baseline.json`. These artifacts and a green selected-case
report do not imply that the full Phase 0 gate passed. Empty selections,
Blocked/Skipped/Flaky required cases and missing IDs fail acceptance. The image's
source revision is a build **base** revision, not proof that uncommitted local
code or a requested revision is deployed. Raw traces, screenshots, response
bodies, cookies and authentication storage are deliberately not captured.

Local validation on 2026-10-01 passed the isolated Playwright fixtures on both
native macOS and Linux/ARM64 in the container across HAR-01–11.
Regression TypeScript checks, the existing 271 web and 96 CLI unit tests, 39
documentation checks and the strict documentation build also passed. A local
`preflight` without lab inputs exited nonzero with all three live cases Blocked
and zero executed; it did not connect to an appliance. Those initial results
did not accept a live lab, GPU inference, live lease exclusion or live cleanup;
the selected later live runs are recorded below.

After the test owner approved removing its three active local model definitions,
a read-only preflight on 2026-10-01 passed HAR-01–03 (3 selected, 3 executed, 3
passed). It verified the real dashboard login, independent Kubernetes
Appliance/Node identity, the pinned boot ID and Flux revision, the expected
compute targets, observer permissions and an idle model state. The private
allowlisted report is `reg-0ca753d8-dd5d-4c96-8ae4-14df394275d5`; image
digests were inventoried but not configured as acceptance pins. This run does
not prove inference, model lifecycle or live journal cleanup. The observer token
is short-lived and must be refreshed for later runs.

On 2026-10-01, a final read-only preflight passed HAR-01–03 with the
dedicated Lease present (`reg-e2bd7ab2-88c9-4f53-9b61-3c6644241656`). A
two-process Lease race plus test-Lease revision conflict and Flux polling passed
the selected HAR-04/08/09 subset (`reg-acc134a7-9714-4deb-87a4-c1cd735a9b41`).
Three API-key ownership/failure/recovery-journal cases passed the selected
HAR-05/06/07 subset (`reg-4680ff39-f800-41aa-bf66-646bc2fe7577`). The
API-key IDs were verified absent afterwards; the Lease was free with no probe
annotation, and the appliance had zero ModelActivations and model Pods. The
private reports are ignored local files. Earlier failed Lease attempts exposed
and led to fixes for Kubernetes' six-digit `renewTime` format and `kubectl
replace` JSON output; those failed attempts are not counted as a clean first
pass. No GPU sharing, model, app, host setting or inference was exercised.

### Opt-in CPU model smoke and recovery

`smoke` implements one deliberately narrow lifecycle parameter set:
create a small advertised CPU/Ollama model through the product API, observe its
owned Pod and Ready catalog entry in Kubernetes and the browser, inspect Logs,
make a real authenticated LiteLLM chat request, Stop in the browser, verify
route/Pod withdrawal, Start through the API, infer again, then remove the
run-owned model and key. This does **not** cover vLLM, GPUs, browser Start,
editing, full service installation or global settings.

Configure `inferenceUrl`, `smokeModel`, the dedicated `lock`, and a separate
`modelCleanupKubeconfig` in the private `lab.json`. Use the reviewed
[`model-cleaner RBAC example`](../../dashboard/apps/web/regression/lab-rbac-model-cleaner.example.yaml):
the cleaner may get/list/delete only `ModelActivation` in `ai-system`. The
runner validates those permissions. Create/Start/Stop use the real product
API/UI, not Kubernetes admin writes. Cleanup requires the journaled UID and
generation and sends a DELETE with atomic UID and resource-version
preconditions. No model is started until the inference hostname passes
verified HTTPS/TLS, the dedicated credentials and capability/idle checks
pass, and the lab Lease has been acquired.

```bash
bash tools/regression.sh smoke
```

An initial 2026-10-01 read-only preflight with the inference URL was **Blocked**
(`reg-04680ed0-618a-4b15-97b3-9b777c18afd8`): the advertised LiteLLM
hostname was missing from the local Gateway certificate. The first guarded
`smoke` invocation was also Blocked before mutation
(`reg-6485dd13-d5fa-4654-b058-33ec81bba280`). After correcting and applying
[`pilot-certificate.yaml`](../../magic-cluster/platform/identity/pilot-certificate.yaml),
the selected run-owned CPU/Ollama lifecycle and routed-inference subset passed
5/5 (`reg-2b59fec1-29d0-4d48-b137-da9885236922`). Its private report states
that the full Phase 0 gate was **not assessed**. Do not infer GPU, other-engine,
all-parameter or full cleanup acceptance from this selected smoke run.

If a run is interrupted after an owned UID was recorded, first inspect its
read-only plan. Once the target and ownership still match and the lab Lease is
free, explicitly resume cleanup with that exact journal:

```bash
bash tools/regression.sh cleanup-plan /private/runs/<run-id>/journal.json
bash tools/regression.sh recover /private/runs/<run-id>/journal.json
```

`recover` creates no new model/key and does not steal a stale Lease. A
requested resource without recorded UID, a changed UID/generation or a failed
delete remains Blocked for manual inspection. Both commands write private
reports.

Unknown UIDs and replacement objects require review. The model adapter uses
an atomic UID/resource-version precondition rather than unconditional
deletion by name; the API-key adapter revokes the exact immutable LiteLLM
token ID. App/identity adapters are not implemented. Preserve both the
original failure and any cleanup failure.

Resolve the configured dashboard, identity and inference hosts normally. Trust
the appliance's CA explicitly in browser/HTTP clients, or use a valid trusted
public certificate. Never accept `ignoreHTTPSErrors`, global TLS verification
disablement, fabricated cookies or a host-admin kubeconfig as authentication
success. Test local mDNS and public DNS routes separately where available.

Obtain a real OIDC login for each dedicated test role. For ordinary same-origin
browser API tests, use the authenticated browser request context and the actual
CSRF contract. Separate Bearer-token tests use the existing terminal/API route
with a token for an allowed client. An inference key is **not** a dashboard
administrator token. Do not enable a password grant just to simplify tests.

Playwright [authenticated state is sensitive](https://playwright.dev/docs/auth).
Store it only in an ignored, access-restricted temporary directory, separated
per identity and removed after the run. Login, logout, expiry and role-change
cases deliberately do not reuse an old successful session.

### Required lab resources

- A dedicated, identifiable installed appliance with approved test use, stable
  storage and recovery access. Inventory current Node UID, boot ID, driver,
  kernel, resource/claim state and non-test workloads before mutation.
- Dedicated administrator, operator, viewer and ordinary-user identities; a
  second administrator for last-admin protection tests. Credentials come from
  local private configuration initially, then the runner's secret store.
- A least-privilege read-only Kubernetes observer for relevant intent resources,
  Nodes, Pods, Events, Flux, catalog and allocation metadata. Secret values are
  neither required nor collected; do not grant general Secret list/get just for
  leak checks. Secret lifecycle assertions belong in isolated API/controller
  fixtures or an explicitly approved diagnostic boundary. Host journal collection
  is separately scoped.
- Small compatible, explicitly reviewed model fixtures per engine/target, plus
  chat and embedding types where supported. Record exact repository/tag/revision,
  quantization, source license, download bytes, context and expected budget.
- A controlled external OpenAI-compatible fixture endpoint for route/credential
  tests. Identify it as synthetic. Real local GPU inference is never replaced by
  that fixture in a positive hardware case.
- Optional disposable upstream OIDC/SAML identity provider; Mesh peer/companion;
  an audio input fixture for automated Realtime protocol checks. Human speech and
  microphone/Playground acceptance remain a recorded manual case.

Use public-safe variables such as `REGRESSION_DASHBOARD_URL`,
`REGRESSION_API_URL`, `REGRESSION_INFERENCE_URL`,
`REGRESSION_KUBECONFIG`, `REGRESSION_PROFILE` and private credential references.
Those URL/profile names describe later profile contracts; the implemented Phase
0 runner uses the validated private JSON configuration described above. No real
domain, password, invitation, API key, kubeconfig or signed
customer file is committed to the repository.

Run warm-cache functional tests normally. Run cold-download cases in a separate
scheduled window with enough disk/network budget. Clearing all model caches
just to make a routine test deterministic is prohibited. Hugging Face/Ollama
search adapter tests use recorded fixtures for deterministic assertions and a
small live health test for the actual integration; do not assert an exact live
trending order or confuse rate limiting with an engine regression.

### Isolation and ownership

One live mutation run owns an appliance at a time. Combine a CI concurrency group
with an appliance-scoped lease or equivalent external lab lock shared by local
and CI runners. A runner-local file alone cannot exclude another Mac/runner.
Never break a possibly active stale lease without inspection. Record owner,
run ID, target identity, heartbeat and a bounded expiry; a lost lease stops new
mutations. This is a test-harness lock, not a new production controller.

Assign a unique valid name prefix to every run-owned model, app, key and test
identity. Keep a durable resource journal with type, name, UID, owning run and
cleanup status. Use labels only where the existing API contract supports them;
names and recorded UIDs must suffice. Do not bypass an API by patching ownership
fields or creating a Deployment directly to make a test pass.

Before changing any global module/provider/license/host setting, snapshot the
non-secret desired state and revision and confirm authority to change it. Stop
only run-owned workloads. A sharing transition is Blocked if unrelated workloads
would be interrupted. Restore through the same API with current revision checks;
an intervening human edit requires review rather than a blind overwrite.

Cleanup runs on failure as well as success: Stop/Remove owned models, wait for
Pods/claims/routes and slots to settle, remove owned apps/keys/identities, then
restore explicitly borrowed settings and verify the baseline. Preserve failure
evidence first. Never delete an entire existing namespace, clear DRA checkpoints,
force-kill APT, remove lock files or clear host-operation status for cleanup.
An interrupted run leaves a resumable cleanup journal. Cleanup failure is a
separate failing safety gate; it must not hide the original test error.

Package, firmware and software maintenance can have deliberately persistent or
non-reversible effects. Agree the expected post-test baseline and backup/recovery
procedure before those cases. Never auto-downgrade packages, restore data or
change firmware merely to satisfy generic teardown. A required restore uses a
new reviewed operation; its result and any approved baseline change are reported.

## 7. Lifecycle oracle and timing

For each successful local model case, observe independently:

| Stage | Required evidence |
|---|---|
| API admission | Correct response and validated saved configuration; UID/generation/revision recorded |
| Runtime intent | `ModelActivation` has the requested engine, target, enabled state and independent engine settings |
| Reconciliation | Required modules settle; native KubeAI Model or direct Deployment belongs to that intent |
| Placement | Owned Pod exists, scheduled to the selected eligible node with matching resource request/claim/CDI; no unintended CPU fallback |
| Runtime | Health passes and source model is loaded; Ollama's runtime alias is usable; applied KV/CPU/memory settings match intent |
| Publication | API status, generated catalog and LiteLLM model/route identify the same ready model |
| Inference | Real authenticated request through the normal inference route returns a usable response |
| Dashboard | Card/form/gauges/logs show the corresponding state and values without stale success |
| Stop/remove | Route withdrawn, Pods terminate, allocation/slot released, saved definition preserved on Stop and removed only on Remove |

The observer reads Kubernetes; product actions use the dashboard API/UI. Kubernetes
admin writes cannot substitute for successful product provisioning. Tests for
external models verify only local intent/routing; Stop must not claim to stop
the remote provider.

Poll explicit conditions with a total deadline and bounded backoff. Do not use
fixed sleeps as proof, search for a percentage of progress or accept the first
old Ready condition. Match UID, generation, request ID and Pod revision after
each change. Existing active-model reservations may be reused on edit, not
counted as extra newly free physical memory.

Separate deadlines for API response, module/image setup, first Pod, weight
download, runtime warm-up, inference, termination and host recovery. Seed them
from each fixture's observed timings in the first pilot runs, then commit reviewed
limits and a hard run ceiling. Record cold/warm mode and elapsed time per stage.
A slow download must not bypass the existing no-Pod stall contract: after two
minutes with no Pod, the model must report the actionable stalled-creation
failure. A Pod downloading weights is a different state. Do not extend a
deadline after failure merely to produce green evidence.

## 8. Results, evidence and diagnosis

Maintain two independent fields:

- Implementation: `Planned`, `Implemented`, or `Manual procedure` with test-code
  or procedure link and fixture dependencies.
- Execution: `Passed`, `Failed`, `Blocked`, `Skipped` (explicitly not selected),
  or `Not run`, bound to one run and source/deployment revision.

No automatic success for an empty selection, an offline server or a skipped
GPU matrix. Report implemented/selected/executed/passed counts separately and
list all required cases missing from the gate. A pass after retry is reported as
flaky, not silently clean. Never retry a destructive mutation blindly after an
ambiguous network response; inspect the recorded request/intent first.

Each run should produce:

1. Human-readable summary and JUnit/JSON results by case ID, profile, role,
   engine, target, runtime image and cache mode.
2. Source-under-test revision, deployed host/Flux revisions and running image IDs;
   no claim that a source checkout was deployed just because its CI passed.
3. Sanitized environment/fixture inventory, stage timing and bounded status/event
   snapshots. Include intended versus observed allocation/configuration.
4. Reviewed screenshots or browser diagnostics at assertion boundaries, plus
   bounded current/previous/init-container logs on failure where authorized.
5. Baseline/cleanup differences and the safe next recovery action if cleanup
   could not complete.

Failure classification distinguishes authentication/TLS, validation/conflict,
dependency/permission/admission, scheduling/claim/device binding, image pull,
download/storage, runtime load/OOM, health/catalog/routing and browser rendering.
Include the first useful failure and the affected component, not just
`0/1 replicas` or an exit code. If a required service degrades during a run, keep
the test Failed; an unrelated outage already present at preflight is Blocked.

Live artifacts are **private by default**. A public repository's Actions artifact
must not receive raw live traces, HAR files, browser storage, downloaded
kubeconfigs, license documents, tokens or response bodies that may contain
credentials. Login, credential and invitation dialogs run without raw trace/video
capture. Capture allowlisted/redacted diagnostics instead. Other live traces
also contain session cookies/headers: keep restricted locally unless a reviewed
sanitizer removes those values and screenshots are checked. Fixture-only traces
can follow the existing seven-day CI policy. Propose seven-day private live
retention initially; keep sanitized release summaries separately when reviewed.

## 9. Existing tests to reuse and extend

These are source coverage, not proof that the new live catalog has passed.

| Existing assets | Reuse / remaining gap |
|---|---|
| `dashboard/apps/web/e2e/dashboard.spec.ts` and browser-smoke workflow | Built-client fixture navigation, roles, expiry, lifecycle, conflicts, logs and overflow; add live auth/backend as a separate opt-in configuration |
| `dashboard/apps/web/src/*test.tsx`, contracts/API-client/core/CLI tests | Forms, engine rules, save/revert, memory/slots, access controls and DTO behavior; add missing catalog assertions at these owning layers |
| `magic-cluster/apps/dashboard/test_*.py` | Model edit/lifecycle/logs, FreeToken, hardware, memory, slots/sharing, host/cache/network/updates/channel and routing contracts; broaden invalid/stale/race cases |
| `dashboard/apps/api/test_*.py` and existing Rancher acceptance helpers | License, federation and instance-access boundaries; use isolated signed fixtures and real login, never customer licensing/signing material |
| `magic-cluster/platform/magicstick-operator/controller/test_*.py` | Intent → workloads/catalog, model readiness/recovery, claims and allocation; add focused failure and old-object fixtures |
| `magic-host/roles/host-management/tests/` and other affected host role tests | Safety, replay, policy, rollback and recovery with temporary files/commands; physical restart/network acceptance is still separate |
| Existing Mesh E2E Job and Realtime procedures | Native transport/library and protocol contracts; separate genuine peer/physical/audio acceptance remains necessary |
| Kustomize/CRD/image/release checks | RBAC and source/image consistency, signatures/inventory and security; do not replace them with a browser suite |

The implemented Phase 0 foundation under `dashboard/apps/web/regression/`
contains an opt-in Playwright configuration, auth/read-only transport/observer,
lab-lease/resource-journal/polling/report helpers and isolated harness fixtures.
It reuses the locked workspace and shared DTOs/client. A narrowly fenced live
API-key adapter is implemented; model/app adapters, fixture model definitions
and later domain specs remain to be implemented. Keep
them outside the existing fixture suite's automatic discovery.

The harness observes current capabilities but also compares them with the
profile's **expected lab inventory**. Otherwise a disappearing NVIDIA provider
could simply remove all NVIDIA tests and make a broken run look successful.

## 10. Proposed CI selection and operating model

Ordinary PRs continue running `fast` on GitHub-hosted runners without lab secrets.
Live execution starts manually from the Mac. Once safe cleanup and authentication
are reliable, add a maintainer-dispatched workflow on a trusted reviewed ref,
an approved lab environment, explicit profile selection and appliance concurrency.
Never run fork PR code with testserver credentials or unrestricted self-hosted
runner access.

A LAN self-hosted runner can initiate its GitHub connection over outbound HTTPS;
the appliance needs no public dashboard/SSH exposure for CI. Follow
[GitHub's self-hosted runner requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).
Outbound access, DNS/CA trust, runner updates and a separate cleanup/recovery
operator remain required. Use a dedicated, restricted runner, not a privileged
runner on the appliance itself.

Suggested cadence, to enable only after the preceding implementation gates:

- `fast`: relevant PRs and pushes, retaining existing repository selection.
- `smoke`: after a verified deployment and manually on demand.
- `functional` and stable-backend `gpu`: a reserved nightly lab window.
- `sharing`, cold downloads, `mesh`, `realtime` and `soak`: reserved weekly or
  pre-release windows according to available fixtures/hardware.
- `maintenance`: manual dispatch with operation-specific approval and recovery
  owner; never a surprise nightly reboot/network/cache operation.

Schedule against the **deployed revision**, with a separate requested-revision
check when accepting a change. Do not test a checkout against an old server and
report it as that checkout's live acceptance. Tests do not auto-switch the
server to arbitrary branch code. Paused lab use or offline hardware is a visible
Blocked result, not a reason to alter workloads or restart the host automatically.

Change-based selection supplements a periodic full run:

| Change | Minimum extra selection |
|---|---|
| Shared API/auth/contracts or API RBAC | Role/negative API, live smoke, service/model write → reconciliation and UI visibility |
| Model UI/engine config | That form's browser cases plus model lifecycle, persistence and routed inference; shared changes include Ollama and vLLM |
| GPU/sharing/memory/controller | Unit/render plus vendor matrix, slots, live backend and binding, cross-vendor non-interference |
| Catalog/app/routing | Relevant instance lifecycle, model catalog consumers, allowed/denied routes and inference |
| Host/updates/network/channel | Isolated host tests plus selected approved maintenance cases; no implicit reboot |
| License/SSO/ACL/Mesh | Boundary/negative fixtures plus selected isolated live identity/access/peer cases |

## 11. Incremental implementation backlog

Each phase is a separately reviewable task. It may add missing fast tests first,
then live evidence. Do not replace the current working suite in one rewrite.

| Phase | Work package and catalog families | Completion gate |
|---|---|---|
| 0 | Harness foundations: `HAR`; lab identity/capability contract, lock, auth, read-only observer, polling, resource journal, redaction, result/report schema | Demonstrate safe abort on wrong/offline/busy target, then owned-resource cleanup including an interrupted run; no GPU/config change |
| 1 | Core installed smoke: selected `AUTH`, `NAV`, CPU `LIFE`, `ROUTE`, `KEY`, `LOG`, `UX` | Real login; create/infer/Stop/Start/Remove one CPU model; API-created model visible in UI and UI Stop reflected in API/Kubernetes; cleanup clean |
| 2 | Complete model control: `DISC`, `LIFE`, `ENG`, `MEM`, external models, revision conflicts, each engine's UI contract | Ollama/vLLM CPU flows and persistence pass; browser dirty-form/slider tests pass; external routes do not need a GPU |
| 3 | Dedicated GPU runtime: `HW`, exclusive `SLOT`, NVIDIA/AMD `ENG`, `FT`, live telemetry and GPU logs | Ollama/vLLM on each available vendor and admitted FreeToken model perform inference; actual device binding verified; Intel gate explicitly deferred |
| 4 | Sharing and historic regressions: `SHR`, full `SLOT`, mixed-node `MEM`/`HW`, selected `BOOT` | NVIDIA time-slicing and AMD DRA observed end-to-end; slot exhaustion/release and mixed-engine inference pass; original mode restored; reboot subset only by approval |
| 5 | Applications and access: `MOD`, `APP`, `USER`, `K8S`, `ACL`, `LIC`, `SSO` | Each catalog app has a functional probe; viewer/operator/admin/ordinary-user boundaries and last-admin safety pass; disposable identities/provider/keys cleaned |
| 6 | Installed host administration: `HOST`, `GPUHOST`, `NET`, `UPD`, `CHANNEL`, `CACHE`, remaining `BOOT` | Non-mutating forms and isolated safety tests first; each disruptive live case separately authorized and baseline/recovery verified |
| 7 | Optional integration: `MESH`, `RT` | One-appliance contracts distinguished from real peer routing; protocol automation and manual audio acceptance separately reported |
| 8 | Automation and hardening: `SEC`, `PERF`, `UX`; trusted CI runner/cadence, ownership recovery | Repeated clean scheduled runs; no leaked state/secrets, flaky results visible; measured timing/resource baselines reviewed |

Track these initial implementation gates as work is completed:

- [ ] Phase 0: harness and lab contract accepted.
- [ ] Phase 1: first real installed-appliance smoke accepted.
- [ ] Phase 2: model control/forms and external routing accepted.
- [ ] Phase 3: exclusive engine/GPU matrix accepted for available hardware.
- [ ] Phase 4: sharing/slots/mixed-vendor regressions accepted.
- [ ] Phase 5: service/app/access and identity matrix accepted.
- [ ] Phase 6: approved host-maintenance cases accepted.
- [ ] Phase 7: optional Mesh/Realtime environments accepted where available.
- [ ] Phase 8: repeatable trusted CI and non-functional baselines accepted.

Installation tests are a separate deferred work package; none of these boxes
claims installation acceptance. A phase may have explicit hardware-dependent
open cases, but its summary must name them rather than mark universal acceptance.

### Definition of done for each implementation task

Record case IDs, source contract, parameters, fixture and required authorization.
Implement the smallest shared helper necessary, then the owning fast test and
live/UI test. Every test needs preconditions, action, independent assertions,
deadline, evidence, and failure-safe teardown. Exercise it on an intentional
safe failure as well as success, without mutating unrelated state. Link the test
and last reviewed evidence from the catalog's implementation ledger. Verify
other engines after changing shared code.

An implementation task is done when selected cases have reproducible tests,
required live assertions passed on the recorded revision/hardware, artifacts
were reviewed, cleanup is clean and remaining Blocked/Manual cases are explicit.
Code written, unit tests passed, image built, source pushed and live acceptance
are separate facts. Commit/push, deployment and enabling schedules require their
own requested scope.

## 12. First task to implement

First accept the Phase 0 foundations and live read-only preflight. Then implement
a narrow Phase 1 slice: one small CPU model through the product API, real routed inference,
UI card/log/Stop checks, API Start, inference again and owned-resource removal.
Add the resource journal and failure cleanup **before** increasing the matrix.
This validates the shared API/UI test approach without depending on GPU sharing,
Azure quotas or another installation.
