# Installed-appliance regression test case catalog

Design baseline: 1 October 2026. Read the
[test concept](regression-test-concept.md) for scope, profiles, ownership,
authentication, evidence, cleanup and implementation phases.

## How to use this catalog

Unmapped cases below remain **Planned**. The Phase 0 ledger distinguishes
implemented isolated harness checks from live acceptance. Related existing tests
are not automatically live acceptance. Implement and link cases incrementally in the
[implementation ledger](#implementation-ledger); execution outcomes belong to
dated run reports, not to an undated green mark here.

On narrow screens, scroll each case table horizontally to read all columns.

Each row defines an action and its required observable outcome. The concept's
shared setup/cleanup applies to every row. During implementation expand it into
an executable fixture with explicit preconditions, data, steps, independent
assertions, deadline and failure teardown. Case IDs remain stable.

- Layers: `U` unit/component, `C` contract/render, `B` fixture browser, `A` live
  API/integration, `E` live browser plus independent observations, `O` approved
  operational test, `N` non-functional. `+` means complementary checks are needed.
- Gates: priority (`P0`, `P1`, `P2`) and proposed profile. Fast `U/C/B` checks run
  without a lab even when their live counterpart belongs to a later profile.
- Executable specs are named by function and layer, not phase. The
  [file/evidence policy](regression-test-concept.md#file-names-selection-and-evidence)
  and [Phase 1 matrix](../../dashboard/apps/web/regression/profiles/phase1-p0.ts)
  keep phase, priority, variant and layer explicit. A family row is not fully
  accepted just because one scoped smoke variant passed.
- Expand engine/vendor/role/app parameters from the
  [matrix](regression-test-concept.md#5-engine-and-hardware-matrix) and source
  catalogs. One row can produce several reported test instances. Do not report a
  single CPU pass as a pass for every GPU variant.
- `maintenance`, `sharing`, license/provider replacement and fault injection
  need the concept's explicit safety gates. Environment absence is Blocked when
  required, not Passed. Optional unselected cases are Skipped with a reason.

## 1. Harness and lab safety

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| HAR-01 | Resolve the configured hosts and verify TLS with the approved CA. Wrong host, untrusted certificate or unexpected appliance identity aborts before mutation. | C+A | P0 · smoke |
| HAR-02 | Compare Node UID, boot ID, engine/GPU capabilities and critical deployed image/source revisions with the requested lab profile. Missing expected hardware cannot silently shrink the matrix. | C+A | P0 · smoke |
| HAR-03 | Observe an offline API/host, pending maintenance or unrelated busy workloads at preflight. Report Blocked with a reason; do not reboot, delete workloads or force a lock. | U+C+A | P0 · smoke |
| HAR-04 | Start two mutation runs against the same appliance from independent runner contexts. Only the lock owner proceeds; a lost heartbeat/lease prevents new mutations. | U+A | P0 · functional |
| HAR-05 | Create a run-owned resource and record its name/UID before subsequent work. On teardown remove only journal-owned resources, preserving a same-prefix but different-UID resource. | U+A | P0 · smoke |
| HAR-06 | Fail a test after model/key/app creation. Collect safe evidence, then clean up Pods, intent, routes, allocations and keys without hiding the original error. | U+A | P0 · functional |
| HAR-07 | Interrupt the runner and resume its cleanup journal. Ambiguous requests are inspected before retry; orphaned ownership or cleanup failure remains visible. | U+A | P0 · functional |
| HAR-08 | Change a borrowed global setting, then simulate an intervening human revision. Restoration must not overwrite that revision; report the remaining difference for review. | U+C+A | P0 · sharing |
| HAR-09 | Exercise stage deadlines and polling with delayed status/generation updates. Old Ready state is not accepted for a new intent; failure includes the stalled stage. | U+C+A | P0 · smoke |
| HAR-10 | Generate a report with failed, blocked, skipped, unimplemented and retry-passed cases. Required gaps cannot yield a green profile or a successful empty run. | U+C | P0 · fast |
| HAR-11 | Seed synthetic credentials into fixture headers, dialogs, logs and auth state. Public/sanitized artifacts omit them; raw live state is restricted and deleted by policy. | U+C+B | P0 · fast |

## 2. Authentication, sessions and role boundaries

Repeat role checks for administrator, operator, viewer and an ordinary identity
without dashboard-management grants. Follow the current shared role contract.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| AUTH-01 | Complete a real local OIDC login and reach the dashboard at the intended route. `/api/session` identifies the correct actor and effective roles. | A+E | P0 · smoke |
| AUTH-02 | Open a protected dashboard/API route without login. Browser enters the expected login flow; direct unauthenticated API access reveals no inventory or mutating capability. | C+A+E | P0 · smoke |
| AUTH-03 | Use expired/invalid tokens, an untrusted client/audience and malformed authorization. API denies access without trusting client-supplied identity/role headers. | U+C+A | P0 · identity |
| AUTH-04 | Test every mutation family with viewer/ordinary-user sessions and direct API requests, not only hidden controls. Model/module/app operations follow role policy; all administrator-only operations are denied. | C+A+E | P0 · identity |
| AUTH-05 | Omit or forge browser CSRF/origin headers on cookie-authenticated mutations. Reject without saved intent; valid same-origin and supported terminal Bearer requests still work. | U+C+A | P0 · identity |
| AUTH-06 | Log out and revisit/reload a protected page with old session state. No stale privileged content/action is treated as authenticated. | B+A+E | P0 · smoke |
| AUTH-07 | Expire a session while a form/log dialog is open. Show a clear sign-in state, stop unauthorized polling/mutations, and recover after login without false success. | B+E | P1 · functional |
| AUTH-08 | Revoke/change a role and refresh authorization through the normal session lifecycle. Previously visible controls cannot bypass current backend checks. | U+A+E | P0 · identity |
| AUTH-09 | Open the setup-to-dashboard handoff with stale browser state; reload and use a new tab/context. No redirect loop, blank screen or persistent protocol failure; recovery link remains usable. | C+B+E | P1 · functional |
| AUTH-10 | Simulate Keycloak/API unavailability. Distinguish authentication service failure from bad credentials; do not allow cached privilege or an unauthenticated fallback. | U+C+B | P0 · fast |

## 3. Navigation, Overview and System Status

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| NAV-01 | Visit every primary page and Settings/System subtab allowed to each role. Models precedes Services, Mesh is below API Access, and restricted direct hashes cannot mount privileged controls. | B+E | P1 · smoke |
| NAV-02 | Reload/deep-link, use Back/Forward and test legacy Settings/Network/Updates/Mesh hashes. Resolve to the canonical page without losing the authorized session. | U+B+E | P1 · functional |
| NAV-03 | Merely open pages, accordions, dialogs and help, then wait through refresh. No model, module, host operation, Wi-Fi scan or validation workload is started. | U+B+A+E | P0 · smoke |
| NAV-04 | Create/stop/remove run-owned objects through API. Overview counts/attention items converge to actual intent and runtime state, including errors and removal in progress. | U+A+E | P1 · functional |
| NAV-05 | Compare module/instance local, public and direct links with discovered route/status metadata. Open/copy uses the correct hostname and excludes private in-cluster-only endpoints. | C+A+E | P1 · functional |
| NAV-06 | Show failed Flux/module/model/Pod states and unknown or stale telemetry. Preserve actionable component messages instead of false Ready or invented values. | U+C+B+A | P0 · smoke |
| NAV-07 | Inspect CPU-only and mixed-vendor status fixtures. All GPU providers show their own version, driver mode, ownership and readiness; NotRequired is not Degraded. | U+C+B | P1 · fast |
| NAV-08 | Return timeout, malformed response and HTTP 4xx/5xx for page requests. Keep navigation usable with a retry/error state and no uncaught blank screen. | U+C+B | P1 · fast |

## 4. Services and module lifecycle

Use the deployed module catalog, including static platform cards, shared runtimes,
vendor operators and application parents. Never disable Basis, identity or the
dashboard to test a normal Services action.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| MOD-01 | Compare Services with the module catalog: names, groups, aliases, order, dependency reasons, parameters and actions. No parallel hardcoded inventory hides an entry. | C+B+A+E | P1 · functional |
| MOD-02 | Switch Applications/AI Runtime/Platform filters and expand technical sections. Expansion survives polling; static modules never offer Enable/Disable. | U+B+E | P1 · functional |
| MOD-03 | Enable an approved disposable optional module through UI; observe `ModuleActivation`, required dependencies, Flux/controller conditions and an actual usable service. | A+E | P0 · functional |
| MOD-04 | Disable that module via API; observe teardown and Disabled in UI. Preserve dependent user data per module contract and restore any borrowed baseline. | A+E | P0 · functional |
| MOD-05 | Repeat an in-progress action and conflicting/stale configuration write. Avoid duplicate intent/workloads; conflict or progress is clear and refreshable. | U+C+A+B | P1 · functional |
| MOD-06 | Apply valid/invalid module parameters and a generic AMD profile change. Validate catalog-owned fields, persist/reload, and preserve separately configured GPU sharing. | U+C+A+E | P0 · functional |
| MOD-07 | Start a local CPU model with KubeAI initially unavailable in an isolated profile. Required runtime enables on demand, without enabling NVIDIA/AMD operators for CPU. | U+A | P1 · functional |
| MOD-08 | Manually disable a GPU provider in an approved lab and reconcile discovery. Respect manual ownership; do not silently re-enable it. Restore it explicitly afterward. | U+C+O | P1 · maintenance |
| MOD-09 | Break a module fixture's dependency/admission/health state. UI exposes Installing/Waiting/Degraded with the relevant cause; a chart applied successfully is not service acceptance. | U+C+B | P0 · fast |
| MOD-10 | Open supported Credentials as operator/admin, close it, then try as viewer. Fixed-source credentials have no-store behavior and no leakage into routine lists/artifacts; unauthorized access is denied. | U+C+A+E | P0 · identity |

## 5. Application instances and basic application operation

Parameterize the lifecycle across current app-catalog types: OpenClaw, Hermes,
Paperclip, KubeOpenCode and Odysseus. AnythingLLM has a module/service probe,
not an invented `AppInstance` type. Every catalog addition needs a reviewed
adapter/functional probe before it can count as covered.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| APP-01 | Open global Create Instance and each parent's New Instance. Show catalog types/dependency reasons and only the selected application's fields; cancellation creates nothing. | U+C+B+E | P1 · functional |
| APP-02 | Submit an instance through UI, observe `AppInstance`, its owned HelmRelease/native objects and Ready endpoints, then verify the same values through API. | A+E | P0 · functional |
| APP-03 | Create a second differently named instance via API. Show it only beneath the correct parent, with independent URL/status/removal and persistent expansion state. | U+A+E | P1 · functional |
| APP-04 | Validate missing/invalid/duplicate names and app parameters, including derived hostname limits. Reject without partially created intent, credentials or routes. | U+C+A+B | P1 · functional |
| APP-05 | Compare local/public exposure and `<name>.<type>.<domain>` routing. Only selected exposure is advertised; services remain internal and routes are operator-owned. | C+A+E | P0 · functional |
| APP-06 | Reach each app through shared SSO and run its smallest meaningful catalog-model operation. Correct model/provider used; no unexpected second app login or public provider fallback. | A+E | P0 · functional |
| APP-07 | Open instance credentials where supported. Confirm authorization, no-store/redaction and clearing on close; unsupported apps do not pretend to expose credentials. | U+C+A+E | P0 · identity |
| APP-08 | Create a Paperclip instance with reviewed default model, sandbox count and optional existing OpenClaw/Hermes gateway. Persist only selected execution options; missing selected gateway blocks submission. | U+C+A+E | P1 · functional |
| APP-09 | Change the ready/default model catalog and restart a run-owned consumer when required by its contract. Generated OpenClaw/Hermes/KubeOpenCode/Paperclip configs and context/output limits update correctly. | U+C+A | P0 · functional |
| APP-10 | Remove a run-owned instance, including one still starting/failed. Owned chart/resources/routes are removed; other instances and shared model/identity resources remain. | U+A+E | P0 · functional |
| APP-11 | Return Helm/admission/image/readiness failure. Show the real instance error rather than Ready on request acceptance; failed instance remains inspectable/removable. | U+C+B+A | P1 · functional |
| APP-12 | Stream a model response through a streaming-enabled application route. Gateway does not truncate it using a normal bounded request timeout; SSO callbacks remain bounded. | C+A | P1 · functional |

## 6. Instance access, sharing and My Applications

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| ACL-01 | Create an instance with default shared SSO access. Authorized identities can open it; unauthenticated clients cannot, including direct/local/public routes. | C+A+E | P0 · identity |
| ACL-02 | Set supported minimum roles and user/group grants/denials using disposable principals. Gateway decisions and My Applications list match the effective ACL, not just UI visibility. | U+C+A+E | P0 · identity |
| ACL-03 | Refresh/change ACL with its current revision and then submit a stale revision. Persist the current change; reject the stale overwrite with a recoverable conflict. | U+C+A+E | P1 · identity |
| ACL-04 | Choose Public without login explicitly, inspect its warning and verify only that instance becomes public. Canceling does not change access; restore SSO afterward. | U+C+A+E | P0 · identity |
| ACL-05 | Search/page users and groups for sharing. Empty/stale principal selections, duplicate grants and unsupported roles are handled deterministically without exposing credentials. | U+C+B+A | P1 · identity |
| ACL-06 | Try another instance's ACL/credentials with an unprivileged actor. Deny cross-instance access; a license entitlement never substitutes for authorization. | U+C+A | P0 · identity |
| ACL-07 | Revoke a grant or delete an instance, then revisit My Applications and its route. No stale accessible link or unauthorized cached success remains. | A+E | P1 · identity |

## 7. Model discovery and creation choices

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| DISC-01 | Open Create and switch Local/External, engine and target. Offer only current catalog/capability options with meaningful unavailable reasons; switching clears incompatible drafts. | U+C+B+E | P0 · functional |
| DISC-02 | Compare tested presets/artifacts with selected engine/target. Apply their reference, precision, context/concurrency and budgets; legacy missing artifact uses its catalog default. | U+C+A+E | P1 · functional |
| DISC-03 | Search Hugging Face by text/family, load another page and select an artifact. Keep selection and show provenance/revision/context/download size; no disappearing search result/form. | U+C+B+A+E | P0 · functional |
| DISC-04 | Use controlled HF results containing gated/private/disabled, GGUF/MLX, adapter/merge and unrelated quantization entries. Respect the exact engine's discovery policy and direct relationship rules. | U+C+B | P0 · fast |
| DISC-05 | Resolve nested `text_config` and a directly related quantization without its own context metadata. Inherit and label the base limit correctly; a user-edited context remains editable. | U+C+B | P1 · fast |
| DISC-06 | Search Ollama Library, select a tag and load popular/family choices. Show advertised context/download size; reject cloud-only tags and do not reinterpret HF references as registry imports. | U+C+B+A+E | P1 · functional |
| DISC-07 | Use a valid direct `hf://` or `ollama://` reference in the appropriate engine. Persist it; reject malformed/reference-engine mismatches without invented upstream flags. | U+C+A+B | P1 · functional |
| DISC-09 | Simulate empty results, minimum-query length, slow/out-of-order requests, offline/rate-limited upstream and adapter parse failure. Preserve the form and offer honest error/preset/direct fallback. | U+C+B | P1 · fast |
| DISC-10 | Select dynamic models and inspect their initial context and max sequences. Metadata-derived values and default concurrency of one apply; experimental discovery is not labelled validated inference. | U+C+B | P1 · fast |

## 8. Shared model lifecycle, editing and persistence

Repeat positive local lifecycle cases for every supported engine/target fixture.
External lifecycle means route activation, not remote process control. Restart
is tested where exposed (Realtime), not invented for every card.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| LIFE-01 | Create a local model via API and wait through intent, owned Pod/device, health, catalog and routed inference. UI displays this same ready activation/configuration. | A+E | P0 · smoke/gpu |
| LIFE-02 | Create through each engine's browser form; independently inspect saved engine-specific intent and infer through LiteLLM. UI success alone is insufficient. | B+A+E | P0 · functional/gpu |
| LIFE-03 | Stop an active managed model from UI. Keep identity/settings, withdraw route, remove runtime and release slots only after termination; external provider itself stays running. | U+A+E | P0 · smoke/gpu |
| LIFE-04 | Start the stopped model through API and then through UI in a separate run. Reuse saved settings, recheck admission, publish only after readiness and infer again. | U+A+E | P0 · smoke/gpu |
| LIFE-05 | Restart an eligible active Realtime model. Replace only its runtime with the same intent; observe a new Pod revision and successful recovered route/inference. | U+A+E | P1 · gpu/realtime |
| LIFE-06 | Remove a ready/starting/stopped/degraded managed activation. Its owned runtime/route/allocation disappears; catalog-only rows remain read-only and unrelated objects survive. | U+C+A+E | P0 · functional |
| LIFE-07 | Edit parameters without changing name, namespace, engine, hardware or model reference. Own existing reservation is not counted twice; saved intent, replacement configuration and inference match. | U+C+A+E | P0 · functional/gpu |
| LIFE-08 | Open unchanged form, change/revert a field, enter invalid data and wait through polling. Save is enabled only for a valid actual change; dirty input/focus/slider is preserved. | U+B+E | P0 · functional |
| LIFE-09 | Save a stale edit against a concurrent spec change or recreated same-name model. Reject by revision/identity; a status-only update does not invalidate the unchanged spec. | U+C+A+E | P0 · functional |
| LIFE-10 | Double-click/repeat Start/Stop/Remove during transitions; lose a response after acceptance. Prevent contradictory duplicate mutations and inspect intent before retry. | U+C+A+B | P1 · functional |
| LIFE-11 | Prevent Pod creation in an isolated admission fixture. WaitingForPod becomes actionable Degraded/ModelPodCreationStalled after its bounded deadline; recovery resumes when the Pod can exist. | U+C+A | P0 · functional |
| LIFE-12 | Exercise image pull, download, scheduling, OOM, load and failed-Pod recovery fixtures. Show the real stage/cause, bounded recovery attempts and no misleading Ready/100-percent progress. | U+C+B+A | P0 · functional |
| LIFE-13 | Save/Stop, reload dashboard and restart API/controller in an approved isolated environment. Desired settings survive; restarting the browser cannot recreate stopped models. | U+C+A+E | P0 · functional |
| LIFE-14 | Remove the automatically enabled local runtime only when no local model depends on it. Reject unsafe removal and preserve manually owned modules or external model routes. | U+C+A+E | P1 · functional |

## 9. vLLM and Ollama runtime settings

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| ENG-01 | Run the full positive Ollama/vLLM lifecycle on CPU, NVIDIA and eligible AMD profiles. Placement/resource requests and actual inference confirm the selected engine/target. | C+A | P0 · functional/gpu |
| ENG-02 | Create Ollama with source tag differing from activation name. Keep Starting until download/alias repair finishes; the published name answers inference without model-not-found. | U+C+A | P0 · functional |
| ENG-03 | Select each catalog-supported KV precision and inspect desired versus applied Pod settings. KV active remains pending until the requested configuration is Ready; CPU/Intel do not offer unsupported FP8. | U+C+A+E | P0 · functional/gpu |
| ENG-04 | Change context, output tokens and maximum sequences independently. Validate advertised bounds, recalculate estimates, persist values and apply runtime/consumer limits. | U+C+A+E | P1 · functional |
| ENG-05 | Change CPU reservation/limit, use limit zero and reset to automatic. Preserve memory/model identity; CPU limits/requests and default removal match the shared catalog contract. | U+C+A+E | P1 · functional |
| ENG-06 | Enable NVIDIA CPU offloading for vLLM and Ollama with reviewed budgets. Persist separate host/GPU budgets and Pod RAM requests; vLLM offloads weights, not KV; Ollama reports placement honestly. | U+C+A+E | P1 · gpu |
| ENG-07 | Switch target/engine with offloading or AMD vision settings in a draft. Incompatible options are removed rather than leaking into another engine/profile; editing CPU only leaves other settings intact. | U+C+B | P0 · fast |
| ENG-08 | Select catalog AMD vision-attention options and explicit Auto versus omitted setting. Render the exact reviewed mapping, retain it on edit and infer a compatible vision fixture in the optional live variant. | U+C+A+E | P1 · gpu |
| ENG-09 | Load old saved local objects without optional KV/artifact/CPU/offload fields. Resolve compatible defaults without rewriting unrelated settings or silently changing the engine. | U+C | P0 · fast |
| ENG-10 | Attempt unsupported engine/target, raw args/env/resource-profile injection or unknown advanced fields. API rejects the bypass; capability-positive Intel vLLM remains a separate hardware gate. | U+C+A | P0 · functional |

## 10. Retired FreeToken cases

FreeToken was removed on 9 October 2026. FT-01–09, DISC-08 and CACHE-07 are
retired identifiers retained for interpreting historical reports; they are not
requirements of current selection profiles. Existing failed/blocked evidence is
not reclassified as a pass.

ENG-01/LIFE-03/LIFE-04 owning coverage now includes rejection of retired-engine
creation/discovery/estimation/start/restart and settings inheritance, preservation
of Stop/Remove cleanup, and withdrawal from LiteLLM and Mesh. Browser fixtures
check that the Create Model engine list contains only supported runtimes.


## 11. Memory calculation, telemetry and resource planning

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| MEM-01 | Estimate vLLM/Ollama weights, KV/recurrent state, runtime reserve, headroom and download bytes. Breakdown sums correctly; storage size is not RAM/VRAM consumption. | U+C+B | P0 · fast |
| MEM-02 | Vary context, sequences and KV format with attention/hybrid/GQA fixtures. Formula, substituted inputs, quantized storage, theoretical KV versus allocator safety and fallback labels are accurate. | U+C+B | P1 · fast |
| MEM-03 | Exercise binary-unit conversion and 100 MiB planning steps near minimum/maximum. Round recommendations up and safe maxima down; CPU Pod requests follow their separate contract. | U+C+B | P1 · fast |
| MEM-04 | Compare capacity, live free, unreserved budgets and slots. Each gauge/legend uses its own denominator; reservations never masquerade as measured memory or protected partitions. | U+C+B+A+E | P0 · gpu |
| MEM-05 | Enter a legal but estimated-underbudget/oversubscribed vLLM/Ollama allocation. Require the documented explicit memory-risk acceptance; invalid inputs and exhausted slots remain hard errors. | U+C+A+B | P0 · functional |
| MEM-06 | Drag/click sliders and edit number fields while estimator/status responses arrive out of order. Preserve user choice, focus and manual host-RAM budget without flicker or remount. | U+B+E | P0 · functional |
| MEM-07 | Calculate shared free with 38.2 GiB MemAvailable, 108 GiB ceiling and 78.7 GiB GTT usage. Return 29.3 GiB; clamp at zero, use bytes before conversion, and do not subtract occupancy twice. | U+C+B | P0 · fast |
| MEM-08 | Supply missing/invalid/stale/non-PCI-matched samples or changed Node UID/boot/kernel. Show unknown, not zero usage/full availability or another node's counters. | U+C+A+B | P0 · gpu |
| MEM-09 | Compare unified firmware-reserved and dynamic shared pools. Show one physical GPU with separate non-additive rings; Linux RAM excludes firmware reservation and includes competing dynamic allocations. | U+C+A+E | P0 · gpu |
| MEM-10 | Attribute shared/fixed-domain model reservations and Linux safety headroom. Cap shared unreserved correctly even below fixed VRAM; unknown allocation domain cannot fabricate fit capacity. | U+C+B | P0 · fast |
| MEM-11 | Test multi-node/multi-GPU memory and CPU-offload fixtures. Node-scoped RAM/VRAM remain associated with the correct device; aggregate CPU availability cannot fund another GPU node. | U+C+B | P1 · fast |
| MEM-12 | Open memory explanations by hover, keyboard focus, click and touch. Formula/source/sample-age is available; Escape/outside click closes it and no explanation claims a guarantee. | U+B+E | P1 · functional |

## 12. Hardware inventory and optional GPU validation

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| HW-01 | Compare node and physical-GPU inventory with current host/Kubernetes evidence. Kernel/profile facts belong to the node; architecture/driver/resource/PCI/memory facts belong to their actual GPU accordion. | U+C+A+E | P0 · gpu |
| HW-02 | Use a mixed NVIDIA/Strix Halo host. NVIDIA readiness must not disable eligible AMD memory/runtime controls, and AMD evidence must not be copied to NVIDIA. | U+C+A+E | P0 · gpu |
| HW-03 | Distinguish driver ready, Kubernetes resource ready, optional engine validation and model Ready. An allocatable provider can remain usable during Flux reconciliation; missing resource blocks it. | U+C+A+B | P0 · gpu |
| HW-04 | Expand/collapse individual GPU and provider configuration sections. Default collapsed state and independent expansion persist; polling/opening never applies preparation or validation. | U+B+E | P1 · gpu |
| HW-05 | Save a changed AMD runtime profile through its normal API. Persist module parameters without host package/kernel changes, starting smoke tests or overwriting sharing; unchanged/reverted draft cannot Save. | U+C+A+E | P1 · gpu |
| HW-06 | Request Ollama/vLLM verification for one GPU and for all eligible GPUs on the selected node. Workload binding, scope, engine results and RBAC are correct; unrelated node/GPU is untouched. | U+C+A+E | P0 · gpu |
| HW-07 | Verify while slots are occupied. Report queued/waiting/unsupported state and respect admission; optional validation must not gate otherwise eligible production model use. | U+C+A | P1 · gpu |
| HW-08 | Validate fresh/stale/mismatched node evidence and changed physical GPU identity. Fail eligibility safely; Intel absence produces explicit deferred/unsupported test state, not invented validation. | U+C+B+A | P0 · gpu |

## 13. GPU sharing configuration and backend transitions

These cases require an approved `sharing` window with no unrelated workloads
affected. Current scope is one supported physical GPU on one selected node per
provider. Restore the original observed configuration after the suite.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| SHR-01 | Inspect an isolated fresh/default configuration. AMD and NVIDIA start exclusive with one slot; simply reading Hardware/Models cannot opt into sharing. | U+C+B | P0 · fast |
| SHR-02 | Change/revert mode and slot count in either provider form. Apply is valid only for an actual effective change, no extra checkbox; final disruption confirmation is still required. | U+B+E | P0 · sharing |
| SHR-03 | Configure NVIDIA shared count, then exclusive. For Device plugin, match intent, plugin profile/readiness, replicas and allocatable slots. For opt-in DRA, verify confirmed allocator handoff, exact claims and per-card slots. | U+C+B+A+E+O | P0 · sharing |
| SHR-04 | Configure AMD DRA sharing, then exclusive. Match eligible node/PCI identity, operator mode, ResourceSlices, ready shared claim/admission and real model claim/CDI binding. | C+A+E+O | P0 · sharing |
| SHR-05 | Test API/controller RBAC and the real AMD Pod admission path. Saved sharing alone is insufficient: authorized writes/reconciliation and admitted Pod creation must succeed without direct workload creation by dashboard. | U+C+A | P0 · sharing |
| SHR-06 | Start two small compatible models on each sharing backend, including an Ollama/vLLM pair. Both answer inference and have the expected slot/device contract; sharing is not advertised as memory isolation. | A+O | P0 · sharing |
| SHR-07 | Transition one provider with run-owned models while the other provider and CPU models serve requests. Only affected managed models restart; identities/data and other vendor settings/inference survive. | U+C+A+O | P0 · sharing |
| SHR-08 | Submit stale revision/Node UID, invalid count, missing confirmation or a concurrent provider change. Reject before overwrite or backend side effects. | U+C+A+B | P0 · sharing |
| SHR-09 | Present unmanaged same-vendor workloads, unknown external plugin config, active/pending MIG or unsupported topology. Block management without rewriting custom configurations. | U+C+B | P0 · fast |
| SHR-10 | Preserve existing explicitly selected/legacy NVIDIA profiles during generic upgrade/reconciliation. Non-MIG hardware remains eligible; MIG strategy alone is not mistaken for active partitions. | U+C | P1 · fast |
| SHR-11 | Omit DRA readiness/adapter or change hardware identity in isolated fixtures. Do not advertise desired slots or fall back to CPU/device plugin; failure is actionable and retry bounded. | U+C+B | P0 · fast |
| SHR-12 | Apply sharing, reload/new browser context, then read Hardware and Models. Saved mode/count, actual backend and visible segmented slots agree rather than silently reverting or remaining exclusive. | A+E+O | P0 · sharing |

## 14. GPU slot accounting and exhausted-device behavior

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| SLOT-01 | Compare API device/target/engine slot counts and segmented ring before/after model creation. Slots are independent of bytes and counted across engines. Multiple NVIDIA Device-plugin cards share one displayed node pool; DRA charges only the selected physical card. | U+C+B+A+E | P0 · gpu |
| SLOT-02 | Reserve enabled intent before its Pod exists, then observe the matching Pod. Replace the reservation, not double-count it; failed enabled intent retains retry capacity. | U+C+A | P0 · gpu |
| SLOT-03 | Include external GPU consumers, validation Pods and terminating Pods. Count them once; ignore completed Pods and release disabled/deleted intent only as runtime allocation actually clears. | U+C+A | P0 · sharing |
| SLOT-04 | Fill every admitted slot. Keep device visible but disabled with no-free-slots hint; direct API creation fails despite memory-risk acceptance. | U+C+A+E | P0 · sharing |
| SLOT-05 | Fill the selected GPU after opening a Create form. Refresh disables submission with a reason without clearing the draft or silently selecting different hardware. | U+B+A+E | P0 · sharing |
| SLOT-06 | Stop/remove one full-device model and wait for termination/allocation cleanup. Exactly that capacity returns and new admission/inference becomes possible. | U+C+A+E | P0 · sharing |
| SLOT-07 | Edit/restart an existing model when all slots are used. Reuse only its own existing allocation where supported; no extra slot is demanded or borrowed from another activation. | U+C+A+E | P0 · sharing |
| SLOT-08 | Use unscheduled intent and multi-GPU/node fixtures without physical placement evidence. Count once conservatively and label Node slots pool; never invent per-device assignment. | U+C+B | P1 · fast |
| SLOT-09 | Race two clients for the last slot. Record admission snapshots; scheduler/sharing controller never runs more admitted models than capacity or enables CPU fallback. Do not assume API snapshots are atomic allocations. | U+C+A | P0 · sharing |
| MGPU-01 | Distribute one ordinary vLLM/Ollama model across 2 and 4 NVIDIA GPUs on one node, including different models and capacities, in Exclusive and Shared modes. Verify physical capacity from DRA inventory even when live totals differ or one card lacks metrics; reject unknown capacities or foreign nodes and explain disabled choices. Bound equal per-card budgets by the smallest unreserved/physical ceiling; vLLM workers apply equal MiB budgets on unequal GPUs. Create/Edit show total VRAM estimates, inputs and a 100% maximum bounded by the least unreserved selected card. Accept a legal total larger than one card, convert it to per-card reservations and preserve untouched/reverted saved budgets. Persist exact selections; reject missing, mixed, full or physically oversized groups without partial reservation. Observe all DRA claims, memory use on every card, routed inference, UI/logs, edit, Stop/Start, per-card slot release and exact backend restoration. Host RAM/CPU remain one Pod allocation; replicated copies retain full per-copy controls. | U+C+B+A+E+O | P0 · gpu/sharing |
| MGPU-02 | Replicate a complete ordinary vLLM/Ollama model on 2 and 4 same-node NVIDIA cards, including different models and capacities, in Exclusive and Shared modes. Select identical inventory cards despite differing live totals or missing metrics. Persist explicit replicated mode; validate full per-copy VRAM and combined RAM/CPU reservations; keep exact per-copy claims, slot counts, status and bounded logs. Route independent requests through one public alias, withdraw unhealthy copies individually, drain on edit, and verify Stop/Start/removal plus exact backend restoration. Reject mixed/split strategies and foreign ownership. | U+C+B+A+E+O | P0 · gpu/sharing |

## 15. Logs, runtime errors and model status

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| LOG-01 | Open Logs for every local engine while Starting and Ready. Retrieve bounded current/previous/init-container output for the owned runtime; dialog refresh and close work. | U+C+A+E | P0 · functional/gpu |
| LOG-02 | Open logs before any Pod/output exists, and after Stop. Show an honest waiting/no-runtime message; expected absence is not a dashboard crash. | U+C+B+A+E | P1 · functional |
| LOG-03 | Request logs as viewer/operator and for catalog-only/external models or arbitrary Pod/namespace/container paths. Enforce administrator/model-ownership boundary; external cards have no fake local log button. | U+C+A | P0 · identity |
| LOG-04 | Observe multi-Pod/restarted runtime fixtures. Match labels plus controller ownership, preserve previous-run evidence and bound tail/containers; unowned same-label Pods are excluded. | U+C+A | P0 · functional |
| LOG-05 | Retrieve real Kubernetes logs through the backend's content-negotiation path. Text is returned without HTTP 406; default JSON transport for other API calls is unchanged. | U+C+A | P0 · functional |
| LOG-06 | Display ANSI/control characters, very long lines and HTML-like text fixtures. Render inert bounded text with usable horizontal scrolling and no script execution/secret capture. | U+C+B | P0 · fast |
| LOG-07 | Trigger a safe failed model fixture and inspect card plus logs. Surface root cause/stage without duplicate endless starting or falsely active KV/runtime configuration. | U+C+A+E | P1 · functional |

## 16. Inference API, generated catalog and routing

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| ROUTE-01 | Send authorized chat inference for each Ready local engine through the normal Gateway/LiteLLM endpoint. Correct model, usable response and runtime evidence; health alone does not pass. | A | P0 · smoke/gpu |
| ROUTE-02 | Request `/v1/models` before/after start, failure, Stop and Remove. Only actually published models/routes appear; defaults and app consumer catalogs remain consistent. | U+C+A | P0 · functional |
| ROUTE-03 | Test streaming text chat and cancellation where supported. Valid stream termination, bounded request resources and a subsequent request work without a leaked workload. | C+A | P1 · functional/gpu |
| ROUTE-04 | Run a supported embedding fixture and inspect default embedding selection/consumer wiring. Vector response is valid and separate from chat-default selection. | U+C+A | P1 · functional |
| ROUTE-05 | Create/edit/Stop/Start/Remove an external provider against a controlled endpoint. Preserve key on blank edit, replace only explicitly, withdraw/recover local route without stopping remote service. | U+C+A+E | P0 · functional |
| ROUTE-06 | Reject unauthorized, revoked or missing inference keys and unknown/stopped model routes. Error follows supported API semantics without exposing provider secrets. | U+C+A | P0 · smoke |
| ROUTE-07 | Simulate backend timeout/429/5xx and route disappearance. Propagate a clear inference failure without a false Ready response or silently changing to an unrelated model/provider. | U+C+A | P1 · functional |
| ROUTE-08 | Change model context/output metadata and defaults. Generated consumer fragments/hashes and owned restart behavior update, preserving unmanaged templates and secret injection boundaries. | U+C+A | P1 · functional |
| ROUTE-09 | Use local/public routes with correct SNI/CA and long inference. Authentication works on each advertised endpoint; incompatible Realtime features are not implied by ordinary OpenAI-compatible chat. | C+A | P1 · functional |

## 17. Named inference API keys

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| KEY-01 | Create a named run-owned key via UI and use it for real inference. Show its raw value once, clear it on close and list only non-secret metadata thereafter. | U+C+A+E | P0 · smoke |
| KEY-02 | Refresh/reload and page away/back after key creation. Raw key cannot be recovered from routine responses, storage or DOM; lost key requires replacement. | U+C+B+A | P0 · identity |
| KEY-03 | Revoke that key with confirmation. It cannot infer afterward; other keys and the service remain functional. | U+C+A+E | P0 · smoke |
| KEY-04 | List/revoke a key provisioned by another tool or with changed ownership metadata. Dashboard excludes it and rejects deletion rather than managing every LiteLLM key. | U+C+A | P0 · identity |
| KEY-05 | Use an inference key against LiteLLM administration and Magic Stick management APIs. Deny escalation; supported inference/model routes still work. | U+C+A | P0 · identity |
| KEY-06 | Exercise invalid names, duplicate requests, unavailable LiteLLM/PostgreSQL and ambiguous create response. Clear error, no secret-bearing report and no untracked replacement loop. | U+C+B+A | P1 · functional |

## 18. Human user administration

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| USER-01 | Search/page/filter users and show empty/loading/failure state. Lazy loading avoids unnecessary periodic administration calls and does not expose credentials. | U+C+B+A+E | P1 · identity |
| USER-02 | Create a disposable local user, edit allowed fields/roles and log in as that identity. Saved data and actual role capabilities agree. | U+C+A+E | P0 · identity |
| USER-03 | Enable/disable and reset a disposable user's password under the current identity policy. Authorization/session effects are observed; passwords never enter artifacts or ordinary responses. | U+C+A+E | P0 · identity |
| USER-04 | Attempt to remove/demote/disable the last usable administrator, protected recovery identity or oneself where prohibited. Server-side guard survives concurrent requests. | U+C+A | P0 · identity |
| USER-05 | Delete a run-owned user using exact-name confirmation. Grants/sessions are handled by contract; another user is not deleted by a stale/reused selection. | U+C+A+E | P0 · identity |
| USER-06 | Submit invalid/duplicate users, forbidden roles/fields and unavailable/externally managed identity operations. API/GUI explain the supported limitation without partial privilege escalation. | U+C+B+A | P1 · identity |

## 19. Kubernetes access and token-free kubeconfig

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| K8S-01 | Read access readiness and search/page existing eligible users. Download/copy stays disabled before OIDC/non-secret connection metadata is ready. | U+C+B+A+E | P1 · identity |
| K8S-02 | Assign Viewer to a disposable identity, log in through the kubeconfig's supported OIDC exec flow and read permitted objects. Secret read and workload mutation are denied. | C+A+E | P0 · identity |
| K8S-03 | Assign Operator. Read plus CRUD of the three runtime-intent kinds in `ai-system` works; direct Pod/Deployment writes, unrelated namespace changes and Secrets do not. | C+A | P0 · identity |
| K8S-04 | Review the explicit Cluster Administrator warning in fixtures; optional isolated live grant has actual cluster-admin semantics and is revoked immediately. Never use this role for routine observers. | U+C+B+O | P0 · maintenance |
| K8S-05 | Download/copy kubeconfig. Correct control-plane address, cluster/identity CA and exec metadata; no token/password/refresh token/client secret. Contents are never uploaded as a test artifact. | U+C+A+E | P0 · identity |
| K8S-06 | Switch/remove access; only one direct access group remains and audit output is sanitized. Protected/disabled users cannot gain grants and revoked identities cannot use old access after required session invalidation. | U+C+A+E | P0 · identity |

## 20. Licenses, editions and offline notices

Use isolated signed test fixtures and lab-only trust/issuer material. Never put
the production signing key or a real customer license in tests. Core models,
GPU management, instance sharing and Mesh are **not** license-file gated; only
Federated SSO currently has a feature entitlement gate.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| LIC-01 | Inspect no-file Free status and exercise core models/GPU/sharing/Mesh workflows. No historical Enterprise/mesh startup gate returns. | U+C+A+B | P0 · functional |
| LIC-02 | Validate supported Free Registered/Commercial fixtures. Show exact edition, entitlement and installation/time binding without activating a validation-only upload. | U+C+A+E | P0 · identity |
| LIC-03 | Reject tampered/unsigned/expired/not-yet-valid/wrong-installation/unknown-key documents, extra claims and malformed input. Active state is preserved; no imported self-provided trust key. | U+C+A | P0 · identity |
| LIC-04 | Review replacement then explicitly activate with current revision; test stale revision/ambiguous write. Persist across API restart and refresh before retry, never delete the license Secret to force success. | U+C+A+E | P0 · identity |
| LIC-05 | Export the active document privately and reload the page. Same verified document returns with no-store handling; viewer/ordinary-user access is denied. | U+C+A+E | P1 · identity |
| LIC-06 | Generate requests for both editions with customer reference/TTL boundaries. JSON is unsigned, installation-bound and starts validity at generation; downloading cannot activate an entitlement. | U+C+B+A+E | P1 · identity |
| LIC-07 | Read/download LICENSE, use grant, change license and third-party notices with license API offline. Legal text remains available; commercial-production is not a model-start restriction. | C+B | P1 · fast |
| LIC-08 | Test official plus preserved local public trust stores and unknown/missing keys in isolated fixtures. Rotation/convergence preserves local trust and fails verification closed without exposing private material. | U+C | P0 · fast |

## 21. Federated SSO

Real provider cases require a disposable upstream IdP, approved test entitlement
and a separate local administrator/recovery session. Do not replace production
identity providers on the ordinary appliance smoke run.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| SSO-01 | Open the page without valid `federated-sso` entitlement. View/recovery deletion follow administrator policy; activation/changes and broker login/callback fail closed, while local login works. | U+C+B+A | P0 · identity |
| SSO-02 | Validate OIDC discovery and SAML metadata from a controlled trusted endpoint. Show stable issuer/callback and reject malformed/insecure/untrusted/unsafe remote fetches. | U+C+A+E | P0 · identity |
| SSO-03 | Create/update a disposable provider and exact claim/attribute-to-fixed-role mapping. Persist redacted state; blank preserved secrets and explicit replacement follow the contract. | U+C+A+E | P1 · identity |
| SSO-04 | Log in through each configured protocol and verify actual allowed/denied roles. Unknown/missing claim values cannot invent administrator access. | C+A+E | P0 · identity |
| SSO-05 | Lose/expire entitlement or its verification API. Disable brokers without deleting credentials/users/mappings; no cached allow on external callback, and local recovery remains usable. | U+C+A+O | P0 · identity |
| SSO-06 | Cancel/delete/disable the disposable provider and submit stale revisions. No unapproved save, stale overwrite or orphaned active broker; protected local login is unaffected. | U+C+A+E | P1 · identity |

## 22. Host operation boundary and Domains

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| HOST-01 | Read managed-host preparation/power/cache/network/update status. Allowlisted fields only; stale/offline/mismatched workers disable actions with a specific reason. | U+C+B+A | P0 · smoke |
| HOST-02 | Review a bounded operation, cancel, type a wrong/exact host name and inspect final warnings. Only exact approved confirmation submits one immutable request. | U+C+B+E | P0 · maintenance |
| HOST-03 | Reject wrong role, Node UID/boot/fingerprint, expired request, arbitrary path/command/package/repository and unknown fields at both API and worker. No privileged execution. | U+C | P0 · fast |
| HOST-04 | Observe operation progress across dashboard disconnect/restart and replay the same request ID. Distinguish accepted/scheduled/applied/verified; no duplicate effects or clearing operation state. | U+C+A+O | P0 · maintenance |
| HOST-05 | Request conflicting network/power/GPU/cache/update/convergence actions. Shared maintenance and package locks serialize or reject them; interruption requires explicit safe recovery. | U+C+O | P0 · maintenance |
| HOST-06 | Inspect changed/unchanged/reverted valid/invalid public and mDNS domains in Settings. Save only actual valid changes; preserve other settings and explain route/login implications. | U+C+B | P1 · fast |
| HOST-07 | Apply/revert approved lab domain changes with independent recovery access. Observe settings, Gateway/mDNS/identity callbacks/instance URLs and reconnect; no partial claim of success. | C+A+E+O | P1 · maintenance |
| HOST-08 | Review eligible/blocked host preparation plans and manual AMD profile handoff. Inspection never installs/reboots; only shipped reviewed packages are admitted and optional validation remains separate. | U+C+B | P0 · fast |

## 23. GPU host preparation and shared-memory configuration

Firmware/kernel changes require a reviewed host plan, console recovery and
operation-specific approval. Do not downgrade a working host or fabricate a
package plan merely to make a test executable. Use isolated worker fixtures for
unsafe/failure variants and report absent physical prerequisites explicitly.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| GPUHOST-01 | Open memory/preparation controls, change/revert firmware/dynamic drafts and test a non-step-aligned current value or corrective draft. Review enables only a genuine valid change; no operation occurs before final confirmation. | U+C+B+E | P0 · functional |
| GPUHOST-02 | Test preparation OS/architecture/PCI/kernel/driver evidence, mixed-host experiment consent and stale plans. Only a shipped reviewed plan is allowed; missing inventory or incompatible driver cannot be bypassed. | U+C+B | P0 · fast |
| GPUHOST-03 | Prepare an eligible host with an already working suitable kernel. Matching runtime profile activates without installing/downgrading packages, rebooting or launching optional validation; Kubernetes registration is observed separately. | U+C+A+O | P1 · maintenance |
| GPUHOST-04 | Apply a genuine advertised package preparation plan in a disposable maintenance environment. Verify signed exact packages, orderly reboot if required, fresh driver/registration and retained previous kernel; host success is not model inference acceptance. | U+C+A+O | P1 · maintenance |
| GPUHOST-05 | Change only dynamic shared ceiling on an eligible AMD host. Enforce current Linux RAM and 16 GiB safety allowance, apply via the owned boot configuration, observe one new boot and verify actual limit without kernel/operator/NVIDIA changes. | U+C+A+E+O | P0 · maintenance |
| GPUHOST-06 | Change a host-offered firmware reservation and dynamic limit. Verify each approved stage through up to two boots against actual post-boot values, not projected RAM; fixed and shared pools remain non-additive. Restore only via a new reviewed operation. | U+C+A+O | P0 · maintenance |
| GPUHOST-07 | Use eligible Strix Halo plus NVIDIA hardware and wrong-binding/extra-AMD fixtures. Only AMD memory changes; fresh inventory/companion driver identity is rechecked, bounded NVIDIA bind wait does not trigger another write/reboot. Unsafe layouts remain blocked. | U+C+A+O | P0 · maintenance |
| GPUHOST-08 | Interrupt or fail between firmware/dynamic stages, introduce stale identity or a competing host operation. Publish accurate terminal/prepared-unverified state, preserve evidence and require an explicit fresh plan; no replay/reboot loop or automatic firmware-rollback claim. | U+C | P0 · fast |

## 24. Ethernet and Wi-Fi configuration

Physical apply/rollback cases need a spare management path or local console and
a controlled test network. Unsupported bridges/bonds/VLANs/multi-address or
control-plane address migration must stay rejected, not be tried remotely.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| NET-01 | Discover Ethernet and Wi-Fi, link/addresses/gateway/MAC and current IPv4 settings. Absent/disabled radio and missing Ethernet driver stay distinct; inspection never enables a connection. | U+C+A+E | P1 · functional |
| NET-02 | Validate DHCP/static IPv4, prefix, gateway, DNS and metric boundaries. Preserve unedited IPv6/interfaces; reject unsupported topology or control-plane address/SSID migration. | U+C+B | P0 · fast |
| NET-03 | Edit SSID/open/WPA-personal/hidden-network choices. Validate key lengths, preserve blank saved key only for same SSID and never echo a password in status/errors/artifacts. | U+C+B | P0 · fast |
| NET-04 | Explicitly scan an enabled controlled Wi-Fi interface. Bound/sanitize results; disabled radio is not enabled as a side effect, and manual SSID entry remains available. | U+C+A+E | P1 · maintenance |
| NET-05 | Apply an approved Ethernet DHCP/static or Wi-Fi trial and explicitly Keep it. Observe exact-host/identity binding, actual IPv4 and preserved management address, then persisted confirmation. | C+A+E+O | P0 · maintenance |
| NET-06 | Let a trial expire with browser/API unavailable. Independent local rollback restores prior files/backend and management reachability; API success alone cannot auto-confirm. | U+C+O | P0 · maintenance |
| NET-07 | Restart during an unconfirmed controlled trial. Boot recovery restores before networking and handles concurrent external edits safely rather than deleting them. | U+C+O | P0 · maintenance |
| NET-08 | Attempt stale/conflicting confirmation or requests; inspect ephemeral credential cleanup. Fail safely without replacing another operation or leaking raw Netplan/Secrets. | U+C | P0 · fast |

## 25. Ubuntu package update policy

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| UPD-01 | Read policy/status and test each supported mode, UTC schedule/window and restart opt-in in the form. Unchanged/reverted Save stays disabled; first-activation defaults are distinct from preserved existing policy. | U+C+B+A+E | P1 · functional |
| UPD-02 | Save/reload an approved lab policy and run host convergence. Durable policy survives; it is not a license gate or a second unrelated scheduler. | U+C+A+O | P1 · maintenance |
| UPD-03 | Check package metadata/counts explicitly. Show security/regular/held counts, last attempt and reboot-required without installing packages or changing mirrors. | U+C+A+E+O | P1 · maintenance |
| UPD-04 | Exercise eligible origin/current-release selection, signature/holds and hardware exclusions with controlled APT fixtures. No third-party/release/dist-upgrade or K3s/container update is admitted. | U+C | P0 · fast |
| UPD-05 | Install reviewed security/all-current-release updates in a maintenance window. Exact-host confirmation and lock held; no automatic reboot for manual install; inference/services checked afterward. | C+A+O | P0 · maintenance |
| UPD-06 | Model busy retries, UTC window end, interrupted/failed attempts and package-lock contention. No late new install, duplicate replay, forced lock deletion or killed transaction. | U+C | P0 · fast |
| UPD-07 | Exercise automatic restart policy in isolated fixtures and an optional authorized live run. Restart only after successful eligible automatic install in-window, once per boot; otherwise remains visibly pending. | U+C+O | P0 · maintenance |

## 26. Magic Stick software channels and recovery

Only approved compatible revisions are applied on the lab. Checking a feature
branch is not permission to execute arbitrary unreviewed code on the runner/host.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| CHANNEL-01 | Read desired/host/Flux/applied revisions and actual critical image IDs. Stable main, develop, other branch, fixed tag and full commit forms reflect the current authoritative configuration. | U+C+A+E | P1 · functional |
| CHANNEL-02 | Validate supported ref kinds and exact syntax; reject URLs/shell expressions/short commits/missing refs/stale host identity. External GitOps installation reports management unavailable. | U+C+B | P0 · fast |
| CHANNEL-03 | Check a reviewed main/develop/tag/commit/feature branch. Resolve its commit and matching published architecture/image digests; check alone changes no host/channel. | U+C+A+E | P1 · maintenance |
| CHANNEL-04 | Present unpublished/mismatched runtime images or changed runtime source since build. Reject; documentation/host-only changes may reuse unchanged compatible images. | U+C | P0 · fast |
| CHANNEL-05 | Expire/move a checked ref and apply with old preview. Reject the unapproved revision; require a fresh check instead of racing branch changes. | U+C | P0 · fast |
| CHANNEL-06 | Apply an approved compatible selection. Preserve other repo defaults/settings, run Ansible and give Flux the same commit; live image IDs/readiness and inference prove convergence. | C+A+E+O | P0 · maintenance |
| CHANNEL-07 | Interrupt/fail a controlled apply. Persist recovery evidence, pause ordinary host convergence, do not replay completed requests or claim an offline rollout. | U+C+O | P0 · maintenance |
| CHANNEL-08 | Select/recover a compatible previous revision using the documented saved runner. Leave it commit-pinned, restore source/config consistently and verify login/inference; do not promise database/OS rollback. | U+C+A+O | P0 · maintenance |

## 27. Model-cache disk management

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| CACHE-01 | Read filesystem/cache inventory and refresh the UI. Disk usage is distinct from RAM/VRAM; missing/stale reports remain unavailable and opening the page deletes nothing. | U+C+A+E | P1 · functional |
| CACHE-02 | Attempt cleanup with active, scale-to-zero, unpinned, other-node or terminating local model references/KubeAI resources. API and worker protect shared caches conservatively. | U+C+A+B | P0 · functional |
| CACHE-03 | Inspect empty cache, busy host, invalid plan/UID/boot and unauthorized requests. Cleanup remains disabled/rejected with reason, not an arbitrary directory/command override. | U+C+B | P0 · fast |
| CACHE-04 | Stop/remove all relevant owned models, then approve known-cache cleanup in an isolated maintenance fixture. Only allowlisted HF/Ollama entries go; definitions, credentials, container images and app data stay. | U+C+A+E+O | P0 · maintenance |
| CACHE-05 | Try symlink parents/entries, nested mounts, interrupted deletion and oversized/slow scan fixtures. Fail closed without following/deleting outside cache or replaying deletion. | U+C | P0 · fast |
| CACHE-06 | Race new local-model intent against pending cleanup. Defer new runtime/reject unsafe deletion; Stop/Remove and external models continue. | U+C+A | P0 · maintenance |

## 28. Restart, power and installed-host resilience

Physical restart tests need explicit consent; power-off additionally needs a
known independent power-on path. An unreachable host does not prove power-off.

The NVIDIA owning suite in
[`nvidia-display/tests/test_role.py`](../../magic-host/roles/nvidia-display/tests/test_role.py)
also covers fresh-install driver selection: Ubuntu's hardware recommendation,
unversioned APT package names, matching kernel modules, multi-GPU agreement,
retained existing driver packages and fail-closed recommendation errors. The
suite is already selected by the Phase 6 `boot` owning group and Public release
checks. These are local support contracts for boot recovery, not USB/VM install
acceptance or a live BOOT-03 inference result. The physical target must still
pass console, driver, toolkit/device registration and inference checks.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| BOOT-01 | Open power tab as each role, review/cancel/wrong-name/confirmed request. Only administrator exact-host confirmation schedules one orderly action; stale/busy hosts are blocked. | U+C+B | P0 · fast |
| BOOT-02 | Restart an approved installed lab with owned CPU/AMD/NVIDIA workloads. Observe acceptance, scheduled interruption and new boot ID; restored identity/routes/models perform inference. | C+A+O | P0 · maintenance |
| BOOT-03 | After NVIDIA driver/operator recovery, start a real CUDA model and infer. No missing persistenced socket mount/OCI error; driver, toolkit, device plugin and allocatable resource agree. | C+A+O | P0 · maintenance |
| BOOT-04 | Restart AMD DRA with active owned claims. Recreate volatile CDI against current physical device; restored model binding/inference works even if DRM numbering changed. | U+C+A+O | P0 · sharing |
| BOOT-05 | Use stale identity/checkpoint/CDI fixtures. Driver registration and cleanup remain alive, affected claims fail closed, and no script clears checkpoints or assumes consumer absence. | U+C | P0 · fast |
| BOOT-06 | Restart API/controller/device-plugin in an isolated approved recovery case. Persist intent, do not duplicate runtimes/admission, recover metrics/route and preserve other-vendor inference. | U+C+A+O | P1 · maintenance |
| BOOT-07 | Shut down only with approved external recovery/power control. Report scheduled action versus external power observation separately; power on and complete post-boot smoke. | C+O | P2 · maintenance |

## 29. Private Mesh and companion

Single-appliance tests cover UI/commands/auth; remote inference needs an actual
peer or consume-only companion. Keep existing native fixture E2E separate from
two-appliance and cross-NAT acceptance.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| MESH-01 | Open top-level Mesh and legacy links with/without module and for each role. No license-file gate, no enable/create merely by opening; command authorization and CSRF enforced. | U+C+B+A+E | P0 · functional |
| MESH-02 | Enable module and create a disposable mesh with device name/relay and explicit model sharing. Observe membership/state through API and UI; sharing starts off unless selected. | U+C+A+E | P1 · mesh |
| MESH-03 | Create/revoke/use an invitation with expiry, wrong role/type, reuse and invalid signature fixtures. Single use enforced; token shown once and removed from storage/dialog on close. | U+C+A+E | P0 · mesh |
| MESH-04 | Join from another appliance or employee companion. Leave-before-join confirmed for existing membership; canceling Join never destroys current membership. | U+C+A+E | P0 · mesh |
| MESH-05 | Share a ready local model from each ordinary engine. Remote peer infers through the existing backend; no second model copy or unintended export of unselected/stopped/external models. | U+C+A | P0 · mesh |
| MESH-06 | Unshare/revoke member/expire lease or lose policy discovery. New unauthorized requests fail closed and owned remote routes/keys disappear; local inference is independent. | U+C+A | P0 · mesh |
| MESH-07 | Change limits/relay/sync with changed/unchanged/reverted controls. Enforce creator/member/consume-only authority and signed per-model allowlists without client-chosen service credentials. | U+C+A+E | P0 · mesh |
| MESH-08 | Leave/disable/rejoin a disposable mesh. Withdraw shares/imports, preserve local models and use fresh invitation; clean only owned membership/routes. | U+C+A+E | P1 · mesh |
| MESH-09 | Run companion on each packaged platform in its isolated state. Loopback-only authenticated UI/API, protected host/origin and inference-only key; no admin/mesh-management authority in that key. | C+A | P0 · mesh |
| MESH-10 | Test desktop non-streaming completion and explicit rejection of unsupported streaming; separately test appliance bridge streaming, disconnected/revoked peers and relay-only cross-NAT behavior. | U+C+A | P1 · mesh |

## 30. Experimental Omni and Realtime

Ordinary Ollama/vLLM OpenAI-compatible chat is not a claim of Realtime support.
Use only the advertised profile, compatible image, reviewed model and admitted
one-/two-device stage plan. Microphone/intelligibility is a manual live case.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| RT-01 | Select/edit an Omni profile and HF source in its separate form. Persist `engine: VLLM` plus Realtime settings; do not inherit ordinary engine memory/offload fields. | U+C+B+A+E | P0 · realtime |
| RT-02 | Validate exclusive/shared stage/device/memory plan and image availability. Shared consumes one admitted slot; no two-physical-GPU plan masquerading as shared replicas or unsupported CPU/XPU image. | U+C+A | P0 · realtime |
| RT-03 | Start the real profile: all stages load on assigned resources and become healthy. Catalog/route/status agree; admission failure without Pod is actionable. | C+A | P0 · realtime |
| RT-04 | Open authenticated `/v1/realtime` WebSocket through Gateway/LiteLLM; reject missing/revoked key. Protocol/session/error events are coherent, not merely a localhost health pass. | U+C+A | P0 · realtime |
| RT-05 | Send bounded audio/text fixtures, commit two turns and use supported VAD/interrupt behavior. Receive usable audio/text, preserve turn context and handle disconnect/cancellation. | C+A | P1 · realtime |
| RT-06 | In LiteLLM Playground, verify real microphone input, intelligible audio, second turn and barge-in. Record settings/source/hardware/manual evidence separately from protocol automation. | E | P1 · realtime |
| RT-07 | Test unsupported tool/voice/resumption features against current plugin contract. Clearly report limitation; no full OpenAI feature-parity promise from API compatibility. | U+C+A | P1 · realtime |
| RT-08 | Stop/Start/Restart/Remove Omni under exclusive and admitted shared mode. Release/recover only its resource/route; an ordinary model remains able to infer. | U+C+A+E | P0 · realtime |

## 31. Security, accessibility, compatibility and non-functional checks

Use controlled fixtures for hostile input and isolated environments for faults.
Timing/resource limits are reviewed from measured pilot baselines, not asserted
as unmeasured product performance. Existing security/release CI remains required.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| SEC-01 | Enumerate public API reads/mutations and auth-negative cases. No hidden route bypasses role/CSRF/license/ownership checks; the frontend has no Kubernetes token/workload authority. | U+C+A | P0 · identity |
| SEC-02 | Exercise discovery, external URL/metadata and model-log hostile input with controlled servers. Reject forbidden targets/redirects/path injection, bound reads and avoid XSS/log injection. | U+C+B | P0 · fast |
| SEC-03 | Test pinned dependency vulnerabilities, secret scan, unsafe TLS disablement and unbounded parsing/input fixtures. Existing security checks fail actionable regressions without silently dismissing alerts. Full acceptance also requires fresh successful fixed-workflow advisory and redacted secret-scan CI runs for the exact installed commit; offline checks alone cannot certify current advisories. | U+C+A | P0 · fast + fresh CI |
| SEC-04 | Inspect generated routes/policies/RBAC and credential references. No broader Secret read, public exposure or namespace ownership appears from an ordinary feature change. | C+A | P0 · identity |
| UX-01 | Walk pages, dialogs, help and actions by keyboard/touch at desktop and narrow mobile widths. Labels, focus/return, Escape, error announcements, contrast and table/log overflow remain usable; status is not conveyed by color alone. | B+E+N | P1 · functional |
| UX-02 | Verify accordions/defaults, loading/empty/error states and unchanged/changed/reverted fields across every settings form. Polling cannot erase drafts or trigger actions. | U+B+E | P0 · functional |
| UX-03 | Smoke real auth/navigation/create/edit/lifecycle in secondary supported browsers after Chromium baseline. Report WebKit/Firefox emulation limits rather than claiming physical iOS/Safari certification. | B+E+N | P2 · functional |
| UX-04 | Exercise shared CLI/TUI read/form/confirmation contracts with the same API data. Role, units, memory/slots and errors agree; no client-specific authorization or workload path. | U+C | P1 · fast |
| PERF-01 | Measure dashboard/API/inference response and model stage timings under reviewed small-fixture workloads. Record cold/warm/engine/hardware separately and regressions against an approved baseline. | A+N | P1 · soak |
| PERF-02 | Repeat create/infer/edit/Stop/Start/Remove cycles and check intent/Pod/claim/key/route counts plus RAM/disk growth. No unbounded orphan or leak; cache growth is separate and credential-object lifecycle is checked in isolated controller fixtures. | U+C+A+N | P0 · soak |
| PERF-03 | Keep concurrent shared models serving bounded requests over a reserved long run. Both remain responsive, resource contention/errors are visible and no isolated-throughput/memory guarantee is inferred. | A+N | P1 · soak |
| PERF-04 | Disrupt only a run-owned backend/controlled fixture connection. Bounded retry/recovery and subsequent inference work without resource amplification or endless aggressive polling. | U+C+A+N | P1 · soak |

## Implementation ledger

Supporting BOOT-02 startup/resource coverage runs
[`NginxWorkerContractTests`](../../magic-cluster/platform/identity/tests/test_nginx_workers.py)
through the existing boot owning-suite selection. Public CI also runs
[real nginx container tests](../../tests/test_nginx_runtime.py) with the Pilot's
64 MiB and dashboard's 128 MiB limits, checking HTTP health, one worker and zero
OOM/restart counters. This focused deployment regression does not replace the
installed reboot, authentication or inference requirements of BOOT-02.

The same boot owning-suite selects `NvidiaStartupHandoffTests` in the NVIDIA
host-role tests. Synthetic PCI bindings reproduce Nouveau/unbound first boot,
mixed AMD/NVIDIA and post-boot release, including NVML/socket failures, manual
operand disablement, UID/version-bound patch conflicts, maintenance and scheduled
restart deferral. Role contracts verify package-service guard ordering and the
fresh-node gate. These are C-layer startup checks, not a physical USB installation
or a completed live BOOT-02 reboot/inference run.

Add one entry per implemented case or parameterized case group. Do not mark an
entire family implemented because one representative happy path exists. Link
to actual source tests/procedures and a sanitized dated report; a result applies
only to its recorded hardware/source/deployment. Preserve stable case IDs when
adding or splitting cases and document any replacement.

| Case IDs / parameter set | Implementation | Test/procedure | Last reviewed run evidence | Remaining prerequisite |
|---|---|---|---|---|
| MGPU-01 · 2/4-card NVIDIA, vLLM/Ollama, Exclusive/Shared | **Implemented; physical acceptance pending** | [Phase 3/4 selections](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning contracts](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [budget component checks](../../dashboard/apps/web/src/NvidiaCards.test.tsx), [desktop/mobile Chromium](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [live group workflow](../../dashboard/apps/web/regression/hardware/multi-gpu.e2e.spec.ts) | Local API/controller/runtime and UI fixtures cover atomic admission, identity, budgets, strategy, persistence, full-card edits and lifecycle accounting. Inventory eligibility covers three differing DCGM readings plus an inventory-only fourth card, different models/capacities, unknown physical capacities despite equal telemetry, legacy API compatibility and rejection of mixed capacity sources. Native vLLM worker contracts cover equal MiB budgets on unequal GPUs and physical/override rejection. Desktop/mobile browsers cover both identical and different 2/4-card groups with smallest-budget maxima, physical limits and Create/Edit persistence. Total-budget coverage includes 2/4-card Create/Edit, budgets above one card, smallest-card maxima, unknown capacity, rounding, unchanged/reverted legacy budgets and split/replicated mode changes. Live variants in `phase3-gpu` and `phase4-sharing` also check the saved per-card budget displayed in Edit; no physical multi-GPU acceptance is claimed by isolated checks. | Registered lab with at least 2/4 eligible same-node NVIDIA cards (including different-model/capacity acceptance), current DRA inventory and telemetry, deployed source/images, approved small vLLM/Ollama fixtures and a clean Lease. Missing capacity is Blocked, not Passed; a complete run must prove every requested card is used. |
| MGPU-02 · 2/4 independent copies, vLLM/Ollama, Exclusive/Shared | **Implemented; physical acceptance pending** | [Phase 3/4 selections](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning contracts](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [desktop/mobile Chromium](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [live copy workflow](../../dashboard/apps/web/regression/hardware/multi-gpu.e2e.spec.ts) | Local tests cover per-copy resources/identity, different GPU capacities, partial failure, generation-safe routing, one catalog alias, log selection and lifecycle cleanup. Matching tests select all four identical inventory cards with mixed telemetry; desktop/mobile browser creation pairs measured and inventory-only cards with identical or different capacities, preserves their exact bindings and verifies editing/log selection. Live variants in `phase3-gpu` and `phase4-sharing` assert separate exact DRA bindings, memory usage, parallel routed requests, per-card slots, edit, Stop/Start/removal and restore. Fixture tests are not live acceptance. | The MGPU-01 lab requirements plus enough total host RAM for all full copies. Missing hardware is Blocked, not Passed. No autoscaling, multi-node replication or combined split/replicated runtime is claimed. |
| SLOT-01/05/06/07, SHR-03 · four-card NVIDIA DRA / legacy pool variants | **Implemented in isolated U/C/B layers; hardware acceptance pending** | [Selected variants](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning tests](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [Chromium fixtures](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [API slot/identity contracts](../../magic-cluster/apps/dashboard/test_nvidia_card_api.py), [DRA handoff contracts](../../magic-cluster/platform/magicstick-operator/controller/test_nvidia_dra.py), [per-device diagnostic contracts](../../magic-cluster/platform/magicstick-operator/controller/test_gpu_devices.py) | 2026-10-09: four synthetic identical cards cover one legacy pool, distinct DRA rings, exact Create/Edit selection, full-card draft retention, Stop/termination release, own-slot reuse, node replacement, queue isolation, fail-closed admission and sequential exact-card diagnostic results. These are isolated fixtures, not a new live acceptance record. | Real four-card node: forward/reverse allocator transition, KubeAI-ServiceAccount admission dry run, actual Pod GPU UUIDs, Ollama/vLLM inference, diagnostics and restart recovery. Existing single-GPU live variants do not certify these multi-card paths. |
| HAR-01–11 · complete Phase 0 P0 foundation profile | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase0-p0.ts), [live fault/recovery tests](../../dashboard/apps/web/regression/harness/safety.api.spec.ts), [isolated fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [runner and dated evidence](regression-test-concept.md#phase-0-p0-acceptance) | 2026-10-04 repeat: aggregate `reg-98491d09-43a7-4d9a-b1cb-0c4c3e308d8a` passed 61/61 results, all 14 mandatory live variants and final pinned preflight. `fullPhase0Accepted: true`; no missing, failed, blocked, skipped or flaky result. Interrupted prior journal recovered separately; owned resources absent and Lease free. Reviewed source/image/current boot pins verify. Both existing vLLM definitions remained Disabled and unchanged. Historical 2 October acceptance remains in the concept. | Accepted CPU/key/test-Lease foundation. App/identity and GPU/global-product-setting adapters remain in their domain phases; no GPU-inference acceptance claimed. |
| AUTH-01/02/06, NAV-03/06, CPU LIFE-01/03/04/06, ROUTE-01/06, KEY-01/03, LOG-01/05/06, selected UX-02 · finite Phase 1 P0 smoke | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase1-p0.ts), [live CPU/UI/API workflow](../../dashboard/apps/web/regression/models/cpu-ollama.e2e.spec.ts), [real session tests](../../dashboard/apps/web/regression/auth/session.e2e.spec.ts), [isolated status browser states](../../dashboard/apps/web/regression/navigation/status.browser.spec.ts), [owning component bridge](../../dashboard/apps/web/regression/components/installed.unit.spec.ts), [profile scope/evidence](regression-test-concept.md#phase-1-p0-smoke) | 2026-10-04: aggregate `reg-2bd24d2f-74a4-4961-98e7-5d3e4733f463` passed 116/116 results and all 66 required U/C/B/A/E tuples. `fullPhase1Accepted: true`; all seven stages and final pinned clean preflight passed. Real sessions, UI keys, CPU/Ollama lifecycle, API and browser Start, inference, logs, negative keys/routes and UID-safe cleanup passed. A separate preceding observer-blocked attempt is retained. Local runner changes are uncommitted; historical wider license-unit timeouts are not overwritten by this finite acceptance. | Phase 2 P0 can proceed. Other roles, engines, GPU lifecycle, live fault injection and wider log/host/global-setting variants remain later-phase gates. |
| DISC-01/03/04, CPU LIFE-02/07/08/09/11/12/13, ENG-01/02/03/07/09/10, MEM-01/05/06/07/10, ROUTE-02/05, LOG-01/04, failure NAV-06 and final HAR-03 · finite Phase 2 P0 model control | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase2-p0.ts), [CPU Ollama/vLLM and external live workflow](../../dashboard/apps/web/regression/models/cpu-model-control.e2e.spec.ts), [live discovery](../../dashboard/apps/web/regression/models/discovery.e2e.spec.ts), [bounded failure workflow](../../dashboard/apps/web/regression/models/failure.e2e.spec.ts), [fast contracts/components](../../dashboard/apps/web/regression/models/control.contract.spec.ts), [isolated browser fixtures](../../dashboard/apps/web/regression/models/control.browser.spec.ts), [dated acceptance](regression-test-concept.md#phase-2-live-acceptance-2026-10-05), [historical findings](regression-test-concept.md#phase-2-live-findings-2026-10-04) | 2026-10-05: canonical `reg-19887a26-0dc3-4b13-b419-7b849d247b0f` passed **140/140 selected results and all 85 required U/C/B/A/E tuples**, all eight stages and final pinned preflight. `fullPhase2Accepted: true`; no missing/failed/blocked/skipped/flaky result. Real discovery revision, CPU Ollama/vLLM lifecycle/parameter edits/inference/logs, RAM-risk rejection, external routing and the Pod-backed CrashLoop/Degraded UI all passed. Owned definitions, Pods, routes and key were cleaned; Lease free; existing vLLM definitions remain unchanged and Disabled. Runner corrections are local and uncommitted; deployed source/image/boot pins were verified. Earlier failed/interrupted attempts remain in the concept/private reports. | Phase 3 P0 can proceed. This finite CPU model-control acceptance does not certify GPU/FreeToken/sharing/global-setting workflows or every parameter set of the broader catalog; those remain separate Phase 3–4 and later gates. |
| ENG-01, LIFE-03/04, HAR-10 · retired-engine removal | **Implemented; local U/C/B checks passed** | API `test_model_lifecycle_api`, controller `test_model_lifecycle`, `ModelLifecycle.test.tsx`, `RealtimeModelForm.test.tsx`, current engine browser fixtures and harness profile tests | 2026-10-09: owning API/controller/catalog/Mesh suites, 38 Phase 3 fast checks, 31 Phase 3 and 32 Phase 4 Chromium fixture checks, and harness selftests passed against current source. FreeToken is absent from catalog/creation/routing; legacy definitions can stop/remove, while create/start/restart/edit are rejected. Historical FT/DISC-08/CACHE-07 identifiers are no longer selected; old input preparation drops the retired fixture without changing supported model pins. | No live appliance acceptance claimed. The Docker runner rebuild was blocked by workspace disk space; these results came from current-source host execution. |
| HW-01/02/03/06/08, GPU ENG-01/03, MEM-04/08/09, SLOT-01/02, LOG-01, ROUTE-01 and HAR-08 · finite Phase 3 P0 mixed-node profile | **Implemented; live acceptance pending** | [Variant/layer matrix](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [exclusive runtimes](../../dashboard/apps/web/regression/hardware/runtime.e2e.spec.ts), [scoped real diagnostics](../../dashboard/apps/web/regression/hardware/validation.e2e.spec.ts), [owning fast suites](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [Chromium fixtures](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [dated findings](regression-test-concept.md#phase-3-and-4-implementation-review-2026-10-05) | 2026-10-05: canonical `reg-52952552-c12f-4e66-bb51-a02e10768db5` passed all four complete classic GPU combinations, including inference, logs and browser Stop/Start, then blocked before FreeToken creation on an incorrect scheduler/telemetry test assumption. Exact cleanup/restoration passed. Current isolated checks passed 60/60 fast results (`reg-0b6147ed-86cb-4ca7-8539-5922bfe7da46`) and 8/8 Chromium results (`reg-c2c1f0dc-99e0-4a89-b7db-c115ec44769f`). They cover split capability/VRAM telemetry, direct model-edit receipts, current-Pod readiness, name bounds and diagnostic-report selection. 9 October 2026: the FreeToken engine and its cases were retired. The earlier evidence remains historical; a complete supported-engine live repeat is still required. | One/all-GPU verification and final clean preflight must pass together with the four supported combinations in one canonical run. Intel remains deferred; no aggregate GPU acceptance inferred from components or operator readiness. |
| SHR-01–09/11/12, SLOT-03–07/09, HAR-08 and isolated BOOT-04/05 · finite Phase 4 P0 installed-sharing profile | **Implemented; installed acceptance passed** | [Variant/layer matrix](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [sharing/slots/mixed-engine live workflow](../../dashboard/apps/web/regression/hardware/sharing.e2e.spec.ts), [exact borrowed-setting transactions](../../dashboard/apps/web/regression/core/borrowed-sharing.ts), [recovery fixtures](../../dashboard/apps/web/regression/hardware/borrowed-settings.unit.spec.ts), [owning contracts/native recovery](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [dated acceptance](regression-test-concept.md#phase-4-installed-acceptance-2026-10-05), [earlier findings](regression-test-concept.md#phase-3-and-4-implementation-review-2026-10-05) | 2026-10-05: corrected canonical `reg-5a2457ea-b62e-41ab-85eb-2b629ae63138` passed **154/154 selected results and all 71 required U/C/B/A/E/O tuples across 23 variants**, all six stages and final pinned preflight. `installedPhase4Accepted: true`; no missing, failed, blocked, skipped or flaky results. Actual AMD/NVIDIA backend transitions, mixed/same-engine inference, full/released slots, retained draft, own-slot edit, diagnostic consumer, last-slot races, reload and provider/CPU non-interference passed. Independent read-only audit confirmed exact sharing restoration, unchanged original model definitions, idle Lease and no remaining run-owned Pods. Runner changes remain local and uncommitted. Earlier failed attempts are retained, not relabelled. | BOOT-04 live driver restart/CDI recovery remains a separately authorized maintenance gate; `fullPhase4Accepted` stays false. Intel remains deferred. Product admission/actionable status for names exceeding KubeAI's 40-character limit remains open; shortening the fixture did not fix it. |
| HAR-01–03 · fixture parameter set | Implemented (isolated contract/fixture layer) | [Harness fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [read-only transport](../../dashboard/apps/web/regression/core/transport.ts), [preflight assertions](../../dashboard/apps/web/regression/core/preflight.ts) | Local fixture checks; no appliance acceptance claimed | Approved live identity, TLS/DNS, credentials and read-only observer |
| HAR-01–03 · live read-only parameter set | Implemented; selected preflight passed | [Opt-in preflight](../../dashboard/apps/web/regression/harness/preflight.e2e.spec.ts), [local runner guide](regression-test-concept.md#local-phase-0-runner) | 2026-10-01: 3/3 passed on the selected test appliance after approved model removal; final run `reg-e2bd7ab2-88c9-4f53-9b61-3c6644241656`; that historical run had no image pins. | The complete 2026-10-02 profile above adds source/image/boot pin acceptance; refresh short-lived credentials for future runs. |
| HAR-04–09 · isolated safety parameter sets | Implemented (fixture layer) | [Harness fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [CAS lease](../../dashboard/apps/web/regression/core/lease.ts), [durable journal](../../dashboard/apps/web/regression/core/journal.ts), [polling](../../dashboard/apps/web/regression/core/poll.ts) | Isolated failures and safety checks; not a substitute for all live variants | Extend the live parameter matrix as described below |
| HAR-04/06/07/08/09 · automatic lock lifecycle | Implemented; targeted verification | [Heartbeat/recovery fixtures](../../dashboard/apps/web/regression/harness/recovery.unit.spec.ts), [bounded browser actions](../../dashboard/apps/web/regression/harness/actions.browser.spec.ts), [no-resource live recovery](../../dashboard/apps/web/regression/harness/automatic-recovery.api.spec.ts), [automatic adapter](../../dashboard/apps/web/regression/core/automatic-recovery.ts) | Covers independent renewal, bounded missing response, outage reservation, parent/worker/setup journals, exact cleanup, unchanged ambiguous module receipts, conflict refusal and competing recovery. 2026-10-07: 137 harness scenarios, 7 browser fixtures and 4 no-workload Lease/Flux tests passed; typecheck and 117 Python checks passed. 2026-10-08: exact CPU auxiliary journals, finished-child expiry/drain, released-Lease absence checks and in-campaign restoration were added. 150 isolated harness scenarios, 2 guarded Chromium action tests, 64 runner/preparation/security Python checks and typecheck passed locally. Historical failures remain unchanged. | New in-campaign owned-resource restoration and CPU edit payload changes still need a live repeat; local fixtures do not certify campaign acceptance. Unfinished license/federation/physical transactions remain a visible recovery gate. |
| HAR-04/08/09 · live Lease and polling subset | Implemented; selected subset passed | [Live Lease/Flux tests](../../dashboard/apps/web/regression/harness/lease.api.spec.ts), [separate contender](../../dashboard/apps/web/regression/lock-contender.mjs) | 2026-10-01: 3/3 passed, final report `reg-acc134a7-9714-4deb-87a4-c1cd735a9b41`; prior failed attempts fixed Lease time/JSON handling | Live fencing and changed-model-generation polling are now covered by the complete profile; borrowed product sharing settings remain Phase 4 work. |
| HAR-05/06/07 · live API-key ownership subset | Implemented; selected subset passed | [Live owned-key tests](../../dashboard/apps/web/regression/harness/ownership.api.spec.ts), [fenced API adapter](../../dashboard/apps/web/regression/core/owned-key.ts) | 2026-10-01: 3/3 passed, final report `reg-4680ff39-f800-41aa-bf66-646bc2fe7577`; owned key IDs absent after teardown | UID replacement, CPU model/Pod/catalog cleanup and repeatable process recovery are now covered by the complete profile; app/identity adapter acceptance remains Phase 5 work. |
| LIFE-01/ROUTE-01/LIFE-03/LIFE-04/LIFE-06 · one CPU/Ollama parameter set | Implemented; selected live subset **Passed** | [Opt-in smoke](../../dashboard/apps/web/regression/models/cpu-ollama.e2e.spec.ts), [fenced model client](../../dashboard/apps/web/regression/core/owned-model.ts), [inference probe](../../dashboard/apps/web/regression/core/inference.ts), [UID-safe cleanup](../../dashboard/apps/web/regression/core/model-cleanup.ts) | 2026-10-01: after the earlier certificate-blocked run and its separately applied fix, selected CPU/Ollama smoke `reg-2b59fec1-29d0-4d48-b137-da9885236922` passed 5/5, including routed inference and run-owned cleanup. A 2026-10-02 rerun after `model-edit` changes passed 5/5 (`reg-87f7ce88-5b7b-4bc1-8941-a24b751d30e4`), with zero remaining cleanup entries and a passing subsequent read-only preflight. The private reports did not assess the full Phase 0 gate. | Other engines/targets, other parameter sets and broader LIFE-06 cases remain planned; browser Start is covered by the separate CPU model-edit subset. |
| LIFE-07/08/09 plus browser LIFE-04 · one CPU/Ollama context-size parameter set | Implemented; selected live subset **Passed** | [Opt-in model-edit](../../dashboard/apps/web/regression/models/cpu-ollama.e2e.spec.ts), [browser mutation fence](../../dashboard/apps/web/regression/core/auth.ts), [stale-revision model client](../../dashboard/apps/web/regression/core/owned-model.ts) | 2026-10-02: `reg-89336e71-73a4-4cac-8601-e2410a6e5ed7` passed 8/8 selected lifecycle/edit/routing cases, including context persistence after browser Start; its cleanup plan had zero remaining entries and a subsequent read-only preflight passed. Prior attempts exposed and fixed harness fence/CSRF issues and an interrupted run was journal-recovered. Runner code was local and uncommitted. | Other editable parameters, recreated same-name conflict, status-only revision behavior, vLLM/external providers and GPU targets remain planned; no full Phase 2 acceptance claimed. |
| HAR-07 · explicit model/key recovery subset | Implemented; live interruption recovered | [Recovery test](../../dashboard/apps/web/regression/harness/recovery.api.spec.ts), [journal](../../dashboard/apps/web/regression/core/journal.ts) | Isolated recovery/ownership fixtures passed; a naturally interrupted 2026-10-02 `model-edit` attempt was recovered by its recorded ownership journal and left no remaining entries. The complete profile above additionally proves a repeatable owned-process kill and independent recovery. | Additional domain-specific interruption timings need separate acceptance; never interrupt unrelated processes or steal an arbitrary stale Lease. |
| HAR-10–11 · reporting and filtered step artifacts | Implemented; local verification | [Harness fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [artifact contracts](../../dashboard/apps/web/regression/harness/artifacts.unit.spec.ts), [allowlisted report](../../dashboard/apps/web/regression/core/report.ts), [safe reporter](../../dashboard/apps/web/regression/reporter.ts) | 2026-10-08: separate evidence/scenario/step JUnit suites, portable filtered-trace archive, bounded omissions, safe component assertion names/index/categories and secondary cleanup fences. Secret-seeded archive and symlink-refusal fixtures pass; an actual local selftest report contains 150 scenarios and their step records. LicensePage's 10 tests and 39 documentation/website checks pass locally; the historical licensing failure was not reproduced. | Reports remain private; raw Playwright traces are off. Full live acceptance and particular CI attachment-viewer support remain unverified. |
| Phase 5 P0 · 42 cases / 138 tuples | **Implemented; live acceptance pending** | [Finite denominator](../../dashboard/apps/web/regression/profiles/remaining-p0.ts), [owning tests](../../dashboard/apps/web/regression/administration/owning.unit.spec.ts), [installed workflows](../../dashboard/apps/web/regression/administration/installed.e2e.spec.ts), [runner guide](regression-remaining-p0.md) | Local checks only; no Phase 5 live run during implementation | Reviewed disposable actors/apps, optional module/profile, real PKCE plugin, signed licenses, controlled OIDC/SAML fixture IdP and least-privilege cleanup |
| Phase 6 P0 · 39 cases / 123 tuples | **Implemented; physical campaign pending** | [Host drill runner](../../dashboard/apps/web/regression/core/host-drill.ts), [draft checks](../../dashboard/apps/web/regression/administration/form-checks.ts), [cache checks](../../dashboard/apps/web/regression/administration/cache-live.ts), [one-drill procedure](regression-runner-reference.md#phase-6-one-physical-drill-at-a-time) | Local checks only; no network change, reboot or cache clear during implementation | Case-specific current-boot approval and independent console recovery. Per-drill evidence cannot silently combine different boot/source pins into full phase acceptance |
| Phase 7 P0 · 12 cases / 42 tuples | **Implemented; live acceptance pending** | [Mesh](../../dashboard/apps/web/regression/administration/mesh-live.ts), [Realtime](../../dashboard/apps/web/regression/administration/realtime-live.ts), [native companion evidence](../../dashboard/apps/web/regression/administration/companion-live.ts), [runner guide](regression-runner-reference.md#phase-7-prerequisites) | Local checks only; no remote Mesh/Omni inference or four-platform CI acceptance claimed | Two distinct pinned appliances; current native build matrix; advertised Omni runtime/model and approved GPU transitions |
| Phase 8 P0 · 6 cases / 18 tuples | **Implemented; live acceptance pending** | [Security/CI checks](../../dashboard/apps/web/regression/administration/security-live.ts), [form oracles](../../dashboard/apps/web/regression/administration/form-checks.ts), [repeat workflow](../../dashboard/apps/web/regression/administration/installed.e2e.spec.ts), [scheduled advisory CI](../../.github/workflows/dependency-security.yml) | Local guards only, not a current vulnerability audit or measured live leak budget | Exact installed-commit fresh CI runs, configured controls and reviewed repeat/resource budgets |
| HAR-04–09 · remaining domain-specific variants; P1 and other unmapped IDs | Domain adapters now implemented where assigned to Phase 3–8; unassigned/P1 cases remain Planned | Follow the exact per-phase matrices and prerequisite guide above, not an ID-only pass count | No wider product acceptance claimed | Live evidence, remaining parameter sets and P1 implementation remain separate |

Update these explicit case/group entries as tests are implemented. Report unmapped IDs as Planned so they cannot disappear
from the backlog or coverage denominator.

### Regression traceability

Keep named regressions in focused owning-layer tests and in the relevant live
workflow. The important initial defect gates are:

- Sharing saved but missing Models slots: SHR-03–05, SHR-12 and SLOT-01/04/06.
- Model Starting without a Pod: LIFE-11 and LOG-02/07.
- Mixed NVIDIA/Strix Halo memory controls blocked: HW-02 and MEM-07–10.
- NVIDIA socket mount failure after boot: BOOT-03; AMD volatile CDI/stale claims:
  BOOT-04/05 and SHR-04/11.
- Polling resets/flickers inputs or Apply is enabled unchanged: LIFE-08,
  MEM-06, SHR-02, UX-02.
- Log retrieval fails with content negotiation: LOG-05.
- Initial handoff/session problems in normal browser: AUTH-09 and NAV-02.

When fixing a new live defect, add its minimal fast reproduction and a case that
verifies the affected API → intent → runtime → UI/inference chain. Update the
[phase checklist](regression-test-concept.md#11-incremental-implementation-backlog)
only after its stated gate has actually been demonstrated.
