# Installed-appliance regression test concept

Normal operation: [short regression runner guide](regression-remaining-p0.md).
The registered disposable-lab policy now enables automatic Phase 0–8 P0
preparation and execution without per-scope approvals or manual configuration.
Independent cases continue; results are Passed, Failed or Blocked. Historic
opt-in/proposal workflows below describe the earlier implementation, not the
current normal command. This change has not yet received live acceptance.

Design baseline: 1 October 2026; evidence reviewed through 5 October 2026.
Status: **Phase 0 and finite Phase 1 P0 accepted on 4 October; finite Phase 2 P0
accepted on 5 October 2026**.
The complete foundation profile passed on the test appliance, including its
required live negative/fault/recovery variants and final pinned preflight.
Phase 1 P0 has a finite implemented and accepted CPU/Ollama smoke profile; dated
live evidence is recorded separately below. Selected CPU/Ollama smoke and model-edit subsets
have also passed. Phase 2 P0 now has a finite implemented CPU model-control
profile for Ollama, vLLM, discovery and an external route. Its canonical
eight-stage repeat passed all 85 required U/C/B/A/E evidence tuples, including
the actual runtime-failure case and final pinned preflight. The wider Phase 2–8 product
matrices and other engine/app/GPU/host-maintenance workflows are not therefore
accepted. Domain-specific variants remain in their later phases.
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
- Full runs on a registered disposable lab include supported maintenance and
  reboot cases automatically. Missing physical recovery/control prerequisites
  block only dependent cases; unregistered targets never receive live writes.
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

### File names, selection and evidence

Organize specifications by **function and actual test type**, not by delivery
phase. Phases and priorities belong to explicit acceptance profiles. Moving a
case to another phase must not require renaming its specification.

| Pattern below `dashboard/apps/web/regression/` | Meaning |
|---|---|
| `<domain>/<behavior>.unit.spec.ts` | `U`: isolated unit/component assertions; owning Vitest suites remain under `src/` |
| `<domain>/<behavior>.contract.spec.ts` | `C`: shared-client, response, rendering or backend contract assertions |
| `<domain>/<behavior>.browser.spec.ts` | `B`: actual bundled UI with isolated API fixtures, no appliance acceptance |
| `<domain>/<behavior>.api.spec.ts` | `A`: installed API/integration observations |
| `<domain>/<behavior>.e2e.spec.ts` | `E`: installed browser and independent API/Kubernetes/inference proof |
| `<domain>/<behavior>.cases.ts` | Reusable case registration, not an independently discovered suite |
| `profiles/phase0-p0.ts`, `profiles/phase1-p0.ts` | Required IDs, variants and evidence for the named acceptance gate |

Current domains are `harness`, `auth`, `navigation`, `models`, `api-access`,
`observability` and `components`. Shared synthetic data live in `fixtures/`;
transports, ownership, Lease, polling and reporting live in `core/`.
[`profiles/selections.ts`](../../dashboard/apps/web/regression/profiles/selections.ts)
explicitly selects specification files for each command; unknown modes fail
closed. Operational/non-functional specs can be added to their domains when
those authorized profiles are implemented.

The CPU/Ollama E2E workflow intentionally retains one serial, Lease-protected
model lifecycle. It registers the related key, navigation, log and form cases
from their functional `*.cases.ts` modules. This avoids order-dependent state
shared between separately discovered spec files or multiple uncontrolled models.

Report schema **2** separates canonical `layer` (`U/C/B/A/E/O/N`) from
`environment` (`fixture/live`). File suffixes provide the default layer; explicit
reviewed annotations can declare complementary `A+E` observations or multiple
case IDs. The reporter does **not** infer a passed layer from the profile's
requirements. A tuple is accepted only when that exact ID, variant, layer and
environment passed; missing layers and failed infrastructure produce failures.
Historical schema-1 reports retain their original meaning and are not upgraded
into broader layer acceptance.

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

### Console progress and report descriptions

The runner prints a start line **before** each executable test, including its
position in the selected sub-run. A static scenario name, when available, makes
repeated IDs such as `HAR-10` distinguishable. The catalogue goal explains the
action and expected proof; evidence lines identify the actual layer, environment
and reviewed variant. Completion lines include outcome and elapsed time. Failed
or blocked checks show a fixed, public-safe reason and the stalled stage when
known, rather than a raw server response.

Illustrative isolated-fixture output; counters and durations vary:

```text
[3/12] START HAR-03
  Scenario: HAR-03 pending operation, active local model and busy updates block safely
  HAR-03 catalogue goal: Observe an offline API/host, pending maintenance or unrelated busy workloads at preflight. Report Blocked with a reason; do not reboot, delete workloads or force a lock.
  Evidence: U — unit/component; fixture
[3/12] HAR-03: Passed — 0.2s
```

Descriptions are read directly from the public
[case catalogue](regression-test-catalog.md), not a second maintained list.
Only simple literal scenario titles verified against public test source are
printed; interpolated/private titles fall back to the catalogue and allowlisted
variant. Credentials, upstream error bodies and raw annotations are not printed.

Private `summary.txt` includes catalogue goals, expanded layer names, elapsed
times and safe failure reasons. Schema-2 `summary.json` adds a catalogue-derived
`description` to each recorded case; `junit.xml` keeps the stable ID/variant test
name and adds a `catalogueGoal` property. Caller-supplied description fields are
ignored. A goal describes the **case family**, not proof that every engine,
hardware parameter or complementary layer passed. Acceptance gates are unchanged.

## 4. Execution profiles and gates

Profiles select cases and required capabilities, not different product behavior.
The profile matrix is the planned coverage boundary. The runner currently
provides `selftest`, read-only `preflight`, `locktest`, restricted API-key
`ownedtest`, the complete foundation `phase0`, the finite installed-smoke
`phase1`, and opt-in **CPU-only** `smoke` and `model-edit` subsets. Implementing
these commands does not make the entire profile or any GPU path accepted.

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

The default local image is `magicstick-regression:local`. When several working
copies share one Docker engine, choose a distinct local tag with
`REGRESSION_RUNNER_IMAGE` and use the same value for both `build` and every run.
This is a local runner tag, not an appliance deployment or published runtime
image. An already running container continues using its original image even
when a new runner image is built.

After supplying the reviewed private lab profile and dedicated credentials,
run the complete **Phase 0 P0 harness acceptance** with:

```bash
bash tools/regression.sh phase0
```

This command runs the isolated fixtures, initial pinned read-only preflight,
two-process Lease/revision tests, live owned-resource fault tests, and final
read-only preflight in that order, without retries. `steps.json` links the
private sub-run reports. `summary.json` sets `fullPhase0Accepted` only when
every fixture HAR ID and all 14 required live variants pass; missing variants,
failure, blocked/skipped/flaky outcomes or failed final preflight cannot pass.
The reviewed matrix is defined in
[`profiles/phase0-p0.ts`](../../dashboard/apps/web/regression/profiles/phase0-p0.ts),
not inferred from whichever tests happened to run.

The full profile requires pinned boot IDs, an exact Flux revision, independently
reviewed web/API image digests, the dedicated test Lease and the separate
ModelActivation cleanup credential. Read-only `preflight` still supports a
less strict inventory profile; it never certifies the full Phase 0 gate.

| Cases | Phase 0 P0 acceptance proof |
|---|---|
| HAR-01–03 | Verified HTTPS and real login; pinned independent Node/boot/capability/source/image observations; wrong pins rejected without writes; offline and busy conditions block; final idle preflight |
| HAR-04 | Independent Lease contenders plus a replaced live Lease permanently fencing actual model/key transports; lost/expired-heartbeat fixtures |
| HAR-05 | Durable name/UID ownership and atomic deletion; a live same-name/different-UID CPU ModelActivation survives the original journal's cleanup |
| HAR-06 | Deliberate failure after an owned key and Ready CPU model; original failure/stage retained while intent, runtime Pod, catalog route and key are removed |
| HAR-07 | A separately spawned runner is killed only after its durable model/key UID barrier; another process resumes the exact journal and verifies cleanup |
| HAR-08 | Generic revision-safe restore fixtures and an intervening revision on the dedicated test Lease; no overwrite of that revision |
| HAR-09 | Actual CPU model Stop/Start generations; cached old Ready is rejected, delayed current evidence is polled, and timeout reports an allowlisted stalled stage |
| HAR-10–11 | Incomplete/outcome/variant report gates, secret-seeded redaction fixtures, private durable reports and no stored browser auth state/traces |

This is the **harness foundation** gate, not the complete product regression
matrix. Phase 0 uses only run-owned CPU models/API keys and the dedicated test
Lease. App/identity cleanup adapters, GPU allocation/claim cleanup and borrowing
actual product sharing or host settings must be accepted with their domain
phases; the generic app/global-setting safety contracts are fixture-tested here.
The interruption proof never reboots the server or kills an unrelated process.
Only the parent of that explicitly spawned, proven-dead worker may CAS-clear
its exact test Lease holder. Normal commands still refuse stale/busy owners.

<a id="phase-0-p0-acceptance"></a>

#### Phase 0 P0 acceptance — 2026-10-02

The complete profile passed in the local Linux/ARM64 Docker runner:
**54/54 case-layer results**, all HAR-01–11 fixture IDs, all **14 mandatory
live variants**, and all five sequential sub-runs. Private aggregate report:
`reg-4c6b7bd5-687e-42bf-8e87-08d27af1a513`; its `steps.json` links fixture,
initial-preflight, Lease, foundation and final-preflight reports.
`summary.json` records `fullPhase0Accepted: true` with no missing variants.

The appliance followed `develop` Flux revision
`a3acf6d81a63ce18601291878bc7044eb2e857f8`. The runner contained local,
uncommitted harness changes based on that revision; this is not a source
publication or deployment of those harness changes. Critical web/API image
digests were reviewed against the checked-out GitOps manifests and independently
verified on running Pods, rather than accepting an arbitrary live inventory.
Regression TypeScript and shell syntax checks, 53 documentation/guidance/site
tests, and the strict documentation build passed separately.

The first attempted full run correctly stopped at `HAR-03 / BUSY` while two
non-run-owned vLLM models were active. With explicit owner approval those two
definitions were temporarily disabled for the reserved test window, without
changing their other saved settings or cache. Their UID/generation and saved
parameter fingerprints were recorded privately. After the final idle preflight,
both were re-enabled with the matching UID/generation and unchanged parameter
fingerprints. Their GPU runtime readiness is not a Phase 0 acceptance claim.
This pause is lab preparation, not an enabled
unrelated-resource mutation path in the regression harness. No GPU sharing,
firmware/memory, host operation, RBAC or deployment change was made.

Owned CPU model/Pod/catalog/key cleanup, same-name UID preservation, permanently
fenced clients and actual process-kill journal recovery all passed. The final
read-only preflight found the lab idle and the test Lease free; no owned
resource remained. This accepted foundation is the prerequisite for Phase 1 P0.

#### Phase 0 P0 repeat acceptance — 2026-10-04

The complete profile passed again: **61/61 case-layer results**, all 14 required
live variants, and final pinned idle preflight. Aggregate
`reg-98491d09-43a7-4d9a-b1cb-0c4c3e308d8a` records
`fullPhase0Accepted: true`, no missing variants and no failed, blocked, skipped
or flaky selected result. The additional result count comes from expanded
harness fixtures, not a claim of additional GPU acceptance.

The lab followed reviewed `develop` source revision
`0b8d48c32166501beec2f1ed7a16eacc83d8785c`; critical web/API digests, appliance
and Node UID, current boot identity and requested engine capabilities were
independently checked. Expired dedicated credentials were renewed. The
interrupted 2 October journal was separately recovered in
`reg-604aca53-6206-46a8-82fb-b662a3440f5a`, after proving the old runner absent
and CAS-releasing only its exact expired test Lease holder.

Both unrelated baseline vLLM definitions were already Disabled before this
repeat and remained Disabled with unchanged UID/generation. All run-owned
resources were removed and the dedicated Lease was released. Runner changes
remain local and uncommitted; no product deployment or GPU/global-setting
change is claimed.

<a id="phase-1-p0-smoke"></a>

#### Phase 1 P0 installed smoke

```bash
bash tools/regression.sh build
bash tools/regression.sh phase1
```

The complete command runs seven sequential, fail-fast stages without retries:
`selftest`, `smoke-fast`, `smoke-fixtures`, pinned `preflight`, `session-smoke`, `core-smoke`,
and a final pinned `preflight`. The aggregate `steps.json` links each private
sub-run. `fullPhase1Accepted: true` requires **66 exact evidence tuples**:
**10 U + 11 C + 8 B + 22 A + 15 E**. These cover **21 fast**, **eight isolated
browser** and **23 live** variants from
[`profiles/phase1-p0.ts`](../../dashboard/apps/web/regression/profiles/phase1-p0.ts),
plus no failed, blocked, skipped or flaky selected result. Missing variants are
JUnit failures, not successful omissions. Subset commands never certify this
full profile.

`smoke-fast` reuses the owning Vitest component suites, actual shared API client
and Python log-handler tests; it does not replace them with a duplicate mock
implementation. Vitest uses native config loading and an ephemeral per-invocation
cache under `/tmp`, so the container remains non-root and read-only. Python and
PyYAML are bundled for the existing backend contracts. `smoke-fixtures` loads
the production UI bundle in Chromium against entirely synthetic responses.
Neither subset logs in to or changes the appliance.

| Catalog IDs / selected parameter set | Mandatory Phase 1 proof |
|---|---|
| AUTH-01/02/06 · local administrator | Real OIDC actor/role; fresh unauthenticated browser and direct inventory reads denied; logout, reload and a new tab cannot reuse stale privilege; fresh login recovers |
| NAV-03 · core pages, dialogs, help and one polling cycle | No attempted browser write, changed saved intent, host request or new Pod merely from navigation; independent read-only Pod comparison |
| NAV-06 · isolated degraded/unknown browser data | Module, Flux and model root causes remain visible; a failed model is not Ready/100%; missing GPU memory is unknown rather than invented zero/free capacity |
| KEY-01/03 · run-owned named keys | Browser create, one-time display, no raw value after close/refresh/reload or in browser storage; exact owned-key revoke denies inference, while a separate owned key still works |
| LIFE-01/03/04/06 · one reviewed CPU/Ollama fixture | API create → current-generation Ready Pod/catalog → UI visibility; UI Stop → preserved definition and no runtime/route; separate API Start and UI Start cycles → real inference; UID-safe owned removal → API/Pod/catalog/UI absence |
| ROUTE-01/06 · Gateway/LiteLLM chat | Valid bounded chat; missing, invalid and revoked keys denied; unknown and stopped names do not silently reach a different model |
| LOG-01/05 · Ready CPU/Ollama runtime | Browser log open/refresh/close; actual non-empty owned-container text, bounded tail and no HTTP 406; subsequent ordinary JSON model read still works |
| LOG-06 · isolated browser log data | Current, previous and init streams display as inert text; HTML-like/long input cannot execute or overflow the narrow page |
| UX-02 · run-owned CPU model edit draft only | Advanced initially collapsed; unchanged/changed/reverted/invalid Save state; polling preserves the unsaved draft; cancel leaves intent unchanged |
| HAR-03 · final pinned preflight | Owned model/key resources absent, lab idle, dedicated Lease free; reviewed source/image/boot pins still match |

The exact layer expansion is reviewable independently of the workflow order:

| ID | Selected variant group | Required layers |
|---|---|---|
| AUTH-01 | `login-session` | A+E |
| AUTH-02 | `anonymous-contract`, `anonymous-api`, `anonymous-browser` | C; A; E respectively |
| AUTH-06 | `logout-browser`, `logout-session` | B; A+E respectively |
| NAV-03 | `navigation-component`, `navigation-browser`, `read-only-navigation` | U; B; A+E respectively |
| NAV-06 | `failed-status-unit`, `unknown-memory-unit`, `status-contract`, `failed-status`, `unknown-memory` | U; U; C; B; B respectively |
| LIFE-01 | `create-contract`, `api-cpu-create` | C; A+E respectively |
| LIFE-03 | `lifecycle-stop-component`, `stop-contract`, `ui-stop` | U; C; A+E respectively |
| LIFE-04 | `lifecycle-start-component`, `start-contract`, `api-start`, `ui-start` | U; C; A+E; A+E respectively |
| LIFE-06 | `remove-contract`, `owned-remove` | C; A+E respectively |
| KEY-01 | `key-create-component`, `key-create-contract`, `keys-browser-create`, `ui-key-create`, `one-time-key` | U; C; B; A+E; A+E respectively |
| KEY-03 | `key-revoke-component`, `key-revoke-contract`, `keys-browser-revoke`, `ui-key-revoke` | U; C; B; A+E respectively |
| LOG-01 | `logs-component`, `logs-contract`, `ready-runtime-logs` | U; C; A+E respectively |
| LOG-05 | `log-transport-contract`, `text-log-transport` | C; A respectively |
| LOG-06 | `logs-inert-component`, `log-sanitization-contract`, `inert-log-output` | U; C; B respectively |
| ROUTE-01 | `cpu-chat` | A+E |
| ROUTE-06 | Missing, invalid and revoked key; unknown and stopped route | A for each of the five variants |
| UX-02 | `forms-component`, `forms-browser`, `model-form-defaults` | U; B; A+E respectively |
| HAR-03 | `final-idle` | A |

This is deliberately **not** universal acceptance of any listed catalog family:
other roles and identity faults are Phase 5, wider model forms/settings and
starting/restarted/multi-Pod log variants are Phase 2, GPUs are Phase 3–4, and
host/global-setting cases are Phase 6. The isolated UI bundle comes from the
runner checkout; the live UI/API is the independently pinned appliance version.
No server deployment, global settings change, service disable or reboot is
needed. Existing active models block the smoke run. Only an explicit owner
approval can prepare the lab by pausing/restoring specific unrelated models;
the runner itself has no such mutation path.

In particular, NAV-06 live fault injection (`A` in the full catalog family)
remains a later functional-phase variant. Phase 1 accepts only its deterministic
failure/unknown `U/C/B` smoke slice. Likewise, a CPU/Ollama form or lifecycle pass
does not accept the other engines, GPU variants or roles.

Implementation status on 2026-10-02: the profile and owning tests are present;
the dated complete live acceptance is still pending. An initial read-only
preflight correctly reported `BUSY` while two unrelated vLLM definitions were
active. That result is not an accepted Phase 1 run.

The earlier reviewed local attempt, `reg-264109e5-92ff-46ac-97ca-bbb9aad1b58b`,
passed all **43 harness case-layer results** and all **six isolated browser
case-layer results** (five browser tests, including additional key-dialog and
CPU edit-draft wiring). Typechecking and the runner's production UI build passed.
The live preflight then stopped at `AUTH / login-form`: the real identity
endpoint returned HTTP 503 with an upstream connection failure, so the login
form was not available. Session/core-smoke/final-preflight stages were not run;
the aggregate explicitly remains **not accepted**. No appliance mutations were
sent and these attempt journals contain no resources. The runner was built from
local, uncommitted `develop` changes on base `a3acf6d`; do not confuse that base
revision with a published test implementation.

After the function/layer reorganization, the 2026-10-02 aggregate
`reg-7ff4e118-f0c2-402e-84a0-f2d22c327a0e` selected **75 results**:
**73 Passed, one Blocked and one Skipped**. All **43 harness**, **21 fast U/C**
and **eight required browser B** results passed in the Linux container. Both
regression/client typechecks, the production UI build, 39 documentation/site
unit checks and the strict static site build passed. The aggregate links its
sub-runs in `steps.json`; it is explicitly **not accepted** and still lacks all
**37 required live A/E tuples**.

The approved private boot pin was refreshed after independently checking the
unchanged appliance/Node UID and Ready Node. Real login and the remaining
source/image pins now verify, but live preflight blocks at **CAPABILITY**:
CPU/Ollama and NVIDIA/vLLM are available; expected AMD/Ollama and AMD/vLLM are
not. Read-only Kubernetes inspection found the AMD eligibility labels present,
`amd.com/gpu: 0`, no `amd-dra-ready` label and **no ResourceSlices**, despite a
Ready DRA driver Pod. A previously allocated shared claim remains; the existing
AMD model is Starting, while the NVIDIA model is Ready. This identifies the
missing observed AMD registration prerequisite, not its root cause.

No product intent or global setting was changed and no owned model/key runtime
was created. The two existing models were **not paused**: the read-only baseline
already failed before lab-idle preparation could allow the live workflow.
The owner approved a pause and
restore if needed, but that is not an authorization to reset driver checkpoints,
reconfigure sharing or weaken expected capabilities. Restore AMD registration
in a separately reviewed correction, then repeat the complete Phase 1 profile.
The implementation remains local, uncommitted `develop` work.

An additional existing frontend-unit-suite check was **not fully green**:
`LicensePage.test.tsx` exceeded its default five-second timeout (also when run
alone). The first complete attempt passed 272/273 tests; a single-worker attempt
passed 271/273, with both failures confined to that unchanged license test file.
No timeout or assertion was relaxed to hide this result. The separate docs/site
checks passed. Investigate that test budget separately from the blocked live
identity service before claiming a completely green broader frontend suite.

#### Phase 1 P0 live acceptance — 2026-10-04

The complete seven-stage profile passed in
`reg-2bd24d2f-74a4-4961-98e7-5d3e4733f463`: **116/116 selected case-layer
results**, including all **66 required tuples**, with
`fullPhase1Accepted: true` and no missing, failed, blocked, skipped or flaky
result. This includes real OIDC sessions, non-mutating navigation, browser key
creation/revocation, the CPU/Ollama lifecycle, separate API and browser Start
cycles, routed chat, runtime logs, denied credentials/routes, owned removal and
the final pinned clean preflight.

A separate preceding attempt, `reg-54c0ad4b-adee-49f3-b388-692bf33c8841`,
stopped at the observer preflight without product writes. Independent read-only
checks and a fresh full run passed; that earlier Blocked report is retained,
not converted to success or hidden by a test retry. The deployed source/image
pins match the Phase 0 repeat above. No server reboot, operator reconfiguration
or unrelated model change was needed. This accepts the finite CPU smoke, not
GPU lifecycles, other identity roles, or the wider frontend suite.

<a id="phase-2-p0-model-control"></a>

#### Phase 2 P0 complete CPU model control

```bash
bash tools/regression.sh build
bash tools/regression.sh phase2
```

The complete command runs eight sequential, fail-fast stages without retries:
`selftest`, `phase2-fast`, `phase2-fixtures`, pinned `preflight`,
`phase2-readonly`, `phase2-models`, `phase2-faults`, and a final pinned
`preflight`. The reviewed matrix in
[`profiles/phase2-p0.ts`](../../dashboard/apps/web/regression/profiles/phase2-p0.ts)
requires **85 exact evidence tuples: 9 U + 22 C + 11 B + 23 A + 20 E**.
Missing variants, failed/blocked/skipped/flaky results, an unclean journal or a
failed final preflight prevent `fullPhase2Accepted: true`.
`HAR-03 / final-idle` is an explicit required tuple; even an otherwise complete
model-control report cannot pass when this final clean/pinned observation is
missing.

When the canonical fail-fast run stops, the following diagnostic commands can
exercise the independent remaining cases in a new reserved lab window:

```bash
bash tools/regression.sh phase2-models ollama
bash tools/regression.sh phase2-models vllm
bash tools/regression.sh phase2-models admission
bash tools/regression.sh phase2-models memory-risk
bash tools/regression.sh phase2-models external
bash tools/regression.sh phase2-faults
bash tools/regression.sh preflight
```

These selectors are fixed, tested names, not arbitrary grep or mutation inputs.
Run them sequentially and verify cleanup and the free lab Lease before another
live run. Each command produces a separate private report; keep failed attempts
as evidence. Passing diagnostic subsets or a manually combined inventory never
turns a failed canonical run into full Phase 2 acceptance.

The finite P0 parameter set is intentionally CPU-only:

| Area | Required proof |
|---|---|
| Discovery and choices | Switch Local/External and CPU Ollama/vLLM without stale draft fields; search a reviewed Hugging Face query across pagination and preserve exact repository/artifact provenance |
| Local engines | Create one reviewed CPU Ollama and one CPU vLLM model through the browser; independently verify saved intent, current-generation runtime, catalog publication, routed inference and bounded logs |
| Edit and persistence | Save context and memory changes, reload, Stop/Start, and verify the same UID plus increasing generation; dirty/reverted/invalid form states remain correct through polling |
| Conflicts and admission | Reject stale revisions, unsupported raw settings and an explicit memory-risk request without accepting a partial model |
| Failure status | A run-owned failing Ollama reference produces at least three failed Pod restarts and the current-generation `ModelRuntimeCrashLoop` Ready condition; API and browser report Degraded with the real cause, never Ready/100 percent |
| External route | Create/edit/Stop/Start a reviewed OpenAI-compatible route, using a configured HTTPS provider or a separate run-owned CPU/Ollama provider; stopping the route must leave its provider serving |
| Cleanup | Every accepted create records namespace, name, UID and generation before further work; deletion is UID/resourceVersion fenced and verifies intent, Pods and catalog route are absent |

The private lab profile must add `phase2.ollamaModel`, `phase2.vllmModel`,
`phase2.failureModel`, `phase2.externalModel`, and `phase2.discovery` to the
complete Phase 1 profile. The positive local model fixtures must be advertised
by the deployed catalog, explicitly select KV cache settings, use a context of
at most 4096 for this bounded suite and a memory budget in 100 MiB steps. The
failure fixture includes an expected user-visible reason, uses at most 8192 MiB
RAM and a context of at most 4096. Its intentionally missing Ollama manifest
cannot supply a memory estimate, so this one fixture explicitly sends
`allowMemoryRisk: true` after checking the currently unreserved CPU capacity.
Normal model creation keeps the risk opt-in off. Admission rejection alone
cannot pass the runtime-failure test: the Pod failure, current Ready condition,
API status and visible browser cause must all agree within the existing
15-minute deadline. The discovery query
must have a reviewed second page and pin the expected repository and artifact
URL. The configured external fixture uses an HTTPS origin; an optional API key
is read from a mode-`0600` private file and is never written to reports.
Alternatively, set `externalModel.source` to `owned-ollama`, omit `model` and
`apiKeyFile`, and supply the reviewed internal KubeAI `/openai/v1` endpoint.
This mode creates a separately journaled CPU provider, performs real inference
through both names, proves the provider survives route Stop, then cleans both
definitions by UID. Plain HTTP is allowed only for this explicit mode, on a
`<service>.<namespace>.svc.cluster.local` host, port 80/default and exact
`/openai/v1` path; public HTTP, credentials, queries and alternate ports/paths
are rejected. It does not route back into LiteLLM or stop an unrelated provider.
The owned KubeAI provider uses the same non-secret `none` API-key sentinel as
the product's existing local OpenAI-compatible route; a configured provider's
real credential is never inferred or substituted.

The live suite permits only exact request bodies registered for the current
step. Estimation requests are non-mutating; persistent writes require the
appliance-scoped Lease. It never changes GPU sharing, firmware, host memory,
software channels, modules, global settings or unrelated models. GPU engines,
FreeToken, slots and DRA/time-slicing remain Phase 3–4.

A definite JSON create rejection (HTTP 400/401/403/404/409/422) is recorded as
rejected only after the independent Kubernetes reader proves that the exact
run-owned name is absent under the held Lease. The journal can resume this
no-UID terminal entry without attempting deletion. Network timeouts, 5xx,
throttling, malformed success responses, lost Lease ownership and existing
same-name objects remain ambiguous: no retry, UID adoption or name-only cleanup
is permitted. The original error remains a failing/blocked test result; a clean
journal does not convert the assertion into success.

Implementation validation on 2 October 2026 passed:

- canonical `selftest`: **45/45** selected harness results,
  `reg-2033aa9b-6f8a-4528-971e-d69e45e93c36`;
- `phase2-fast`: **31/31** U/C tuples,
  `reg-99617f80-bce2-4330-acb1-7a12ef9e8764`;
- `phase2-fixtures`: **11/11** Chromium B tuples,
  `reg-ac64b7f4-20cc-480d-876d-f741bc8df873`;
- regression TypeScript typechecking and the production web build.

Those are local implementation results from uncommitted `develop` work. The
42 required live A/E tuples and both pinned preflights were **not run**, no
test-appliance resource was changed, and full Phase 2 P0 is therefore **not
accepted**. Run `phase2-readonly`, `phase2-models`, and `phase2-faults` only in a
reserved idle lab window with a reviewed private profile; subset success never
certifies the aggregate gate.

<a id="phase-2-live-findings-2026-10-04"></a>
#### Phase 2 live findings — 2026-10-04

The canonical attempt `reg-1dfd2794-d841-494b-8b81-7f3ad6ef2d69`
stopped at live discovery and is **not accepted**. Independent diagnostic
subsets continued afterward; they do not replace that failed aggregate.
Local code was uncommitted on `develop`; the reviewed deployed source was
`0b8d48c32166501beec2f1ed7a16eacc83d8785c`, with independently checked
dashboard/API image digests and the current boot identity.

Completed positive evidence:

- `phase2-fast` `reg-f5750cd0-9317-4551-adc1-c6f60634503b`: all
  **31 U/C tuples passed**.
- `phase2-fixtures` `reg-8fa81b28-18a2-4a10-9d0b-a9c45e7c5190`: all
  **11 B tuples passed**, including actual range-slider keyboard interaction,
  numeric-field synchronization, bounds and draft reversion.
- `phase2-models` `reg-636583ed-031e-4e3b-aecd-0246b39b4d5f`: all
  **17 CPU/Ollama**, **15 CPU/vLLM** and the **one admission** mapped results
  passed. Browser create, context **and RAM** edits, dirty/invalid/reverted
  drafts, stale-revision rejection, reload, Stop/Start, same UID/increasing
  generation, saved settings, current runtime, logs and real routed inference
  were checked. GPU workflows were not run.

Blocking product findings, not infrastructure availability claims:

| Case | Observed mismatch |
|---|---|
| DISC-03 live discovery | The authenticated API returned repository/artifact URL, revision and download metadata, and browser search/pagination/selection worked. The selected revision was absent from the real dialog. The combined discovery test `reg-9ba30d81-1449-4a19-ad05-1a1c74bd3277` therefore failed all three mapped results. |
| MEM-05 API risk admission | CPU/Ollama accepted a legal memory budget below the estimate's minimum without `allowMemoryRisk`. The test recorded its UID/generation and removed that disabled definition. The runner classified this assertion as `Blocked (API)`; that does **not** mean the API was offline. CPU/vLLM has a minimum check that CPU/Ollama lacks. |
| LIFE-12 / NAV-06 live failure | `reg-f68aea07-7c4e-4c6a-a706-61a31240c65c` failed its fixed 15-minute `model-failure` deadline, with three correlated mapped results. A missing Ollama manifest caused repeated startup-probe failures, restarts and CrashLoopBackOff; the activation stayed Starting rather than reporting the observed cause as Degraded. Its UID-owned definition/runtime was removed and the Lease released. |

The ordinary serial model run stopped at MEM-05, so its external-route results
were skipped. A separately selected external attempt
`reg-a04c4e65-e268-4f3f-bdc2-2162c28558e5` also did not pass: the controlled
OpenAI-compatible provider fixture omitted the product's existing `none`
API-key sentinel. That test-fixture correction is local, not a product change;
the failed attempt is retained rather than relabelled as passed.

The run-owned invalid Ollama reference independently produced Kubernetes
startup-probe events containing `pull model manifest: file does not exist`.
Repeated container restarts and `CrashLoopBackOff` were observed while its
ModelActivation remained `Starting / WaitingForReadyReplica`, not an actionable
Degraded cause. These were narrow read-only observations of the exact owned Pod
and activation; observer permissions were not broadened.

After the fixture correction, the fresh external diagnostic
`reg-4a885605-610c-4e05-826d-31ab1e695b68` passed both ROUTE-05 A/E results.
It verified browser Create/Edit/Stop/Start, real inference before and after
Start, the same route UID through generations 1–4, and continued inference on
the separate owned provider while the external route was stopped. Both model
definitions, their runtimes/routes and the run-owned API key were removed;
all three journals had zero remaining entries.

Final read-only pinned preflight
`reg-4bc64c0a-d465-45db-a873-a1d4e65f42c3` passed all three checks. Source,
dashboard/API image and boot pins still matched, no test-owned model/Pod was
left, and the test Lease was free. The two pre-existing vLLM definitions retained
their original UIDs and generation 4, `enabled: false`, and Disabled status.
No product source, deployed image, RBAC, global setting or channel was changed
by this review, and nothing was committed or pushed.

The latest reviewed **diagnostic inventory** accounts for all **85 required
tuples: 78 Passed, 6 Failed and 1 Blocked (API)**, with no missing, skipped or
flaky tuple. This is an inventory across recorded diagnostic runs, **not a
passing canonical run**: discovery and failure each contribute three correlated
Failed results, and memory-risk admission contributes the API assertion that
the current reporter calls Blocked. `fullPhase2Accepted` remains **false**.
Correct the three product gaps, then rerun the complete canonical command;
do not dismiss them or remove their assertions to produce green acceptance.

Mapped results can share a combined test: when a prerequisite fails, later
assertions in that test are not automatically considered independently
executed. These findings do not certify every parameter variant of the broader
catalog, GPU/FreeToken/sharing workflows, or the whole frontend test suite.

<a id="phase-2-live-acceptance-2026-10-05"></a>
#### Phase 2 P0 live acceptance — 2026-10-05

Canonical repeat `reg-19887a26-0dc3-4b13-b419-7b849d247b0f` passed all
**140/140 selected results** and all **85 required evidence tuples**:
9 U, 22 C, 11 B, 23 A and 20 E. `fullPhase2Accepted: true`; all eight stages
passed, with no missing, failed, blocked, skipped or flaky result.

- Harness selftest passed 50 selected results, fast U/C passed 31, and
  isolated Chromium fixtures passed 11.
- Discovery `reg-d690b102-0223-49a5-96cc-e0a4a98a33b4` passed the three
  mapped live results, including the selected Hugging Face revision in the UI.
- CPU model control `reg-69aa2349-faf7-4aea-9650-75ef0a43f4c7` passed all
  36 mapped results: Ollama, vLLM, revision-safe parameter changes,
  Stop/Start, saved settings, inference, logs, admission/risk negatives and
  controlled external routing.
- Failure `reg-7cbbda0a-0f2f-49e7-a809-d649ff51cf68` passed LIFE-12 A/E
  and NAV-06 A. The bounded missing-manifest fixture explicitly opted into
  estimation risk, produced repeated Pod failures and a current-generation
  `ModelRuntimeCrashLoop` condition, and displayed Degraded plus its real cause
  in the browser, without Ready/100-percent success. Product RAM admission was
  not relaxed; its separate rejection/explicit-risk test also passed.
- Final preflight `reg-5cac1c0b-bdcd-48db-a973-1bcb80c34f50` passed all
  three checks. Every canonical-run journal has zero remaining entries; test
  models, Pods, catalog routes and key were removed, the lab Lease is free, and
  the two existing vLLM definitions retain their original UIDs, generation 4,
  `enabled: false` and Disabled status.

The deployed Flux revision was
`274d3ed94eb078176e9e5e5391bb6d3dcca750a8`; the pinned Web/API images derive
from `1e7e2bafe69ac4709ca40fb7fc48f33e8af9182f`. Appliance/node identity,
current boot identity and both running image digests were independently checked.
The runner used local, uncommitted test-fixture/cleanup corrections on that base;
its private `source-provenance.json` records the local image and test-diff hash
instead of presenting the changes as a published source commit. Nothing was
committed, pushed or rolled out by this acceptance run.

A preliminary interrupted diagnostic was independently recovered by its recorded
UID/generation before this clean canonical run. Its failed report, the earlier
RAM-admission-blocked failure fixture and historical product findings remain
unchanged evidence; they are not merged into this passing gate. This accepts
only the finite CPU model-control profile. GPU, FreeToken, sharing, global
settings and the wider Phase 2–8 parameter matrices remain separate gates.

`selftest` runs only synthetic harness cases: identity/capability rejection,
verified TLS, offline/busy errors, independent lease-owner CAS races, expired/lost
leases, owned UID cleanup, atomic-delete conflicts, interrupted journals,
revision-safe restoration, current-generation polling, failed/blocked reporting,
secret redaction and an actual Chromium login to a loopback fixture. This is
**not** proof of real dashboard authentication, model cleanup or GPU behavior.
There is no GitHub registration, CI schedule, model start or host operation.

For normal setup, use the [short runner guide](regression-remaining-p0.md#once).
The commands in this historical section describe the legacy diagnostic path:
`setup` starts with only the Dashboard URL and admin login, discovers the other
endpoints and obtains the account's OIDC kubeconfig through the existing API.
After explicit CA-trust and lab-grant review, it generates the separate scoped
test credentials automatically. It then asks for the selected phases, warned
installation-bound operation approvals and every required fixture, generating
local foundations where possible. Temporary self-account Kubernetes admin access,
if needed, requires `GRANT` and is restored before bootstrap. The final checked
proposal is accepted only after `ACCEPT`; missing prerequisites leave setup
incomplete with actionable measures. `all` executes the selected complete P0
phases sequentially and stops at the first failure. `setup --minimal` skips suite
forms/acceptance; `setup --manual` retains externally managed access inputs.
Standalone `prepare`/`prepare --accept` remain available. Neither discovery nor
acceptance executes tests or certifies the installed version as the intended
deployment. Real external infrastructure remains a prerequisite.

For advanced manual setup of the optional live read-only check, copy
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
HAR-04–09 **subsets**, not the full gate. The `phase0` command above adds live
mutation fencing, same-name ModelActivation replacement, CPU model/Pod/catalog
cleanup, controlled process-kill recovery and current-model-generation polling.
Borrowing actual product settings and app/GPU resource cleanup remain domain
acceptance work rather than mutations performed by the foundation profile.

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
report alone do not imply that the full Phase 0 gate passed; only the complete
`phase0` profile can set `fullPhase0Accepted`. Empty selections,
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

#### Phase 3 and 4 P0 installed GPU profiles

The local Linux runner has explicit installed GPU profiles. The shared
[acceptance matrix](../../dashboard/apps/web/regression/profiles/gpu-p0.ts)
requires every named variant at its owning layer. Component and synthetic browser
passes cannot replace real API, device-binding or inference evidence. These
profiles do not install/upgrade the appliance, publish images, reboot the host,
change firmware/network settings or clear caches.

| Selection | Implemented scope |
|---|---|
| `phase3-fast` | Existing hardware/memory/FreeToken components and API/controller contracts; bounded fixtures, ownership, concurrent journals and evidence safety |
| `phase3-fixtures` | Chromium unknown/stale hardware, separate memory/budget/slot denominators and FreeToken scheduler-node/physical-telemetry joining with numeric budget clamping; no live appliance credentials |
| `phase3-gpu` | Pinned AMD/NVIDIA inventory; exclusive Ollama/vLLM on each vendor; requested/effective cache, routed inference, UI logs and Stop/Start; FreeToken discovery, whole-GPU create/edit/Stop/Start/Restart/inference |
| `phase3-validation` | Real Hardware confirmation and Ollama/vLLM diagnostics for one NVIDIA GPU and all pinned GPUs; exact Job/Pod device binding and completed image evidence |
| `phase4-fast` | Existing sharing/slot API/controller/component contracts; native tests of the pinned AMD DRA recovery patch with isolated sysfs, checkpoints and CDI |
| `phase4-fixtures` | Exclusive defaults, dirty/reverted/cancelled forms, native disabled options, invalid counts, custom/unavailable backends and a retained draft after polling to zero free slots |
| `phase4-sharing` | NVIDIA time-slicing and AMD DRA transitions; mixed/same-engine pairs; exhaustion/release, retained drafts, own-slot edit, diagnostic consumer, last-slot race and cross-provider/CPU non-interference |
| `phase4-sharing remaining` | Fixed diagnostic subset: consumer, independence, race, reload and restoration, with its own temporary two-slot setup; never installed Phase 4 acceptance |
| `gpu-recover` | Exact baseline restoration and owned-resource cleanup for one reviewed journal; no new workloads, adoption or stale-Lease takeover |

`phase3` runs self-tests, fast contracts, browser fixtures, pinned preflight,
GPU runtimes, explicit validation and a final pinned idle preflight. `phase4`
runs self-tests, fast contracts, browser fixtures, pinned preflight, sharing/slots
and a final pinned idle preflight. They stop at the first unsuccessful stage.
Diagnostic subset reports never replace a canonical aggregate.

The Phase 4 live suite groups each provider's pair/full-slot cases together and
tests the NVIDIA last-slot race before the AMD race to reduce cold runtime-image
swaps. All device, persistence, slot and inference assertions remain unchanged;
no image or model cache is cleared. Classic owned fixture names must fit the
pinned KubeAI CRD's 40-character limit, including the durable run prefix. An
invalid fixture is rejected before a create intent is journaled, not truncated
or repaired by adopting a different resource.

Additional prerequisites beyond Phase 0:

- An idle reserved mixed AMD/NVIDIA node, exactly one physical GPU per provider.
  Pin node name/UID/boot, PCI addresses and physical device IDs independently.
  Replicated slots are not extra devices; a missing vendor is Blocked, not a
  reduced test selection.
- Both vendor settings already managed, Ready and exactly restorable through
  the product API; custom/unmanaged profiles and pending legacy validation intents
  are not adopted. Explicitly consent to temporary sharing transitions in the
  private lab profile; unrelated models/diagnostics/operations must be inactive.
- Reviewed small Ollama/vLLM fixtures per provider, a catalog-admitted FreeToken
  model, and sufficient actual storage/VRAM/RAM. Cold downloads and FreeToken
  restarts can take considerably longer than CPU smoke.
- The separate [GPU observer RBAC](../../dashboard/apps/web/regression/lab-rbac-gpu-observer.example.yaml)
  added to the existing observer. It grants only get/list/watch for ModuleActivations,
  ResourceSlices/Claims, Jobs and KubeAI Models, not Secrets/logs/exec or workload/node
  writes. Logs still use the authenticated product API.

Copy only the `gpu` object from the [public example](../../dashboard/apps/web/regression/gpu-profile.example.json)
into private `lab.json`; replace placeholders after inspection. Positive GPU
runtime fixtures are capped at 32 GiB, context at 4096 and model concurrency at
one. Negative API cases submit impossible bounds and require independent proof
that no model was created. Sharing uses
two slots. FreeToken requests one whole NVIDIA GPU, Auto strategy and distinct
settings; ordinary KV/offloading fields are prohibited. These test bounds do not
invent hardware support or replace the API's live capability/telemetry checks.

Use the smallest reviewed fixture admitted by the pinned engine and installed
catalog, not an unsupported model solely to reduce downloads. The current lab
uses already-cached Qwen2.5 0.5B fixtures for Ollama/vLLM and
`Qwen/Qwen3-VL-8B-Instruct` for FreeToken, which is listed in the
[FreeToken v0.1.3 model documentation](https://github.com/FlashML-org/FreeToken/blob/v0.1.3/docs/models.md)
and admitted by the installed catalog. The Hugging Face search derives its query
from the selected fixture rather than hardcoding a different model family.
Smaller parameter counts do not remove cold runtime-image downloads or guarantee
smaller weight downloads. Recheck live admission when changing the fixture or
engine version; do not widen production capabilities for a test.

FreeToken's scheduling capability entries need not contain `vendor` or VRAM
counters. The harness joins the selected `node:<name>` with independently
reported NVIDIA GPU samples in `computeMemory`, requiring the correct node,
engine eligibility, known telemetry and a matching FreeToken scheduler identity.
The [read-only test resolver](../../dashboard/apps/web/regression/core/freetoken-inventory.ts)
never uses cluster CPU RAM or a different node as a VRAM fallback. The
frontend clamps numeric GPU/RAM inputs to current capacity; the API separately
rejects impossible direct-create budgets. Isolated tests cover this actual
split contract and preserve explicit zero/unknown memory semantics.

```sh
bash tools/regression.sh build
bash tools/regression.sh phase3
bash tools/regression.sh phase4
# Only after reviewing the specific interrupted/failed journal:
bash tools/regression.sh gpu-recover /private/runs/reg-<uuid>/journal.json
```

Use `REGRESSION_INPUT_DIR`, `REGRESSION_PRIVATE_DIR` and the optional private
`REGRESSION_COMPOSE_OVERRIDE` for existing lab inputs/output/DNS. Never commit
those files. Execution remains unprivileged, read-only, with no Docker socket
or executable `/tmp`. The FreeToken owning preflight interprets its synthetic
temporary CLI with Python rather than weakening these protections.

**Borrowed settings:** each run durably saves initial full ModuleActivation
specs, UIDs, spec generations, provider mode/count and existing model definitions.
Only authenticated product API intents create workloads. Lease/identity checks
precede mutations; exact independently observed spec/generation checks follow.
`202 Accepted` confirms intent, not completion: node allocatable resources,
device-plugin profiles or AMD DRA slice/claim identity and Models slots must
subsequently match. A displayed historical claim name alone is not DRA binding.

Cleanup removes only UID/generation-journaled models, verifies Pod/route withdrawal,
restores full original provider specs through the same API, compares unrelated
definitions and removes keys before releasing the Lease. Explicit diagnostic
receipts can remain in ordinary product history; they are not cache cleanup.
Active diagnostics prevent backend restoration. Foreign edits, replacement,
lost Lease and ambiguous writes block automatic restoration and retain private
recovery journals. Confirmed CAS `409` retries require independent unchanged
UID/spec/generation proof; transport failures are not adopted or blindly retried.
Concurrent model admissions serialize journal writes to preserve all receipts.
Playwright replaces a worker after a failed test even without retries. Subsequent
workers keep separate private `worker-<index>/journal.json`, sharing and baseline
receipts rather than overwriting the failed worker's files. Surviving resources
or a held Lease still block the replacement; recovery always names the exact
journal. Browser readiness waits allow the real 15-second Models refresh to
converge. API readiness independently requires the current spec generation and
its observed Ready condition, not stale status after an edit or restart. Before
inference, GPU tests also require exactly one Running, Ready, non-terminating
owned Pod with the current saved context/concurrency, KV settings and restart
configuration. KubeAI replica counters alone can still reflect an old Pod during
a parameter rollout. Terminating Pods remain in the cleanup inventory; they are
not silently filtered away to claim completed convergence.

The native recovery binary uses the same upstream commit/patch as
`build-amd-dra-image.yml` and a pinned Go builder. BOOT-04 U/C checks physical
identity through DRM renumbering and recreated CDI. BOOT-05 U/C checks stale,
legacy and malformed checkpoints, missing/replaced hardware, quarantine,
multiple consumers and cleanup without clearing checkpoints. All files are
isolated fixtures, never a live checkpoint or device.

The installed Phase 4 gate is `installedPhase4Accepted`. It does not certify
maintenance: `fullPhase4Accepted` stays false and BOOT-04 live driver restart/CDI
recovery is a separately authorized gate. Intel acceptance remains deferred.
Keep local source/container checks, deployed source/image pins and genuine live
acceptance separate.

<a id="phase-4-installed-acceptance-2026-10-05"></a>
#### Phase 4 P0 installed-sharing acceptance — 2026-10-05

The corrected canonical run `reg-5a2457ea-b62e-41ab-85eb-2b629ae63138`
passed **154/154 selected results**, all **71 required U/C/B/A/E/O tuples**
across 23 variants, all six stages and the final pinned idle preflight.
There were no failed, blocked, skipped, missing or flaky results;
`installedPhase4Accepted: true`. This is one complete run, not an aggregate of
earlier partial attempts.

Real AMD DRA and NVIDIA time-slicing transitions, mixed-engine and same-engine
inference, full/released slots, retained browser drafts, own-slot edits, a real
diagnostic Job as an additional consumer, last-slot races, provider/CPU
non-interference and persisted reload all passed. The live sharing child was
`reg-1626ea71-990a-4ff4-a6fd-1131b4917e5a`; the final preflight was
`reg-a54aaa59-c18c-4b9a-ac99-b949bda4bd02`.

A separate read-only audit confirmed the same pinned node/boot identity, an idle
Lease, a clean ownership journal, no remaining run-owned Pods, unchanged original
model definitions and exact restoration of the original sharing specifications.
NVIDIA's restored backend advertised five slots and five replicas; AMD's original
four-slot configuration was restored. No foreign model or cache was deleted.
Cold runtime-image downloads were observed separately from model readiness.

The runner changes remain local and uncommitted; the local Linux image and the
appliance's deployed source/image/boot pins are separate evidence. No product
image was published or appliance rollout performed by this acceptance run.
`fullPhase4Accepted` remains **false**: live BOOT-04 driver restart/CDI recovery
still needs a separately authorized maintenance window. Intel remains deferred.
The earlier overlong KubeAI model-name admission/status finding also remains open;
shortening a test fixture did not fix that product behavior.

#### Phase 3 and 4 implementation review (2026-10-05)

The installed profiles above are implemented locally. Phase 4's complete
installed-sharing run is accepted above; Phase 3's corrected complete live repeat
is still pending. TypeScript checks, the strict handbook
build and 39 documentation/website tests passed. The owning component/API suites,
synthetic Chromium cases and native AMD checkpoint/CDI tests passed in the Linux
runner. Full-profile reports additionally require all live tuples and final
pinned idle preflight, not just those isolated checks.

The latest isolated profiles include the current-runtime readiness regression
and the fixture name-admission and diagnostic-selection guards: Phase 3 fast
passed 60/60 results (`reg-0b6147ed-86cb-4ca7-8539-5922bfe7da46`), and Phase 4
fast passed 45/45 (`reg-d8d36e7d-7bd9-4ed3-a99e-8eeb3e1ff324`). These are fixture/owning-layer
results, not substitutes for a complete installed acceptance run.

Earlier live attempts are retained, not relabelled:

- The new sharing adapter initially expected HTTP `200`; the existing product
  accepts sharing and verification intents with `202`. The adapter now verifies
  acceptance separately from independently observed backend completion. An
  accepted write with an ambiguous local receipt was reviewed explicitly before
  recovery; routine recovery still refuses automatic adoption.
- AMD's exclusive DTO can retain a historical shared-claim name. Exclusive
  acceptance now checks actual `amd.com/gpu` registration and effective mode,
  not disappearance of a diagnostic name. DRA acceptance still requires the
  actual current physical claim/slice and runtime binding.
- The first AMD Ollama runtime reached Ready with real GPU binding, but the
  new test had not opened the separate LiteLLM SSO route. A fresh dashboard
  session's inference read returned `302` to identity, not model JSON. The GPU
  fixture now follows the same real SSO preparation as the accepted CPU flow,
  before creating a key or borrowing settings. Redirect/transport/schema
  diagnostics are bounded categories, not saved response bodies or credentials.
- Explicit inference failures now retain a `Failed` outcome through Playwright
  Error serialization instead of being misclassified as infrastructure Blocked.
- The corrected Phase 3 attempt reached real inference on AMD/Ollama,
  AMD/vLLM and NVIDIA/Ollama. Its NVIDIA browser assertion raced the 15-second
  Models refresh with a 5-second deadline; the subsequent replacement worker
  also refused to overwrite existing private receipts. UI convergence now has
  an explicit bounded wait, and replacement workers preserve separate journals.
  This attempt remains failed, not a complete runtime acceptance.
- The subsequent attempt used an ambiguous `Ready` text locator (both the
  status badge and progress caption match). It was stopped after the first
  real AMD inference pass and all worker receipts were restored/removed. The
  wait now targets the unique accessible `Ready: 100%` progressbar; an isolated
  Chromium test reproduces the duplicate labels and the delayed Models poll.
  Replacement workers also establish their own exclusive backend after the
  previous worker has restored the original settings.
- The next canonical Phase 3 run `reg-52952552-c12f-4e66-bb51-a02e10768db5`
  passed all four complete classic GPU combinations (AMD/NVIDIA with Ollama and
  vLLM), including inference, logs and browser Stop/Start. FreeToken was blocked
  before model creation because the new test required an absent optional
  `engineAvailability.FreeToken.available: false` field on the AMD target and
  expected VRAM in the scheduler catalog. The product instead excludes FreeToken
  through the target's engine list and publishes live VRAM separately. The test
  now joins that actual split contract and checks frontend clamping separately
  from API rejection. All worker-owned resources were removed and both original
  provider specs restored. This failed aggregate remains retained; corrected
  FreeToken and verification live acceptance are still required.

- The next canonical Phase 4 attempt
  `reg-7c56fb41-ded7-45f0-8d04-dabd0f71d30e` passed both provider transitions
  and real mixed/same-engine pairs on AMD and NVIDIA. Its aggregate had 122
  Passed, eight Failed and 17 Skipped results. The grouped AMD full-slot/edit
  scenario exposed an incorrect test-adapter receipt: model `PUT` returns the
  changed `ModelActivation` directly, whereas lifecycle `POST` wraps it in
  `activation`. The product saved the requested context change, but the test
  failed before recording its new generation. The helper and FreeToken browser
  edit now validate the direct receipt, same UID/name, exact next generation,
  requested context and unchanged enabled state. A focused owning helper/journal
  regression rejects the wrong envelope and altered identities/generations.
  The corrected isolated Phase 4 fast profile passed 42/42 results
  (`reg-506c4fd8-47a3-4e0b-b857-d1a663735632`).
- Recovery of that failed run required explicit review of the complete expected
  model spec and the pinned appliance/node/boot/source/images before recording
  the one acknowledged context change. Routine recovery still does not adopt
  an ambiguous write or take over an expired Lease. An initial recovery failed
  cleanup (`reg-c45fbdd0-6542-4226-847d-b125c8136062`); a subsequent reviewed
  retry passed HAR-07/HAR-08
  (`reg-7c1e0691-c0ff-4562-ae1e-a94497a649af`), removed all journal-owned
  models/key and restored both exact original provider specs. These failed
  reports are retained; neither retry converts them into an accepted Phase 4
  aggregate.
- The subsequent canonical Phase 4 run
  `reg-9fb5c1a7-de0f-47dd-8cf9-cd3bca0a5b92` passed the corrected direct edit
  receipt but failed actual AMD/Ollama inference after that edit with HTTP 502.
  Aggregate: 123 Passed, eight Failed, 17 Skipped. The saved generation was 2;
  the private bounded log snapshot showed four startup Pods with the same new
  template hash, three already terminating and none Ready. This is not evidence
  of a changed template on every reconcile or a persistent memory failure. The
  harness had accepted old replica readiness before the current Pod converged.
  It now observes the current Pod/configuration as described above, with a
  targeted regression for old context, terminating replicas and stale restart
  configuration. Inference failures are still failures, not automatically
  retried. All own resources were removed normally, both original sharing specs
  restored, original model definitions unchanged and the Lease independently
  observed idle. The failed aggregate remains retained; a complete corrected
  repeat is required.
- The next canonical run `reg-a6e08bdb-6613-41fa-8b26-e344fdd50e64`
  passed both full-slot/edit/Stop/Start scenarios, including actual inference
  with the changed context on AMD and NVIDIA. Aggregate: 140 Passed, one Failed,
  eight Skipped. The SLOT-03 fixture generated a 42-character KubeAI model name;
  the installed `models.kubeai.org` CRD explicitly requires
  `size(self.metadata.name) <= 40`. The product API accepted the activation,
  but the controller's KubeAI apply returned HTTP 422 before publishing model
  status. The harness now uses a shorter valid name and rejects overlong
  classic fixture names before recording a create intent. This does not change
  product naming policy or count that failed fixture as a pass. Missing API
  validation/actionable status for overlong KubeAI names is a separate product
  finding; no product fix or rollout is claimed by this runner correction.
- The following fixed diagnostic subset,
  `reg-c3b2dd62-4214-44ad-b4a7-109f614b1ad0`, passed all nine executed live
  case/layer results: a real verification consumer, provider/CPU independence,
  both last-slot races, reload and exact restoration. An independent read
  confirmed no owned Pods, a clean journal, idle Lease, unchanged original
  model definitions and restored full provider specs. Its aggregate remains
  **Not accepted**: the runner image used for that attempt still required IDs
  outside the selected subset. The launcher/reporter now use one guarded ID
  selector, with isolated tests proving that a diagnostic subset cannot certify
  canonical Phase 4. The retained report is not relabelled, nor is its partial
  live evidence combined with previous attempts to claim full acceptance.

The preceding Phase 4 attempt `reg-f92221e8-336e-47b7-8198-d25c4e61bcd4`
passed its isolated stages, pinned preflight and both actual provider transitions,
then stopped at the first pair's inference gate. Its live child
`reg-23c2c1d9-e2fa-4ccf-9e08-b33b148705cf` restored full original provider
specs and removed its owned model/key. It is **not accepted**; skipped pair,
exhaustion, race and independence variants are not passes. A corrected canonical
repeat is required. Existing disabled model definitions remain unchanged and
caches are not cleared; ordinary model starts may add downloaded artifacts or
aliases. Optional verification receipts can remain ordinary product history.

### Phase 5–8 P0 implementation

The remaining installed-appliance P0 profiles now have a finite executable
matrix: **99 domain cases / 321 domain layer/environment tuples** across Phase 5
(42/138), Phase 6 (39/123), Phase 7 (12/42) and Phase 8 (6/18), plus one required
`HAR-03 / final-idle` live tuple per canonical phase.
See the [Phase 5–8 runner guide](regression-remaining-p0.md) for commands,
private examples, cleanup authority and prerequisites. Missing lab fixtures or
approval are blocking results, not successful skips. Full-phase flags require
every exact tuple and a final clean pinned preflight; local fixtures and
diagnostic subsets do not establish live acceptance.

Implementation follows the agreed workflow: short local checks now; the lab
owner executes long live suites and provides their results. No testserver
mutation, source publication or rollout is implied by this implementation.
Physical Phase 6 cases run one approved current-boot plan at a time; no silent
boot/source re-pinning or manual aggregation into full acceptance. Existing
dated Phase 0–4 evidence above remains unchanged.

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
After adding `model-edit`, the original `smoke` mode passed again on 2026-10-02
(`reg-87f7ce88-5b7b-4bc1-8941-a24b751d30e4`, 5/5); its cleanup plan had
zero remaining entries, and a subsequent read-only preflight passed HAR-01–03
(`reg-3e8a318c-f897-42e8-9a30-b4c0912b4d36`).

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

### Opt-in CPU model-edit subset

`model-edit` extends the same run-owned CPU/Ollama fixture and safety boundary
as `smoke`. In addition to creation, logs, authenticated routed inference,
Stop, Start and cleanup, it exercises the real browser edit form: unchanged,
reverted and invalid values stay unsaved through polling; a valid context-size
change is saved and reconciled into a new Ready runtime; and a stale spec
revision is rejected with HTTP 409. In this mode both Stop and Start use the
browser. The test records every new owned generation before further mutation
or cleanup.

```bash
bash tools/regression.sh model-edit
```

The selected 2026-10-02 live run `reg-89336e71-73a4-4cac-8601-e2410a6e5ed7`
passed 8/8 cases against the test appliance on `develop` revision
`a3acf6d81a63ce18601291878bc7044eb2e857f8`. The Linux runner was built
from local uncommitted test changes based on that revision. Its private
cleanup plan had zero remaining entries, and the subsequent read-only preflight
passed HAR-01–03 (`reg-91ef3597-bb27-45eb-9245-1e8d2359ab2b`). Prior
attempts found and fixed regression-harness request-fence and CSRF issues; the
first interrupted attempt was recovered through its ownership journal. This is
not a first-pass result or acceptance of the full functional profile. vLLM,
external providers, GPU settings and the remaining edit/parameter variants
are still open.

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
  The optional license-baseline diagnostic is such a boundary: a distinct
  get/patch grant for only `identity-system/Secret/magicstick-license`, used with
  exact UID/resourceVersion/data tests to remove/restore only its document. It
  does not broaden the observer, delete installation identity or modify trust.
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
It reuses the locked workspace and shared DTOs/client. Narrowly fenced live
API-key and model adapters and CPU/Ollama lifecycle/edit fixtures are
implemented; app/identity adapters and later domain specs remain to be
implemented. Keep them outside the existing fixture suite's automatic
discovery.

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

- [x] Phase 0 P0: harness and lab contract accepted; repeat passed 2026-10-04.
- [x] Phase 1 P0: finite CPU/Ollama installed-appliance smoke accepted 2026-10-04.
- [x] Phase 2 P0: finite CPU model control/forms and external routing accepted 2026-10-05.
- [ ] Phase 3: exclusive engine/GPU matrix accepted for available hardware.
- [x] Phase 4 installed P0: sharing/slots/mixed-vendor regressions accepted 2026-10-05; live driver restart/CDI maintenance remains separate.
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

## 12. Initial implementation slice

The finite Phase 1 P0 profile above uses one small CPU model through the product
API, real routed inference, UI card/log/Stop checks, separate API and browser
Start cycles and owned-resource removal. It also covers real sessions,
non-mutating navigation, UI API-key management and edit-draft defaults without
saving a model edit. Phase 2 now implements the finite CPU Ollama/vLLM,
discovery, editing, failure-state and external-route matrix described above.
Its U/C/B layers pass locally; that implementation is not full Phase 2
acceptance until all A/E variants and final clean pinned preflight pass.
The journal and failure cleanup precede any wider matrix. These selected
subsets validate the shared API/UI test approach without depending on GPU
sharing, Azure quotas or another installation; they do not accept the
remaining phase gates.
