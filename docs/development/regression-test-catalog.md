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

Dashboard execution has two immutable modes. **Non-destructive only** (default)
selects isolated suites and HAR-01/HAR-02 read-only TLS/login/installation-bound
inventory variants for each selected phase. No mutating preparation, inference,
model lifecycle, sharing, license/service change or recovery is performed. The
temporary viewer account, Job and reports are still test infrastructure writes.
Excluded preparation-dependent/destructive steps are named separately and do not
count as Passed/Failed/Blocked or full-phase acceptance. **Include destructive
tests** retains the complete existing phase requirements. Historical runs and
requests with no mode remain full; the two reports must not be compared as equal
coverage.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| HAR-01 | Resolve the configured hosts and verify TLS with the approved CA. Wrong host, untrusted certificate or unexpected appliance identity aborts before mutation. | C+A | P0 · smoke |
| HAR-02 | Compare Node UID, boot ID, engine/GPU capabilities and critical deployed image/source revisions with the requested lab profile. Missing expected hardware cannot silently shrink the matrix. | C+A | P0 · smoke |
| HAR-03 | Observe an offline API/host, pending maintenance or unrelated busy workloads at preflight. Report Blocked with a reason; do not reboot, delete workloads or force a lock. | U+C+A | P0 · smoke |
| HAR-04 | Start two mutation runs against the same appliance from independent runner contexts. Only the lock owner proceeds; a lost heartbeat/lease prevents new mutations. Dashboard stale-lock recovery binds the confirmed UID/resource version; active owners, changed locks and unavailable external journals are refused. | U+C+B+A | P0 · functional |
| HAR-05 | Create a run-owned resource and record its name/UID before subsequent work. On teardown remove only journal-owned resources, preserving a same-prefix but different-UID resource. | U+A | P0 · smoke |
| HAR-06 | Fail a test after model/key/app creation. Collect safe evidence, then clean up Pods, intent, routes, allocations and keys without hiding the original error. | U+A | P0 · functional |
| HAR-07 | Interrupt the runner and resume its cleanup journal. Ambiguous requests are inspected before retry; orphaned ownership or cleanup failure remains visible. Recovery-only Dashboard intent restores the exact old journal and unchanged borrowed settings, verifies absence and releases its expired Lease; no test phases, historical outcome rewrite or forced unlock. | U+C+B+A | P0 · functional |
| HAR-08 | Change a borrowed global setting, then simulate an intervening human revision. Restoration must not overwrite that revision; report the remaining difference for review. | U+C+A | P0 · sharing |
| HAR-09 | Exercise stage deadlines and polling with delayed status/generation updates. Old Ready state is not accepted for a new intent; failure includes the stalled stage. | U+C+A | P0 · smoke |
| HAR-10 | Generate a report with failed, blocked, skipped, unimplemented and retry-passed cases. Required gaps cannot yield a green profile or a successful empty run. In System regression execution, select all phases by default or a nonempty subset of phases 0–8; persist the immutable selection and selection-bound progress/results across reloads without running or crediting other phases. Empty/invalid selections and changed idempotency selections are rejected before new writes. Distinguish blocks caused by prerequisites from blocks caused by failures, retaining the original blocking check and trace when recorded; cancellation and unrecorded causes remain separate. Show reason, phase/variant/layer, stage and next action; allow only sanitized archive/HTML/JUnit downloads. Administrators can enable/register/start/cancel/download without a product license or license-status dependency; test registration is not license activation. Show pending runner activation separately from the readiness wait, without duplicate enables, fabricated percentage progress or automatic test starts. Offer immutable non-destructive/full selection; list deliberately excluded steps separately, never as passed tests or full-phase acceptance. | U+C+B | P0 · fast |
| HAR-11 | Seed synthetic credentials into fixture headers, dialogs, logs and auth state. Public/sanitized artifacts omit them; raw live state is restricted and deleted by policy. | U+C+B | P0 · fast |

HAR-10 and UX-02 also verify report presentation: **All checks** uses complete
case/variant/layer totals, including runner and cleanup errors; **Executable
scenarios** is a separate, initially closed detail view. Each uses its own blocked
causes. Live evidence remains separate, overlapping phases and a limited failure
list do not redefine totals, and missing final data never means zero failures.
100% progress means execution finished, not passed. HTML/text use evidence-first
ordering; JSON/JUnit retain their original units and historical results stay intact.

## 2. Authentication, sessions and role boundaries

Repeat role checks for administrator, operator, viewer and an ordinary identity
without dashboard-management grants. Follow the current shared role contract.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| AUTH-01 | Complete a real local OIDC login and reach the dashboard at the intended route. `/api/session` identifies the correct actor and effective roles. Check opt-in Remember me defaults/migration and browser-restart persistence without changing ordinary limits. | C+B+A+E | P0 · smoke |
| AUTH-02 | Open a protected dashboard/API route without login. Browser enters the expected login flow; direct unauthenticated API access reveals no inventory or mutating capability. | C+A+E | P0 · smoke |
| AUTH-03 | Use expired/invalid tokens, an untrusted client/audience and malformed authorization. API denies access without trusting client-supplied identity/role headers. Verify automatic short-token refresh, normal idle expiry and the absolute Remember me maximum despite activity. | U+C+B+A | P0 · identity |
| AUTH-04 | Test every mutation family with viewer/ordinary-user sessions and direct API requests, not only hidden controls. Model/module/app operations follow role policy; all administrator-only operations are denied. | C+A+E | P0 · identity |
| AUTH-05 | Omit or forge browser CSRF/origin headers on cookie-authenticated mutations. Reject without saved intent; valid same-origin and supported terminal Bearer requests still work. | U+C+A | P0 · identity |
| AUTH-06 | Log out and revisit/reload a protected page with old session state, including a remembered session. No stale privileged content/action is treated as authenticated; old logged-out data cannot refresh. | B+A+E | P0 · smoke |
| AUTH-07 | Expire a session while a form/log dialog is open. Show a clear sign-in state, stop unauthorized polling/mutations, and recover after login without false success. | B+E | P1 · functional |
| AUTH-08 | Revoke/change a role and refresh authorization through the normal session lifecycle. Previously visible controls cannot bypass current backend checks. | U+A+E | P0 · identity |
| AUTH-09 | Re-enter incomplete first setup with the same console code after a lost response, expired cookie, partial failure or another browser. Preserve non-secret saved fields and independent sessions; only successful completion closes code/cookie access. Open the setup-to-dashboard handoff with stale browser state; no redirect loop, blank screen or persistent protocol failure. | U+C+B+E | P1 · functional |
| AUTH-10 | Simulate Keycloak/API unavailability. Distinguish authentication service failure from bad credentials; do not allow cached privilege or an unauthenticated fallback. | U+C+B | P0 · fast |

## 3. Navigation, Overview and System Status

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| NAV-01 | Visit every primary page and Settings/System/System Status subtab allowed to each role. Models precedes Services, Mesh is below API Access, and Model cache/Regression tests appear only in the administrator's nested status bar. Restricted direct hashes cannot mount privileged controls. | B+E | P1 · smoke |
| NAV-02 | Reload/deep-link, use Back/Forward and test legacy Settings/Network/Updates/Mesh/Model cache/Regression hashes. Resolve to the canonical page without losing the authorized session. System Status tabs use `#/system/status/<section>` with Overview as the default. | U+B+E | P1 · functional |
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
| MOD-03 | Enable an approved idle standalone optional service through UI; observe `ModuleActivation`, required dependencies, Flux/controller conditions and an actual usable service in the registered local/public/direct connection scope. A local run does not probe public example-domain URLs or another appliance's names. Certificate validity is checked by HAR-01, not this functional probe; missing routes, DNS/connection failures and unexpected HTTP status still fail. Empty instance-provider bases are not substitutes. An enabled idle baseline may be borrowed and must be restored exactly. | A+E | P0 · functional |
| MOD-04 | Disable that module via API; observe teardown and Disabled in UI. Preserve dependent user data per module contract and restore any borrowed enabled/disabled baseline and optional parameters exactly. Receipts remain bound to the original worker, UID and confirmed revision. | A+E | P0 · functional |
| MOD-05 | Repeat an in-progress action and conflicting/stale configuration write. Avoid duplicate intent/workloads; conflict or progress is clear and refreshable. | U+C+A+B | P1 · functional |
| MOD-06 | Apply valid/invalid module parameters and a generic AMD profile change. Validate catalog-owned fields, persist/reload, and preserve separately configured GPU sharing. AnythingLLM offers separate typed initial model lists; stale choices block enable, saved parameters survive re-enable and native preferences/indexes take precedence at initialization. | U+C+B+A+E | P0 · functional |
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
| DISC-01 | Open Create and switch Local/External, engine and target. Validate unique 1–63-character model names with inline errors before any create request; API rejects invalid labels. Offer current catalog/capability options and meaningful unavailable reasons. Detect Chat/Embedding from preset or registry metadata, require a manual task only when unknown and clear it on model changes; resolve automatic tasks before persistence. | U+C+B+E | P0 · functional |
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

LIFE-03/LIFE-06 owning-controller coverage includes foreground UID/revision-bound
deletion, legacy ownership, repeated cleanup, deletion conflicts and terminal or
terminating Pods retained after Model deletion. These Pods keep `Removing` and
the activation finalizer; a zero exit code does not count as complete cleanup.
The existing `phase3-gpu nvidia-lifecycle` selection repeats routed inference,
Stop, runtime/slot release and Start three times without increasing stop deadlines.
Controller checks alone do not prove that the host container runtime drains.

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
| MEM-01 | Estimate vLLM/Ollama weights, rank/layer KV/recurrent/auxiliary caches, runtime and separate uneven-placement/headroom allowances. Show serving/startup RAM envelopes without calling file cache another permanent model copy; new RAM defaults do not overwrite saved/manual budgets. Calculator and Breakdown use matching split totals and per-copy replication budgets. Host runtime/download are not multiplied for a split Pod; missing metadata/capacity stays unknown. | U+C+B | P0 · fast |
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
Fresh exclusive installation defaults require no manually saved sharing intent.
HAR-08 records absent/empty fields separately, restores exclusive backend
readiness before unsetting borrowed intent, and fences ambiguous writes or
foreign revisions rather than adopting custom/inherited sharing.

The owning NVIDIA DRA controller checks also cover missing completion markers,
restart at each reverse-handoff step, foreign/reserved claims, terminating and
terminal-but-still-present driver Pods, external chart/selector/configuration,
and actual plugin capacity before Ready. HAR-07/08 deadline counterexamples
keep the current `gpu-backend` stage, retained borrowed intent and exact Lease.
Existing `phase4-fast` owning selection and `selftest` discover these checks;
installed recovery and sharing remain separate acceptance evidence.

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
| MGPU-01 | Distribute one ordinary vLLM/Ollama model across 2 and 4 NVIDIA GPUs on one node, including different models and capacities, in Exclusive and Shared modes. Select exact cards from one keyboard-accessible checkbox list; no primary-card dropdown or automatic count. Verify physical capacity from DRA inventory even when live totals differ or one card lacks metrics; reject unknown capacities or foreign nodes and explain disabled choices. Bound equal per-card budgets by the smallest unreserved/physical ceiling; vLLM workers apply equal MiB budgets on unequal GPUs. Create/Edit show total VRAM estimates, inputs, matching Breakdown component totals and a 100% maximum bounded by the least unreserved selected card; explanations expose exact MiB arithmetic. Accept a legal total larger than one card, convert it to per-card reservations and preserve untouched/reverted saved budgets. Persist exact selections, including missing saved identities until explicitly unchecked; reject missing, mixed, full or physically oversized groups without partial reservation. Observe all DRA claims, memory use on every card, routed inference, UI/logs, edit, Stop/Start, per-card slot release and exact backend restoration. Host RAM/CPU and download remain separate one-Pod/one-download quantities; replicated copies retain full per-copy controls. | U+C+B+A+E+O | P0 · gpu/sharing |
| MGPU-02 | Replicate a complete ordinary vLLM/Ollama model on 2 and 4 same-node NVIDIA cards, including different models and capacities, in Exclusive and Shared modes. Select cards through the same explicit checkbox list; identical inventory cards remain selectable despite differing live totals or missing metrics. Persist explicit replicated mode; validate full per-copy VRAM and combined RAM/CPU reservations without multiplying per-copy Breakdown values twice; keep exact per-copy claims, slot counts, status and bounded logs. Route independent requests through one public alias, withdraw unhealthy copies individually, drain on edit, and verify Stop/Start/removal plus exact backend restoration. Reject mixed/split strategies and foreign ownership. | U+C+B+A+E+O | P0 · gpu/sharing |

The existing MGPU-01 owning selection also runs the optional vLLM 0.31.0 PLE
backport contracts in `test_vllm_wrapper.VllmWrapperTests`: storage-byte width,
exact native version/checksums, all-files-before-write validation, idempotence,
ambiguous-source rejection and fatal startup failure. On 13 October 2026,
those local contracts passed together with a bounded, administrator-authorized
four-A6000 Flash-Next trial: native byte-exact FP8/BF16/FP32 lookup, original
SM86 negative control, full startup/health and an actual KubeAI-routed answer.
Standard model-precision KV was required; explicit FP8 KV failed in a separate
QSA kernel. The private trial does not satisfy the complete MGPU-01 hardware
matrix or Phase 3/4 gate and did not test the public LiteLLM HTTPS/key path.
See [the qualification boundary](model-integration.md#ordinary-vllm-runtime-upgrades).

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
| K8S-05 | Download/copy kubeconfig in its own private export context. Wait for the current user's API/copy acknowledgement, reject stale clipboard contents and compare the complete copy and actual downloaded file with the current export. Correct control-plane address, cluster/identity CA and exec metadata; no token/password/refresh token/client secret. Clear the clipboard, delete the private download and never upload contents as an artifact. Export needs neither the exec plugin nor a cluster-admin grant. | U+C+A+E | P0 · identity |
| K8S-06 | Switch/remove access; only one direct access group remains and audit output is sanitized. Sign in afresh after each session-invalidating change and verify a fresh OIDC token is denied after revocation; do not mistake a stale session for successful revocation. Protected/disabled users cannot gain grants; disabled-user rejection must be the expected conflict, not an unrelated API outage. | U+C+A+E | P0 · identity |

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

18 October 2026: **temporarily excluded from regular regression** by the
[repository test policy](../../dashboard/apps/web/regression/core/lab-policy.ts).
The implemented P0 cases `RT-01`–`RT-04` and `RT-08` remain defined, but are neither
executed nor required at any regression layer, including direct live-case
selection. Automatic setup omits Omni fixtures and inherited Realtime approvals.
Reports disclose the exclusion rather than counting these cases as passed or
blocked. The P1 cases below remain planned. Product Omni support is unchanged;
restore regression selection after the Realtime implementation is ready.
Historical failed reports retain their original evidence.

Ordinary Ollama/vLLM OpenAI-compatible chat is not a claim of Realtime support.
Use only the advertised profile, compatible image, reviewed model and admitted
one-/two-device stage plan. Microphone/intelligibility is a manual live case.

| ID | Action and expected proof | Layers | Gate |
|---|---|---|---|
| RT-01 | Create/edit Omni through the common local-model form at desktop/mobile widths. Persist `engine: VLLM` plus Realtime settings; share CPU controls, preserve custom sources/images/stage memory, disable unchanged/reverted drafts and retain the opening revision during polling. Do not inherit ordinary engine memory/offload fields. Installed browser creation uses exact request fencing and UID-bound cleanup before independent runtime evidence. | U+C+B+A+E | P0 · realtime |
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
| SEC-03 | Test pinned dependency vulnerabilities, secret scan, unsafe product/global TLS disablement and unbounded parsing/input fixtures. The scoped functional regression certificate policy is not a product TLS exception; HAR-01 and credential bootstrap remain strict. Existing security checks fail actionable regressions without silently dismissing alerts. Full acceptance also requires fresh successful fixed-workflow advisory and redacted secret-scan CI runs for the exact installed commit; offline checks alone cannot certify current advisories. | U+C+A | P0 · fast + fresh CI |
| SEC-04 | Inspect generated routes/policies/RBAC and credential references. No broader Secret read, public exposure or namespace ownership appears from an ordinary feature change. | C+A | P0 · identity |
| UX-01 | Walk pages, dialogs, help and actions by keyboard/touch at desktop and narrow mobile widths. Labels, focus/return, Escape, error announcements, contrast and table/log overflow remain usable; status is not conveyed by color alone. | B+E+N | P1 · functional |
| UX-02 | Verify accordions/defaults, loading/empty/error states and unchanged/changed/reverted fields across every settings form. Regression All checks totals and closed scenario details retain their separate evidence units across reloads, including missing final data. Polling cannot erase drafts or trigger actions. | U+B+E | P0 · functional |
| UX-03 | Smoke real auth/navigation/create/edit/lifecycle in secondary supported browsers after Chromium baseline. Report WebKit/Firefox emulation limits rather than claiming physical iOS/Safari certification. | B+E+N | P2 · functional |
| UX-04 | Exercise shared CLI/TUI read/form/confirmation contracts with the same API data. Role, units, memory/slots and errors agree; no client-specific authorization or workload path. | U+C | P1 · fast |
| PERF-01 | Measure dashboard/API/inference response and model stage timings under reviewed small-fixture workloads. Record cold/warm/engine/hardware separately and regressions against an approved baseline. | A+N | P1 · soak |
| PERF-02 | Repeat create/infer/edit/Stop/Start/Remove cycles and check intent/Pod/claim/key/route counts plus RAM/disk growth. No unbounded orphan or leak; cache growth is separate and credential-object lifecycle is checked in isolated controller fixtures. | U+C+A+N | P0 · soak |
| PERF-03 | Keep concurrent shared models serving bounded requests over a reserved long run. Both remain responsive, resource contention/errors are visible and no isolated-throughput/memory guarantee is inferred. | A+N | P1 · soak |
| PERF-04 | Disrupt only a run-owned backend/controlled fixture connection. Bounded retry/recovery and subsequent inference work without resource amplification or endless aggressive polling. | U+C+A+N | P1 · soak |

## Implementation ledger

24 October 2026, existing APP-02/APP-06 Hermes adapter follow-up: the application
workflow formerly treated the native terminal as a missing generic chat form.
Automatic preparation now selects `hermes-terminal-v1`, following the pinned
[ChatPage](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/web/src/pages/ChatPage.tsx)
and its same-channel notification-only events feed. The browser types the prompt
through xterm, verifies the exact local model/provider and session's fresh,
successful terminal turn, and exercises the native response-copy button with
clipboard acknowledgement and clearing. Lazy bootstrap is not full agent or
inference proof; sidecar/configuration data, foreign sessions, stale/replayed
events, partial/error turns and prompt echoes cannot pass. Existing HAR-10
fixture/safety and functional HTTPS Chromium scenarios cover those boundaries,
including stale clipboard rejection. Built-in adapter mismatches fail instead
of inventing an external prerequisite. No scenario registrations, IDs, variants
or layers were added. Matching native acceptance and the remaining applications
are still required; historical reports remain unchanged.

24 October 2026, Phase 5 MOD-06/KEY-04 follow-up: the latest mixed-GPU lab run
confirmed that the profile intent was saved while the immediate Hardware reload
still displayed the preceding controller projection. MOD-06 now waits for the
same UID, generation and complete spec plus matching observed generation,
selected profile and experimental flag. It verifies the reload without changing
the expected value, then verifies restored-profile projection separately; missing
or stale observations time out, while foreign revisions and API errors fail
immediately. The existing MOD-06 safety scenario covers those paths.
KEY-04 also assumed the installer's valid master credential had a user-token
`sk-` prefix. The fixture now accepts bounded opaque header-safe credentials from
the existing administrator API, keeping authentication, hash-only URLs, zero
inference budget and exact metadata-bound cleanup. Its existing lifecycle and
foreign-record counterexamples retain both credential formats and reject header
injection/oversize values. No campaign cases, variants or layers were added.
These are source/isolated corrections; matching native retests remain required.
Historical failures and the separate native application-adapter gap are unchanged.

24 October 2026, HW-06 binding-diagnosis follow-up: the four-NVIDIA-card lab's
single-card and all-card requests each left a completed native Ollama Job, but
the existing runner classified a later binding-proof rejection as an unspecified
`CAPABILITY` prerequisite. Binding postconditions now fail at `gpu-binding`,
with a fixed private check code for engine/node, legacy resource, Pod/claim,
claim allocation, Slice/UUID or runtime-image evidence. Exact-card prerequisites
are still checked before submission, and all existing UID/UUID/allocation/image
assertions remain in force. The Slice proof now uses the exact driver/pool/device
identity and only its complete highest generation, as required by the
[pinned Kubernetes ResourceSlice contract](https://github.com/kubernetes/kubernetes/blob/v1.36.4/staging/src/k8s.io/api/resource/v1/types.go).
The existing HW-06 safety cases reproduce the wrong Blocked classification and
the previous rejection of legitimate retired/foreign-pool Slices; they also
reject foreign-only, incomplete, conflicting and wrong-UUID current pools and
verify the private diagnostic. No additional campaign case, variant, layer or
scenario is selected. This repairs a reproduced protocol mismatch and narrows
the remaining native diagnosis; the old artifacts do not prove it caused that
native binding discrepancy or establish live HW-06 acceptance. A fresh matching
runner execution must verify that remaining path; old reports stay unchanged.

24 October 2026, MOD-06/HAR-10 profile-fixture follow-up: a device with its only
advertised AMD profile already selected was always missing an alternate fixture.
Automatic preparation now also uses the existing UI's **Upstream operator rules
only** choice (`profileId: ""`). Readiness distinguishes that explicit value
from a missing choice and rejects unchanged, unknown or unapproved alternatives;
an unknown current override is not borrowed because it could not be restored
through the catalog validator. Two counterexamples in the existing
[`input-preparation.unit.spec.ts`](../../dashboard/apps/web/regression/harness/input-preparation.unit.spec.ts)
reproduce the old omission and empty-value rejection, then cover both valid
choice directions and reject ineligible/missing hardware. They remain selected by `selftest`.
The installed MOD-06 workflow still writes through the real Hardware UI and
verifies saved parameters, unchanged GPU sharing and exact original spec
restoration. Fresh image CI and an installed Phase 5 execution are required;
preparation readiness itself is not live test evidence.

24 October 2026, LIFE-02/ENG-01 CPU acceptance follow-up: fresh regular
Kubernetes Phase 2 runs with source `3948d35` images passed on both registered
lab appliances, including the AVX2-only CPU. Each recorded 580 passed checks,
zero failures/blocks and 48 passed live checks, with resource cleanup verified
and the generated account removed. CPU vLLM creation, routed inference,
revision-safe editing, Stop/Start and removal completed through the normal
workflow. This accepts the targeted CPU runner correction, not the GPU matrix
or a complete Phase 0–8 campaign; earlier failed reports remain unchanged.

24 October 2026, SEC-03 fresh-advisory follow-up: the exact installed `fffed82`
audit detected high findings in Vite, Zod and Undici, plus two moderate findings
in Vitest's mocker. Update only the pinned affected dependencies to Vite 8.2.4,
Zod 4.6.6, Undici 8.12.2 and Vitest 5.0.3, and regenerate the frozen dependency
inventory. The existing supply-chain owning selection executes
[`test_regression_security.py`](../../tests/test_regression_security.py), whose
new downgrade counterexamples reject the previous versions, including duplicate
locked copies. The strict registry audit remains unchanged; an offline minimum
version check cannot establish that no newer advisory exists. Existing client,
contract and browser-fixture suites cover unchanged validation and runner
consumers. Matching source CI, rebuilt images and fresh installed Phase 8
acceptance remain required; the previous failed audit is not reclassified.

23 October 2026, MOD-03/04/APP-02 gateway follow-up: both appliances recorded
an Envoy 1.38.6 exit 139 during service/route changes; on Strix the proxy exited
at the failed API read and the borrowed service remained applied. Pin 1.38.7
consistently in the controller default, identity/setup EnvoyProxy and isolated
session fixture. Upstream's
[SDS provider lifetime fix](https://github.com/envoyproxy/envoy/commit/159c19f759b15c418128872a428f629e51f117a1)
ensures main-thread destruction; stripped appliance traces do not establish
that exact C++ frame as the crash site. The owning SetupGatewayTests enforce
the coordinated immutable pin. Existing gateway-stability counterexamples keep
rejecting exit 139, replacement, restart, OOM and unavailable observations,
while installed module workflows still require stable gateway processes and
exact restoration. Local renders/protocol fixtures do not replace a fresh
installed Phase 5 test. Historical failed reports and cleanup locks are untouched.

23 October 2026, MGPU-01/02/UX-02 isolated test synchronization: the NVIDIA
startup-RAM component case now waits for the matching two-card and changed-context
estimate responses rather than racing a debounced request against a DOM deadline.
Both vLLM and Ollama still require the 18,000 MiB default, the updated 22,000 MiB
recommendation and the unchanged manually selected/saved 20,000 MiB budget.
No production timeout or memory default changes. MESH-01's independent module
snapshot uses the registered appliance namespace, rejecting foreign namespaces.
These are isolated counterexamples, not new installed acceptance.

23 October 2026, MESH-01/HAR-10 navigation follow-up: the installed read-only
Mesh settings check now compares independently observed ModuleActivation UIDs,
generations and full persisted specs rather than the volatile `/api/modules`
status response. Named steps separately prove unchanged Mesh configuration,
unchanged module intent and no attempted writes. A focused counterexample in
[`safety.unit.spec.ts`](../../dashboard/apps/web/regression/administration/safety.unit.spec.ts)
fails with the former whole-object comparison and permits status/resourceVersion
updates and reordered lists only. Changes to enabled flags, parameters, resource
identity or generation, deletion, new/removed modules and malformed observations
remain failures. The existing Phase 7 fast selection executes this owning unit
coverage; a fresh installed MESH-01 run remains required. The historical
Aimonster trace lacks a before/after payload diff, so the exact fluctuating
status field is not claimed as established.

23 October 2026, HAR-07/08/10 cleanup-receipt scope follow-up: a restored root
baseline and a later independently cleaned Playwright worker must remain
verifiable together. The previous aggregate-only fingerprint incorrectly marked
that Phase 5 sequence as unknown. New private receipts retain the whole-run hash
and add a hash of their own journal scope; the evaluator checks every mutated
scope independently after checking the complete inventory and stopped processes.
Focused counterexamples in
[`execution-lifecycle.unit.spec.ts`](../../dashboard/apps/web/regression/harness/execution-lifecycle.unit.spec.ts)
first reproduce the false fence and then reject changed root/worker receipts,
open resources, malformed evidence and missing legacy proof. Existing `selftest`
and `phase4-fast` selections execute them. No new public API/UI or historical
report migration is needed. This is isolated coverage; a new installed Phase 5
run still needs to prove the native cleanup path.

23 October 2026, HAR-10 Phase 1 evidence-scope follow-up: the reporter and
launcher now share the existing profile's per-step requirements. A passing
`core-smoke` must remain passing when finalized after verified cleanup; it must
not demand the seven case families owned by session, fixture and final-preflight
steps. Focused counterexamples in
[`reporting.unit.spec.ts`](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts),
selected by the existing `selftest` in every phase, reproduce the old seven
synthetic dependencies and one `MISSING_EVIDENCE` failure. They also reject a
genuinely absent selected check or full-phase layer, preserve real cleanup
failures and verify that the complete Phase 1 matrix is unchanged. This records
isolated coverage, not acceptance of a new installed run; existing failed
Strix/Aimonster reports remain unchanged.

22 October 2026, HAR-07/HAR-10 process-lifecycle follow-up: Linux process-group
inspection distinguishes exited Z/X tasks from live R/S/D/T workers, rejects
unreadable/recycled identities and zombie leaders with remaining live threads,
and retains bounded private process diagnostics.
The runner bundles a subreaper for Docker and Kubernetes command overrides;
signal forwarding preserves the coordinator's teardown window. Existing
[`execution-lifecycle.unit.spec.ts`](../../dashboard/apps/web/regression/harness/execution-lifecycle.unit.spec.ts)
adds synthetic process-state counterexamples and actual Linux fork/adoption
probes (explicitly skipped on non-Linux hosts). `selftest` and `phase4-fast`
select these tests. Existing recovery/reporting specs in the same selections
cover exact terminated run/Job/Pod/container and node binding, changed session/
UID/revision rejection, repeated regular cleanup and original failure attribution.
Termination proof alone never proves resource removal; historical session and
report contents remain unchanged. These are isolated checks, not Strix Phase 0
or installed-appliance acceptance.

22 October 2026, HAR-10 and UX-02 report-count follow-up: the Dashboard and new
HTML/text exports show all check evidence before executable scenarios. The shared
public-safe report fixture retains 441/3/18 total, 345/0/1 scenarios and 8/3/18
live evidence, including unassigned runner/cleanup failures. Existing owning
component/API and reporting suites cover failed preparation, cleanup/export
failures, multiple evidence rows per scenario, overlapping phases, truncated
case lists and missing/legacy totals. Desktop/mobile Chromium fixtures in
[`regression.browser.spec.ts`](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts)
check closed details, keyboard use, reload, no overflow and unchanged read-only
refresh; existing start/cleanup scenarios remain in the same Phase 4/8 fixture
selections. This is isolated source/fixture coverage, not installed acceptance.
No historical report or test-server state was changed; the actual runner/cleanup
failures in the original report remain failures.

22 October 2026 CI follow-up: the exact-layer catalogue check also discovers the
separate `auth-sessions` browser selection without running it or crediting its
results to Phase 5. Dashboard build and browser workflows use the same source
paths, including identity changes. The existing promotion contract rejects drift.

22 October 2026, HAR-07/08/10, SLOT-09 and SHR-12 follow-up: Phase 4 now uses
the existing discovered selection in separate sequential scenario processes,
with independent execution/teardown budgets. The selected/started/completed
ledger preserves interrupted evidence. Open root/worker/model journals override
report flags; exact recovery and independent absence/backend/Lease checks produce
fingerprinted cleanup receipts. Tests, resource cleanup and credential removal
have separate status. Focused counterexamples live in
[`execution-lifecycle.unit.spec.ts`](../../dashboard/apps/web/regression/harness/execution-lifecycle.unit.spec.ts),
selected by `selftest` and `phase4-fast`; existing recovery/reporting, API/operator
and regression-page fixtures cover the shared contract. Real short-lived child
processes verify signals, timeout, delayed writers and teardown after a test
timeout without GPUs. SHR-12 changes state before reload; HAR-08 changes borrowed
state before restoration, so empty cleanup cannot certify either. This is source
coverage, not a new installed acceptance: exact old-journal recovery, slot race,
reload/restoration and then full Phase 4 still require an authorized rollout.

22 October 2026 Remember-me deployment correction: AUTH-01's existing owning
policy selection now checks that only the mounted session-policy ConfigMap is
excluded from Flux variable substitution. Public release checks additionally
discover `RememberMeFluxBuildTests` in the same owning test file and run the
actual strict Flux post-build. They preserve the runtime script byte-for-byte,
substitute identity hosts, reject the original unprotected script, and reject
missing variables in other resources. The in-Appliance runner still needs no
Flux CLI; CI render evidence is not credited as installed login acceptance.
The previous successful script/routine renders did not cover strict post-build
substitution; historical results remain unchanged.

21 October 2026 Remember-me follow-up: AUTH-01's
`remember-me-policy-contract` is selected by Phase 1 `smoke-fast` and runs the
owning [realm/migration counterexamples](../../magic-cluster/platform/identity/tests/test_remember_me.py).
The separate, explicitly selected `auth-sessions` profile runs
[real Keycloak/Envoy Chromium checks](../../dashboard/apps/web/regression/auth/remember-me.browser.spec.ts)
for AUTH-01/03/06: idle versus maximum expiry, automatic refresh, persistent
browser restart and logged-out state rejection. The browser CI `identity-sessions`
job owns this Docker-host gate; native Kubernetes campaigns never require Docker
or mark these isolated protocol results as installed A/E proof. New installation,
unchanged-default migration, repeat start, custom preservation and failed/ambiguous
write behaviour remain owning U/C evidence. Existing installed login/logout and
API token-denial scenarios retain their scope; new installed Remember-me
acceptance requires a fresh opt-in login after idle deployment. Historical
reports and earlier finite-profile acceptance are not changed.

Local verification on 21 October: all 86 identity owning tests (including ten
Remember-me policy/migration cases), 19 Phase 1 fast scenarios, 19 Phase 1 browser
fixtures, 307 harness selftests and four real Keycloak/Envoy protocol scenarios
passed. The original import and Jackson empty-marker formatting were rejected by
focused counterexamples before correction. Regression typecheck, identity/Flux
renders, source-license and documentation checks passed. CI/publication is not
implied. Monster still had an active campaign during this implementation; its
policy was left unchanged pending an idle, guarded migration and a fresh login.

20 October 2026 first-run follow-up: HAR-10 status checks cover an absent,
disabled or still-installing optional runner with no runtime metadata,
registration or run history. A forbidden test-Lease read is reproduced without
granting extra authority; first status exposes Enable with an unverified lock.
Retained evidence still makes the actual forbidden lock read fail. The existing
Kubernetes owning selftest selects these API/HTTP counterexamples, and Phase 8
Chromium fixtures cover empty revision/blocked-lock enable, reload without writes
and the subsequent register/start flow on desktop and mobile. These isolated
checks do not by themselves prove a completed live campaign.

20 October 2026 promotion follow-up: SEC-03's supply-chain owning selection now
includes `test_dashboard_image_promotion`, in addition to public/build CI. Real
local bare-Git counterexamples cover concurrent runner and human commits,
exact-source runner/public CI inheritance only for content-proven generated
pin/inventory deltas, failed/pending-check rejection, preserved foreign metadata,
newer-runtime supersession, lost push acknowledgements and three-attempt limits.
Navigation-only inventory refreshes are checked against exact committed source
lines; a fabricated line number cannot inherit a parent check.
These are isolated U/C checks; no live appliance campaign or successful remote
promotion is inferred from them. Existing HAR-02/10 runner-promotion checks remain
selected by the Kubernetes harness selftest.

20 October 2026 release-CI follow-up: HAR-02/10 and SEC-02/03 report-server
counterexamples reject noncanonical identities, private/traversal filenames,
symlinks, oversized files and blocking special files. A directory-swap test
retains the opened run's identity, and HTTP tests exercise all four allowed
products. These owning tests remain selected by `harness/kubernetes.unit.spec.ts`
in `selftest`. CHANNEL-02's selected `RegressionGuardTests` reject resource
prefix/suffix/URL confusion; SEC-04's existing Phase 5–8 fast permission test uses
exact API-group matching and still rejects unexpected Secret permissions.
This is isolated regression coverage, not new appliance acceptance. Successful
CodeQL and runner-image CI for the exact published commit remain separate gates;
no alert, required case or TLS check is suppressed.

v0.1.3 preparation: existing SEC-02/03 owning security checks now reject old or
divergent PyJWT pins and missing Python advisory coverage for the API and Mesh
graphs. The runtime-update workflow contract requires a retained, validated patch
and an explicit manual-review warning when enterprise policy prevents automatic
PRs; resolver/test/render failures remain fatal. Private setup tests exercise the
macOS CA probe's TLS 1.2 floor, hostname binding and certificate rejection. These
are isolated owning-layer checks, not a new full campaign or hardware acceptance.

AUTH-09 initial-setup retry coverage (19 October 2026): the actual setup server's
independent sessions, expiry, legacy-session compatibility, partial completion,
credential-cleanup failures and serialized completion have isolated owning tests
in [test_setup_sessions.py](../../magic-cluster/platform/identity/tests/test_setup_sessions.py).
[Setup browser fixtures](../../dashboard/apps/web/e2e/setup.spec.ts) exercise its
real embedded HTML/JS at desktop/mobile widths, including the `Claimed` screen
without a cookie, another browser, a lost response and retained draft fields.
Both files are selected by existing identity-unit and dashboard-browser CI.
First-run setup remains outside the installed Phase 0–8 P0 campaign; this does
not claim full AUTH-09 live handoff or physical installer acceptance.

22 October 2026 AUTH-09 upgrade follow-up: the host's Flux bootstrap migrates
only the owned single-replica setup Deployment before server-side apply. Owning
[counterexamples](../../magic-host/roles/flux-bootstrap/tests/test_setup_strategy.py)
cover absent/current/legacy state, foreign identity, stale or lost writes and
unchanged Pod configuration. Public release checks select these tests plus the
`setup-upgrade` job's [real API contract](../../magic-host/roles/flux-bootstrap/tests/setup_strategy_contract.py)
on disposable Kind. It reproduces the retained `rollingUpdate` rejection
(including explicit null), checks actual Kubernetes revision preconditions,
migrates without replacing the UID, then repeats migration and Flux-like apply.
It runs with zero replicas and is not installed Phase 0–8 or physical setup
acceptance. External GitOps upgrades use the documented identity recovery path.

18 October 2026 license follow-up: LIC-02 previews both supported editions without
activation; LIC-03 independently verifies invalid-document rejection and unchanged
active state; LIC-04 alone tests activation, stale CAS and API-restart persistence.
The installed adapter uses the normal context request guard instead of racing a
second page route against polling/teardown. Equal-document imports may retain the
same resource version. A registered, document-only restoration binds the Secret
UID, installation, confirmed revision, original/candidate hashes and preserved
unknown fields. Unsent, confirmed and lost-response paths, interrupted restoration,
foreign edits and unfinished legacy receipts have focused counterexamples in the
[transaction tests](../../dashboard/apps/web/regression/administration/license-workflow.unit.spec.ts)
and [real-UI fixtures](../../dashboard/apps/web/regression/administration/license-review.browser.spec.ts).
These are selected by selftest and Phase 5 fast/fixture profiles. Targeted installed
LIC-02–04 acceptance and a new complete Phase 5 run remain separate gates; the
earlier failed report is retained unchanged.

The first targeted installed follow-up passed LIC-03 and LIC-04, including the
API restart, exact original-document restoration and final preflight. LIC-02
exposed an invalid Commercial fixture missing `commercial-production`. Both
Commercial entitlements are now generated; a cross-language fixture contract
calls the actual product verifier and rejects a correctly signed Commercial
document missing that entitlement. The repeated installed run remains a
separate acceptance gate; the failed fixture report is retained.

17 October 2026 Kubernetes follow-up: K8S-02–06 execute independently with separate
owned identities and cleanup, rather than repeatedly failing the Viewer export
before reaching Operator, administrator or revocation assertions. The copy race
was reproduced against the real bundled Dashboard with a delayed API response;
stale same-cluster/different-user contents and a canceled browser download also
exposed false-positive paths. The
[export browser fixtures](../../dashboard/apps/web/regression/administration/kubeconfig-export.browser.spec.ts)
now exercise the shared installed adapter with acknowledgement, exact full-content
checks, bounded reads, private download deletion and clipboard clearing. The
[workflow counterexamples](../../dashboard/apps/web/regression/administration/kubernetes-workflow.unit.spec.ts)
separate roles/approval prerequisites, require fresh login after access changes,
retain the original failure through cleanup and reject foreign intent UIDs.
Operator CRUD pins acknowledged UID/generation/spec, accepts schema defaults and
uses resource-version delete preconditions. Unremoved intent receipts fence later
recovery instead of being ignored. Fixed `kubernetes-access`, `kubernetes-revoke`,
`kubeconfig-export`, `kubeconfig-copy` and `kubeconfig-download` stages identify
the failed operation without retaining credential contents. These fixtures are
selected in selftest and the owning Phase 5 fast/browser profiles; fresh installed
acceptance on the matching runner image is still required. Old reports are not
rewritten, and no Kubernetes/SSO permissions or certificate checks are weakened.

17 October 2026 MOD-03 follow-up: the installed Phase 5 report reached a ready
local AnythingLLM service but then failed DNS lookup of its advertised public
example-domain URL. MOD-03 now selects the registered connection's route scope,
without public fallback or capturing nested peer hostnames. Functional browser,
API, inference and Realtime checks use a runner-only certificate policy, separate
from strict HAR-01/bootstrap and the real Kubernetes client's CA contract.
[Route counterexamples](../../dashboard/apps/web/regression/harness/service-probes.unit.spec.ts)
and [real HTTPS/browser/protocol fixtures](../../dashboard/apps/web/regression/harness/https-policy.browser.spec.ts)
cover self-signed/wrong-host certificates, retained HTTP failures, redirects,
DNS/timeout failures, missing local routes and independent strict verification.
They are selected by selftest and the later-phase fast/browser profiles. Local
coverage does not replace a fresh MOD-03/04 installed activation/cleanup result;
old reports retain their original failures and blocked dependencies.

17 October 2026 runner-start follow-up: HAR-02/10 execute both real Kubernetes
entrypoints in an untranspiled Node subprocess and require the invalid-run-ID
guard before any private access. The same probes run without network or private
mounts in the built CI image before publication. This rejects the unsupported
TypeScript parameter property that terminated the first installed `97098c9`
Phase 5 attempt before setup/reporting; the shared failure receipt now uses
erasable declarations. The failed attempt is retained, not relabelled; installed
acceptance requires the corrected CI image and a new run.

16 October 2026 Phase 5 follow-up: MOD-03/04 verify services through strict HTTPS;
the gateway certificate now covers the actual local service routes and
catalogued instance subdomains. APP-02/09 automatically select a separate small
CPU Ollama fixture whose native context and current RAM estimate satisfy every
selected application's minimum, including the context edit. CPU smoke and GPU
fixtures keep their own smaller contexts. Controller counterexamples require an
incompatible AppInstance to report its current-generation `InvalidModelContext`
without provisioning its key/routes or preventing other instances from
reconciling. Shared application/service setup failures retain their originating
case, stage and trace across browser-worker replacement within the same run;
dependent cases do not repeat the failed setup or borrow passing results from
another run. These changes have local owning, fast and harness coverage; matching
published images and a fresh installed Phase 5 run are still required. Old
reports and UID/revision-bound cleanup checks are unchanged.

20 October 2026 activation feedback follow-up: HAR-10 and UX-02 have owning
component counterproofs and desktop/mobile browser fixtures for a delayed enable
request, accepted activation awaiting readiness, duplicate-request prevention,
error/retry, manual status refresh and the transition to registration without
automatically registering or starting tests. The existing Phase 8 fixture profile
selects the browser cases; this is isolated UI coverage, not new installed-runner
or hardware acceptance.

20 October 2026 test-mode follow-up: HAR-01/02/04/10 and UX-02 cover a safe default,
explicit destructive opt-in, immutable mode/idempotency, viewer-only provisioning,
no recovery-account reuse, stale-lock refusal, old-schema/operator/image rejection,
isolated input mounts, deny-by-default step selection and GET-only transport.
Owning API/controller tests and `harness/test-mode.unit.spec.ts` are selected by
the existing selftest bridge. Desktop/mobile Phase 8 fixtures exercise both modes
with phase subsets and reload. JSON/HTML/text/JUnit distinguish intentional
exclusions from failed or prerequisite-blocked checks. This is isolated coverage;
matching CI runner publication and installed acceptance remain separate gates.

15 October 2026 runner follow-up: HAR-02/06/07/10, MOD-03/04, APP-02,
HW-06, SHR-02/04, SLOT-03 and MGPU-01 have targeted counterproofs for shared
browser/API local DNS with verified TLS, fixed cleanup-operation diagnostics,
causal recovery guards, control-plane AppInstance HelmRelease readiness,
gateway restart detection, missing-provider gates, exact-card DRA preparation
and bounded vLLM collective-rank cleanup. GPU validation uses fresh request and
terminal pages around an independently observed native Job. New harness files
are selected by `selftest`; validation-session checks are in Phase 3/4 fast.
Wrapper/identity owning tests validate their ConfigMaps and version overrides.
These isolated checks do not certify installed CPU/multi-GPU inference or
gateway stability; those still require the targeted live acceptance and a fresh
campaign. Historical reports are not rewritten.

15 October 2026 navigation follow-up: NAV-01/02/03/06/08, SEC-01 and UX-02 have
owning App/feature-parity/cache checks for nested System Status tabs, role-filtered
maintenance tools, legacy hashes, lazy requests, keyboard selection, status-error
navigation and inert opening. Desktop/mobile workflows in the existing
`navigation/navigation.browser.spec.ts` remain selected by `smoke-fixtures` in
Phase 1, including reload, Back/Forward, exact GPU/Flux failure details, no
license prerequisite and no mutations. Existing Phase 8 regression-dashboard
fixtures keep exercising the old bookmark as a compatibility path. These are
isolated U/B checks, not a new installed-appliance or hardware acceptance claim.
Local verification passed 391 Web, 96 CLI and 230 harness tests, all 15 smoke
and 21 Phase 8 browser fixtures, client/regression typechecks, production builds
and 44 documentation/website checks. No test-server run, publication or rollout
was performed for this navigation change.

15 October 2026 follow-up: HAR-04/07/10 and UX-02 now cover retained-access
cleanup with a released Lease, exact-snapshot conflicts and disabled reasons in
API, controller, harness and desktop/mobile browser fixtures. CHANNEL-02 selects
`RegressionGuardTests` alongside the existing software-channel contracts: queued
and running tests fence updates, the host reserves the lab through observed Flux
readiness, and no test/foreign-host Lease can be adopted or released. SEC-04's
existing all-module permission test is retained and the Linux runner now packages
the whole catalog source tree. Local checks are not new live or image-build
acceptance; those gates remain separately reported.

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
| CPU LIFE-02/ENG-01/09, GPU non-interference · 0.31 CPU model runner | **Owning counterexample reproduced; installed retest pending** | [CPU wrapper policy counterexamples](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), selected Phase 2 [engine contract](../../dashboard/apps/web/regression/models/control.contract.spec.ts), [native configuration check](../../magic-cluster/platform/ai/kubeai/base/verify_vllm_runtime.py) | 2026-10-23: the old wrapper fails the new default-policy counterexample. On one AVX2 lab host, the pinned CPU image with a cold compile cache timed out its first direct HTTP request at the unchanged 90-second limit, even with model compilation disabled. With only the official MRV1 environment selection changed, the same immutable model, BF16 dtype, eight-core quota, 7,656 MiB RAM and 1 GiB KV budget produced HTTP 200 in 50.867 seconds. Both diagnostic resources and workers were independently removed. The correction is CPU-/version-bound and preserves explicit policy, arguments, precision, budgets and GPU paths. | Matching native configuration CI, runner publication/promotion and the ordinary installed CPU inference/Edit/Stop/Start workflow on both appliances. Direct diagnostic success is not routed lifecycle or complete-campaign acceptance; historical failures remain unchanged. |
| MESH-09 · canonical GitHub Actions check links | **Local counterexample passed; installed retest pending** | [Companion public proof and discovery counterexamples](../../dashboard/apps/web/regression/administration/safety.unit.spec.ts), existing Phase 7 fast/live selections | 2026-10-21: the real successful exact-commit native build returned a canonical `runs/<check-id>` URL instead of the submitted workflow-run URL. The old reader rejected that public proof as `REVISION`. The reader now accepts only the exact repository/check-ID link also returned as `html_url`; foreign, malformed or mismatched links remain rejected, with the trusted App, exact source, workflow attempt and four-platform evidence still required. | Fresh matching runner CI/pin and installed adapter verification. This native packaging proof never substitutes for real cross-appliance Mesh inference. |
| MGPU-01 · native collective payload dtype | **Local counterexample passed; installed retest pending** | [Every directed peer in two/four-card groups](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), existing Phase 3 fast and GPU selections | 2026-10-21: installed milestones reached NCCL initialization and, with host-mediated transport, all-reduce; point-to-point exchange then stalled. The actual probe inferred Float32 for floating-point send buffers but Int64 for integer-zero receive buffers. Its new owning-layer counterexample rejects that old implementation and passes with explicit Float32 on both allocations, covering every directed pair for two and four ranks. All 45 wrapper tests passed locally. | Matching runner CI/pin, ordinary appliance update and fresh native split/inference acceptance. The direct-transport timeout and independent CPU first-response timeout are not declared fixed by this correction. No historical report is rewritten. |
| HAR-07/10/11, CPU LIFE-02/ENG-01, MESH-09, MGPU-01 · completed-campaign follow-up | **Implemented locally; installed retest pending** | [Export and recovery counterexamples](../../dashboard/apps/web/regression/harness/kubernetes.unit.spec.ts), [full-size JUnit and privacy](../../dashboard/apps/web/regression/harness/artifacts.unit.spec.ts), [controller status](../../magic-cluster/platform/magicstick-operator/controller/test_regression_runs.py), [native CPU/probe checks](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), [public companion proof contracts](../../dashboard/apps/web/regression/administration/safety.unit.spec.ts), [CI proof safety](../../magic-cluster/apps/ai/private-mesh/test_publish_acceptance.py), [runtime trace privacy](../../dashboard/apps/web/regression/harness/runtime-diagnostic.unit.spec.ts) | 2026-10-21: the completed campaign exceeded the JUnit download bound and replaced its outcomes with a generic HAR-02 failure and false recovery requirement. A 3,500-scenario / 87,500-step / 5,000-evidence counterexample exceeds the bound with the old writer and fits with the compact writer, retaining all steps. Export errors now preserve results and the independently verified cleanup state. CPU automatic startup OMP values no longer suppress vLLM 0.31's serving-thread reduction; explicit policies remain unchanged. Native companion proof uses the exact trusted public workflow check instead of anonymous private-artifact downloads. GPU timeouts gain per-rank fixed milestones without weakening qualification. Existing selections cover the new U/C checks. | No new image publication, Appliance rollout or live CPU/Mesh acceptance is claimed. The four GPU split timeouts are not declared fixed: a fresh targeted installed trial must locate the stalled native milestone. Historical failed reports and cleanup evidence are preserved. |
| NAV-02 · System Status browser-history synchronization | **Implemented; local retests passed** | [Dedicated history scenarios](../../dashboard/apps/web/regression/navigation/history.browser.spec.ts), [separate navigation workflow](../../dashboard/apps/web/regression/navigation/navigation.browser.spec.ts), [required Phase 1 variants](../../dashboard/apps/web/regression/profiles/phase1-p0.ts), [coverage counterexamples](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts) | 2026-10-20: the unsynchronized navigation reproduced a wrong Back target under 12× CPU slowdown. Back/Forward now has one NAV-02 result per desktop/mobile and normal/slowed variant, with three cycles each. Every action confirms URL, selected tab and visible panel; no sleeps, retries or increased timeouts were added. The former five-ID workflow retains reload, legacy links, lazy queries, role/keyboard and no-mutation checks but no longer owns the history assertion. Missing history variants prevent Phase 1 acceptance. Local verification: 60/60 focused history executions (180 complete cycles), 19/19 Phase 1 browser-fixture executions, 18/18 Phase 1 fast executions and 303/303 harness self-tests passed; regression typecheck, 45 documentation/website tests and strict documentation build passed. Execution counts are separate from evidence rows. | Isolated source-host checks only; matching runner CI/image publication and a fresh installed Phase 1 run remain separate. Historical failed reports are unchanged. |
| HAR-08, SHR-01/03/04/08/09, MGPU-01/02 · fresh exclusive GPU baseline | **Implemented; focused local counterexamples passed, live acceptance pending** | [Borrowed settings](../../dashboard/apps/web/regression/hardware/borrowed-settings.unit.spec.ts), [backend safety](../../dashboard/apps/web/regression/hardware/safety.unit.spec.ts), [automatic cleanup](../../dashboard/apps/web/regression/harness/recovery.unit.spec.ts), [owning API checks](../../magic-cluster/apps/dashboard/test_gpu_sharing_api.py), existing Phase 3/4 selections | 2026-10-20: reproduced the old `CAPABILITY` block on an unset fresh GPU baseline before changing the implementation. Counterexamples cover NVIDIA/AMD absent/empty maps and fields, unrelated parameters, an untouched baseline, delayed exclusive convergence, status-only CAS retries, foreign UID/generation, lost Lease, non-submission and a lost reset acknowledgement. Automatic cleanup is repeatable; accepted-but-unacknowledged resets remain fenced. Phase 3 restoration now also requires its selected C-layer API proof. | Fresh-appliance GPU inference, two/four-card split/copy workflows and installed controller/allocator convergence must be retested with matching new API and runner images. Local fixtures do not establish that acceptance; historical reports remain unchanged. |
| LIFE-03/06 · ordinary single/split runtime drain | **Local checks and targeted live repetitions passed** | [Controller lifecycle counterexamples](../../magic-cluster/platform/magicstick-operator/controller/test_model_lifecycle.py), existing [NVIDIA lifecycle repetitions](../../dashboard/apps/web/regression/hardware/runtime.e2e.spec.ts) | 2026-10-16: fourteen lifecycle checks and the full 343-test controller suite passed locally. The operator base renders. With the temporary controller fix on one appliance, all six NVIDIA lifecycle scenarios passed (three Ollama and three vLLM), producing 72 passed evidence rows and no failures or blocked rows. Each verified inference, Logs, Stop, Pod/catalog withdrawal, slot release, Start and inference again. All six owned models and the test key were removed; borrowed AMD/NVIDIA sharing settings were restored. A fresh in-Appliance Phase 2 run passed all 307 scenarios and 431 evidence rows (383 fixture, 48 live), with its generated accounts cleaned, no leftover test models/Pods and the original stopped model definitions unchanged. The unchanged five-minute Stop limit was retained. | These dated runs used a temporary controller override, not a new-source CI image or full Phase 3 acceptance. Slow vLLM Stop observations (about 174, 194 and 32 seconds) and concurrent CPU-consumer CRI timeouts remain a separate host-runtime finding, not a claimed containerd/driver fix. The first emulated-runner attempt failed in sharing preparation before any model was created; its failed report was preserved and its recovery was verified separately. |
| HAR-07/10, LIFE-02, MGPU-01/02, MOD-03/04, K8S-02–06, LIC-02–04, RT-01, SEC-04, PERF-02 · focused follow-up | **Local corrections; native retest required** | [Cleanup and repeated-cycle counterexamples](../../dashboard/apps/web/regression/administration/cleanup.unit.spec.ts), [successive GPU journals](../../dashboard/apps/web/regression/hardware/safety.unit.spec.ts), [OIDC callback browser checks](../../dashboard/apps/web/regression/auth/oidc-exec.browser.spec.ts), [license and enabled-module RBAC guards](../../dashboard/apps/web/regression/administration/safety.unit.spec.ts), [runtime evidence](../../dashboard/apps/web/regression/harness/model-ui.unit.spec.ts) | 2026-10-15: source `05ad953` and its exact runner/Dashboard CI images converged on both test Appliances. The standalone cleanup Job passed and removed the old owned key without rewriting its failed report. Focused installed runs exposed CPU inference throttling, an OIDC loopback-adapter mismatch, bodyless license reads intercepted as writes, per-worker receipt collisions, repeated GPU scenario journal collisions, the enabled regression module's omitted RBAC grant and a false Pod-UID leak alarm. Counterexamples now reject those defects; Realtime readiness also captures private runtime diagnostics before cleanup. Two-card Ollama split and independent vLLM/Ollama copies passed on the earlier source; vLLM split and later four-card cases did not pass. | New matching runner CI/promotion and staged installed retests. The native split failure needs its preserved startup/collective diagnostic; Realtime readiness and three complete resource cycles need fresh acceptance. No full Phase 0–8 pass or physical hardware matrix is claimed. |
| HAR-07/09/10/11, MGPU-01/02, LIFE-02, MOD-03/04, APP-02, RT-01, SEC-04, UX-02, PERF-02 · fresh execution and October report repairs | **Implemented locally; staged appliance acceptance pending** | [Cleanup counterexamples](../../dashboard/apps/web/regression/administration/cleanup.unit.spec.ts), [browser write receipts](../../dashboard/apps/web/regression/harness/actions.browser.spec.ts), [GPU sizing and DRA checks](../../dashboard/apps/web/regression/hardware/safety.unit.spec.ts), [form fixtures](../../dashboard/apps/web/regression/administration/configuration.browser.spec.ts), [vLLM wrapper contracts](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), [causal reports](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts) | 2026-10-15: added counterexamples for unsent/acknowledged/lost writes, interrupted repeat cleanup, failed GPU restoration with independent cleanup, pending/failed Ollama and vLLM Edit estimates, actual per-engine/per-card/per-copy fixture budgets, exact DRA validation claims, repository-derived RBAC, mixed CPU/GPU Realtime choices, and explicit missing-evidence failures. UX-02 now records common forms, optional Mesh form and optional GPU form independently; other form checks continue without those capabilities. PERF-02 retains baseline stages and requires at least three complete model cycles with separate cache accounting. | Exact matching CI and installed digests, old Monster cleanup, focused two/four-card split and replica inference/Edit/Stop/Start, CPU first response, later Magic scenarios, then a fresh full campaign on each device. Local checks do not certify native NCCL transport or live model acceptance. |
| HAR-02/07/10, UX-02 · failed preparation and recovery diagnosis | **Implemented locally; installed repeat pending** | [Reporting isolation](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts), [setup marker and public result](../../dashboard/apps/web/regression/harness/kubernetes.unit.spec.ts), [Dashboard and browser fixtures](../../dashboard/apps/web/src/pages/RegressionPage.test.tsx), [input worker diagnostics](../../tests/test_regression_inputs.py) | 2026-10-14: 209 harness selftests passed with inherited Failed preparation; 375 Web tests, eight selected desktop/mobile Chromium fixtures and 73 Python launcher/security/report tests passed locally. The 14 October installed campaigns on both Appliances had zero Passed live evidence; their HAR-02 failures blocked 564 dependent evidence rows each. Recovery-only attempts subsequently failed at access setup; exact old Locks remained protected. | Matching runner and Dashboard CI images, specific recovery setup diagnosis, exact old-run cleanup, then staged installed Phase 0–2 and Phase 3–4 acceptance. No GPU operation is accepted from the isolated fixture counts. |
| HAR-06/07/09/10/11, LIFE-04/13, SLOT-01/02/04/05/06/07/09, SHR-03, MGPU-01/02 · lifecycle and multi-card runner corrections | **Implemented locally; installed repeat pending** | [Browser mutation receipts](../../dashboard/apps/web/regression/harness/actions.browser.spec.ts), [model UI/slot/diagnostic guards](../../dashboard/apps/web/regression/harness/model-ui.unit.spec.ts), [runtime inventory safety](../../dashboard/apps/web/regression/hardware/safety.unit.spec.ts), [CPU evidence steps](../../dashboard/apps/web/regression/models/cpu-model-control.e2e.spec.ts), [sharing workflows](../../dashboard/apps/web/regression/hardware/sharing.e2e.spec.ts), [multi-card browser fixtures](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [causal reporting/privacy/archive checks](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts) | 2026-10-14: current-source regression typecheck, 207 harness selftests, 40 Phase 3 owning/safety scenarios, 23 CPU browser cases, 36 Phase 3 GPU browser cases and 37 Phase 4 sharing browser cases passed locally. Fourteen launcher/report-store tests and 44 documentation/website checks passed; the handbook build succeeded. One/two/four-card fixtures check exact node capacity, duplicate/conflicting inventory refusal, full/final-slot arithmetic, PCI-scoped accordions and delayed split/replicated Edit loading. Acknowledged writes are journaled independently of later browser failure; lost responses still cannot adopt another generation. CPU stage evidence and cleanup traces preserve earlier checks and the original error. Filtered runtime status survives trace/JUnit serialization without identifiers, messages or secrets. A phase entered with a recorded recovery guard attributes missing live evidence to that failure, while unrelated fixture gaps and unrecorded causes stay unknown. | Local source only. The existing failed appliance reports and locks were not changed. Exact old-run recovery, matching CI/image publication and scoped installed Phase 2/3/4 repetitions are still required. vLLM multi-GPU runtime failures are not declared fixed by isolated harness checks. Full-node sharing may need additional small owned intents; registration, admission, resource limits and UID/generation-bound cleanup remain enforced. |
| HAR-01/04/06/09/10/11, CHANNEL-02/04/05/06/07/08, SEC-03 · Monster runner hardening | **Implemented; local U/B checks passed** | [Bound session/renewal Chromium fixtures](../../dashboard/apps/web/regression/auth/runner-session.browser.spec.ts), [cleanup lifecycle](../../dashboard/apps/web/regression/harness/recovery.unit.spec.ts), [failure/cleanup reporting](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts), [owning-suite isolation reproductions](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [runtime/CI contract](../../tests/test_regression_security.py); existing selftest and Phase 6/8 fast selections | 2026-10-13: 186 harness selftests, 19 Phase 6 fast scenarios and 16 Phase 8 fast scenarios passed locally; both fast selections inherited Kubernetes execution mode. Isolation reproductions reject a fixture overwriting the real preparation diagnostic. The runtime contract requires Git in the final stage and Phase 6 checks before publication. Targeted Chromium checks prove completed callback, same-context expiry renewal (including silent IdP SSO), serialized concurrent checks, current disposable-user password, unchanged user/role, sticky renewal failure, no sign-in-triggered product writes and Lease revalidation. Authentication errors are Failed rather than missing prerequisites; an additional cleanup failure keeps its fence without hiding an earlier scenario failure. The failed Monster run remains unchanged; its original HAR-09 root is not conclusively established by the sanitized trace. | Local source only: matching built-image CI, publication and a fresh installed campaign remain required. No stale Lease or journal was cleared and neither appliance was redeployed or rerun. Source-host fixtures do not establish installed recovery or GPU acceptance. |
| HAR-02/10/11, UX-02 · prerequisite and failure block causes | **Implemented; local U/B checks passed** | [Reporting/causal evidence](../../dashboard/apps/web/regression/harness/reporting.unit.spec.ts), [Kubernetes progress](../../dashboard/apps/web/regression/harness/kubernetes.unit.spec.ts), [Dashboard components](../../dashboard/apps/web/src/pages/RegressionPage.test.tsx), [desktop/mobile fixtures](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts); existing selftest and Phase 8 selections | 2026-10-13: current-source Web/CLI checks, typechecks and production builds passed. Reporting checks preserve prerequisites versus failed-step/setup/recovery dependencies, original outcomes and causal check/stage/trace metadata through sanitized child aggregation, JSON, HTML, text and JUnit. Unknown older/synthesized evidence and cancellation are not guessed to be prerequisites. Dashboard checks cover live/evidence count scopes, both badges, the blocking trace and legacy responses; desktop/mobile Chromium checks passed. Documentation checks/build passed. | Source is local; no new runner image, CI publication or installed-appliance acceptance is claimed. Existing appliance runs were not changed or restarted. |
| HAR-10, UX-02 · stable automatic polling and manual refresh | **Implemented; local U/B checks passed** | [Owning component tests](../../dashboard/apps/web/src/pages/RegressionPage.test.tsx), [desktop/mobile browser workflow](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts); selected by the existing selftest and Phase 8 fixture profiles | 2026-10-13: the new component reproduction failed against the old background-fetch button state. After the fix, all 11 regression-page tests, 366 Web tests and six desktop/mobile Chromium scenarios passed. Coverage includes a pending automatic poll, manual refresh sharing that request, progress updates, error recovery and no server mutations from refresh. Web/regression typechecks, production build and 44 docs/website checks passed. | Matching CI publication and installed-appliance verification remain separate; the existing long-running appliance campaign was not changed or restarted. |
| HAR-10, SEC-01, UX-02 · license-free regression lifecycle | **Implemented contract; isolated checks passed** | [API lifecycle and report tests](../../magic-cluster/apps/dashboard/test_regression_api.py), [role/navigation components](../../dashboard/apps/web/src/App.test.tsx), [desktop/mobile browser workflow](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts), selected by the existing Phase 8 fixture profile | 2026-10-13: 468 Dashboard API and 363 Web tests passed, including missing/expired/invalid/unavailable license states and retained non-admin rejection. All eight Phase 8 Chromium fixtures passed; the two new desktop/mobile scenarios enable the runner, confirm disposable-lab registration, start, cancel and initiate authenticated report downloads without any license query or activation. Client/regression typechecks, Web/CLI production builds, 44 docs/website checks and the strict handbook build also passed. | No installed-appliance run was performed. Source publication, matching CI images and installed acceptance remain separate. License/SSO tests still verify real signed fixtures and entitlement enforcement; this contract does not unlock Federated SSO or waive license terms. |
| HAR-02/10/11, SEC-01, UX-02 · administrator Kubernetes regression execution and blocked traceability | **Implemented in U/C/B; installed Job acceptance pending** | [Runner contracts](../../dashboard/apps/web/regression/harness/kubernetes.unit.spec.ts), [desktop/mobile browser](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts), [API authorization/intent/report tests](../../magic-cluster/apps/dashboard/test_regression_api.py), [Job ownership/status contracts](../../magic-cluster/platform/magicstick-operator/controller/test_regression_runs.py), [report-store safety](../../tests/test_regression_report_server.py), [short procedure](regression-remaining-p0.md#in-the-dashboard) | 2026-10-13: current-source checks passed 467 Dashboard API, 329 operator, 359 Web and 96 CLI tests, client/regression typechecks and production builds. The isolated selftest selection passed 159 scenarios; the full Phase 8 Chromium fixture selection passed all six, including desktop/mobile progress reload, inert page opening, cancellation confirmation and reason/phase/layer/stage/trace display. Large campaign-report bounds, exact credential recovery, foreign ownership rejection, CSRF/authenticated attachments, anonymous image-pull gating and source-promotion safeguards are covered at owning layers. A focused repeat passed 21 setup/Kubernetes scenarios after excluding the runner from its own module fixtures. The browser run exposed the old always-enabled domain Save button; owning tests and the unchanged/reverted-form fixture now pass after the focused correction. | No runner image was built or published locally, no CI was dispatched, and no test-server Job was started. First trusted CI image publication/digest promotion and installed start/progress/cancel/report/recovery acceptance remain required. Host-disconnecting/replacing drills are intentionally Blocked inside an Appliance Job and require the external runner; fixture tests do not certify hardware or full campaign acceptance. |
| MEM-01/05/06, MGPU-01/02 · rank/layer VRAM and separate startup/serving RAM | **Implemented; source checks and focused temporary appliance checks passed** | [Owning memory contracts](../../magic-cluster/apps/dashboard/test_memory_calculations.py), [RAM admission](../../magic-cluster/apps/dashboard/test_nvidia_card_api.py), [memory components](../../dashboard/apps/web/src/ModelMemorySettings.test.tsx), [selected Phase 2 contracts](../../dashboard/apps/web/regression/models/control.contract.spec.ts), [desktop/mobile RAM workflows](../../dashboard/apps/web/regression/models/control.browser.spec.ts), existing Phase 3 GPU fixtures | 2026-10-13: 346 Web, 96 CLI, 450 dashboard API and 70 API-package tests passed locally, with client/regression typechecks, the production build, 44 documentation/website tests, strict documentation build and dashboard render. Selected isolated runs passed all 23 Phase 2 fast scenarios, 23 Phase 2 browser scenarios and 31 Phase 3 browser scenarios. Initial new-browser failures were an exact-label locator error; the corrected complete selection passed. Coverage includes tensor KV-head replication, MLA, pipeline-local layers, recurrent/QSA components, Ollama whole-layer envelopes and one runner, separate uneven-placement reserve, split versus replicated host scope, unknown metadata/capacity, startup-risk admission and retained manual/saved RAM. After authorized temporary Web/API deployment, actual source/asset hashes and readiness passed; the installed Ollama Edit form showed serving/startup/recommended RAM and retained its 16400 MiB saved budget through an unsaved context change. Read-only calls in the installed API passed single-GPU, four-rank tensor and four-copy estimates for a small public Qwen model. Current model definitions, runtime pins and model Pod restart counts remained unchanged. | No new GPU-model loading/inference, measured startup-peak qualification, full live campaign, CI, source publication or canonical image promotion was performed. The live Web/API use a resource-scoped, journaled temporary override. RAM envelopes remain estimates; special N-gram/PLE placement is flagged, not enabled or certified by the calculator. |
| ENG-01/02/03/09, LIFE-01/03/04/06/07, ROUTE-01/02, LOG-01, MGPU-01/02 · Ollama 0.40.3 runtime upgrade | **Implemented; local source checks passed, live acceptance pending** | [Selected owning image/cache checks](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), [controller contracts](../../magic-cluster/platform/magicstick-operator/controller/test_controller.py), [runtime adoption](../../magic-cluster/platform/magicstick-operator/controller/test_gpu_compatibility.py), existing CPU and Phase 3/4 workflows, [upgrade procedure](model-integration.md#ollama-runtime-upgrades) | 2026-10-12: official registry index/manifest digests and platform configurations were verified; standard CPU/NVIDIA and AMD ROCm pins, diagnostics and AMD adoption checksum were aligned. Passed 26 runtime/image/cache contracts, 315 controller tests, 31 license checks, 44 documentation/website tests, the strict documentation build and four affected Kustomize renders. The initial local Python environment lacked the required standard-library/dependency versions; affected checks passed when repeated in their matching environments. Existing workflow cases retain their engine-specific aliases, cache/environment settings and lifecycle assertions; no new selector or product setting is required. | Native image/HTTP and registry-model loading, cache reuse/rollback, CPU inference and each available GPU provider, including NVIDIA split/replicated variants, must be verified before publishing acceptance. Docker was unavailable locally; no appliance rollout, native inference or CI run was performed for this source update. |
| MGPU-01 · ordinary vLLM 0.31.0 runtime upgrade | **Implemented; partial live acceptance** | [Wrapper tests](../../magic-cluster/platform/ai/kubeai/base/test_vllm_wrapper.py), [native-image checker](../../magic-cluster/platform/ai/kubeai/base/verify_vllm_runtime.py), [native CI gate](../../.github/workflows/vllm-runtime-contracts.yml), existing Phase 3/4 owning selections | 2026-10-12: 25 wrapper tests and 315 operator tests passed. The published Linux/ARM64 CPU image passed native registry, offline synthetic configuration, real controller-generated Auto/FP8 arguments, CLI/wrapper and cache-field contracts. On the authorized Linux/AMD64 test appliance, Qwen3-0.6B loaded on four RTX A6000 cards and on CPU; both returned nonempty chat completions through the KubeAI router, with zero runtime restarts. The new FP8 compatibility path also passed the real AMD64 parser without parent CUDA initialization. A four-to-two-card edit persisted two exact claims and released the other cards, but that pair hung in NCCL; a bounded two-rank collective timed out with default P2P and passed with P2P disabled. Flash-Next now resolves its architecture and accepts FP8 arguments, but loading was OOMKilled at the saved 16400 MiB host-RAM limit. Owned fixtures were removed; original parameters/cache were retained and the OOM retry was stopped. | This is not a passing full MGPU-01 matrix or release gate. Resolve the pair-specific transport failure and qualify Flash-Next RAM/packed-PLE loading separately. CI, AMD/Intel hardware, replicated/shared/unequal-card variants and a full campaign remain pending. No commit/push/CI was performed; the CPU/NVIDIA test runtime is a resource-scoped temporary override. Omni and Ollama pins remain unchanged. |
| DISC-01, MEM-01, MGPU-01/02 · names, explicit card selection and consistent memory scope | **Implemented; source-host checks and focused installed UI test passed** | [Name/component and GPU tests](../../dashboard/apps/web/src/NvidiaCards.test.tsx), [memory components](../../dashboard/apps/web/src/ModelMemorySettings.test.tsx), [name API contract](../../magic-cluster/apps/dashboard/test_dashboard_api.py), [Phase 2 selection](../../dashboard/apps/web/regression/profiles/phase2-p0.ts), [GPU browser scenarios](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts) | 2026-10-12: 340 web, 96 CLI and 437 dashboard API tests passed locally, along with 150 harness selftests, TypeScript checks and the web/CLI production build. Chromium fixture selections passed 19 Phase 2, 31 Phase 3 and 32 Phase 4 scenarios. The 16-scenario MGPU-01 matrix passed again with keyboard checkbox toggles. Coverage includes local/external name syntax, length and duplicate validation; one checkbox list with no automatic count; retained missing identities; matching group-total calculator/Breakdown values and per-copy replication budgets. After authorized temporary deployment, the installed desktop Create/Edit workflow created a small vLLM model with four explicit cards and edited it to two, retaining its per-card budget and source. Four-card inference passed; the two-card transport failure is recorded separately above. Owned GPU/CPU fixtures were removed through the same UI. | CI and full installed desktop/mobile, engine, sharing and replication coverage remain pending. Fixture successes and this focused temporary test do not establish full campaign or release acceptance. |
| HAR-10/11, UX-02 · CI diagnostics and stale regression selections | **Implemented correction; CI retest required** | [First runner CI](https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/38043302659), [matrix contract](../../dashboard/apps/web/regression/administration/matrix.unit.spec.ts), [owning forms](../../dashboard/apps/web/regression/administration/owning.unit.spec.ts), [archive safety fixtures](../../dashboard/apps/web/regression/harness/artifacts.unit.spec.ts) | 2026-10-10: commit `a04b023` built the actual Linux/AMD64 runner successfully (1,275,330,390 bytes; seven filesystem layers). Its selftests, Phase 4 fast/native recovery and SEC-03 owning checks passed; Phase 8 failed HAR-10 and UX-02, and browser steps were skipped. Correct the obsolete 99-variant expectation to 98 after FreeToken/CACHE-07 retirement and replace a nonexistent settings-test path with the existing domain-settings contract. Isolated profiles now produce the same allowlisted archives as canonical phases, retaining safe failure diagnostics and failed evidence; browser CI steps remain independent after a successful build. | Verify the corrected commit in CI, including the component suite and Chromium fixtures. The first run remains failed; this row does not relabel it as passing acceptance. |
| HAR-10, SEC-03, BOOT-04/05 · built regression image in CI | **Implemented CI gate** | [Regression-image job](../../.github/workflows/regression-runner.yml), [native recovery contracts](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [CI procedure](regression-runner-reference.md#runner-image) | 2026-10-10: a dedicated GitHub workflow builds the actual runner and executes its typecheck, harness selftests, Phase 4/8 fast contracts and Phase 2/7 Chromium fixtures in the built Compose image. Native AMD tests remain mandatory; only allowlisted report archives are uploaded. This wiring reuses the existing selections and evidence helpers; a Docker build in the agent workspace is no longer required. Results belong to the exact workflow commit and are available in its CI job; this entry records implementation, not an unobserved passing run. | Check the `regression-image` job for the exact pushed commit. Linux/ARM64 and installed appliance/GPU acceptance remain separate; isolated CI does not certify them. |
| HAR-10, SEC-03 · lean local Docker runner | **Implemented; source-host checks passed, Docker rebuild failed** | [Runner recipe](../../dashboard/apps/web/regression/Dockerfile), [existing launcher/security contracts](../../tests/test_regression_launcher.py), [supply-chain owning bridge](../../dashboard/apps/web/regression/administration/owning.unit.spec.ts), [image measurements](regression-runner-reference.md#runner-image) | 2026-10-10: regression typecheck, 149 harness selftests, 13 Phase 2 and 4 Phase 7 Chromium browser scenarios passed with a browser path containing only headless shell and FFmpeg. The existing supply-chain Python group passed 97 checks without skips; its owning bridge also completed its SEC-03 assertions. Docker's static recipe check passed without warnings. Registry compressed base downloads fell from 956.11 to 77.08 MiB for the runner and 283.03 to 68.07 MiB for Go; these are not final image sizes. Existing tests suffice for unchanged runner contracts; no new campaign cases or appliance feature are introduced. | The actual rebuild failed with `no space left on device` while compiling the pinned native AMD tests in the smaller Go builder. Full rebuilt-image and native ARM64 verification remain pending; host checks do not certify those paths or live acceptance. The build launcher has no speculative capacity threshold. |
| DISC-01/03, ENG-07/09, LIFE-02/07/08, MGPU-01/02, RT-01 · shared local Create/Edit | **Implemented in isolated U/C/B layers; live acceptance pending** | [Shared draft contracts](../../dashboard/apps/web/src/LocalModelConfigurationCore.test.ts), [discovery and engine switching](../../dashboard/apps/web/src/ModelDiscovery.test.tsx), [Phase 2 selection](../../dashboard/apps/web/regression/profiles/phase2-p0.ts), [GPU browser matrix](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [Omni browser workflow](../../dashboard/apps/web/regression/administration/configuration.browser.spec.ts), [installed Omni workflow](../../dashboard/apps/web/regression/administration/realtime-live.ts) | 2026-10-10: Ollama/vLLM/Omni use one form. Current-source checks passed: 328 web and 96 CLI tests; 436 API and 71 selected operator tests; Phase 2 fast 21/21, browser 13/13; Phase 3 browser 31/31; Phase 7 browser 4/4, selected RT owning suite; harness selftests 149/149; desktop/mobile overflow and visual review. Custom Omni sources/stage budgets, CPU reset, polling revision fences, late discovery responses and minimal GPU edits are covered. | The test appliance is unreachable; installed inference and physical GPU acceptance were not run. The Docker runner rebuild was attempted but blocked by insufficient Docker filesystem space; isolated checks ran directly against current source. |
| MGPU-01 · 2/4-card NVIDIA, vLLM/Ollama, Exclusive/Shared | **Implemented; physical acceptance pending** | [Phase 3/4 selections](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning contracts](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [budget component checks](../../dashboard/apps/web/src/NvidiaCards.test.tsx), [desktop/mobile Chromium](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [live group workflow](../../dashboard/apps/web/regression/hardware/multi-gpu.e2e.spec.ts) | Local API/controller/runtime and UI fixtures cover atomic admission, identity, budgets, strategy, persistence, full-card edits and lifecycle accounting. Inventory eligibility covers three differing DCGM readings plus an inventory-only fourth card, different models/capacities, unknown physical capacities despite equal telemetry, legacy API compatibility and rejection of mixed capacity sources. Native vLLM worker contracts cover equal MiB budgets on unequal GPUs and physical/override rejection. Desktop/mobile browsers cover both identical and different 2/4-card groups with smallest-budget maxima, physical limits and Create/Edit persistence. Total-budget coverage includes 2/4-card Create/Edit, budgets above one card, smallest-card maxima, unknown capacity, rounding, unchanged/reverted legacy budgets and split/replicated mode changes. Live variants in `phase3-gpu` and `phase4-sharing` also check the saved per-card budget displayed in Edit; no physical multi-GPU acceptance is claimed by isolated checks. | Registered lab with at least 2/4 eligible same-node NVIDIA cards (including different-model/capacity acceptance), current DRA inventory and telemetry, deployed source/images, approved small vLLM/Ollama fixtures and a clean Lease. Missing capacity is Blocked, not Passed; a complete run must prove every requested card is used. |
| MGPU-02 · 2/4 independent copies, vLLM/Ollama, Exclusive/Shared | **Implemented; physical acceptance pending** | [Phase 3/4 selections](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning contracts](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [desktop/mobile Chromium](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [live copy workflow](../../dashboard/apps/web/regression/hardware/multi-gpu.e2e.spec.ts) | Local tests cover per-copy resources/identity, different GPU capacities, partial failure, generation-safe routing, one catalog alias, log selection and lifecycle cleanup. Matching tests select all four identical inventory cards with mixed telemetry; desktop/mobile browser creation pairs measured and inventory-only cards with identical or different capacities, preserves their exact bindings and verifies editing/log selection. Live variants in `phase3-gpu` and `phase4-sharing` assert separate exact DRA bindings, memory usage, parallel routed requests, per-card slots, edit, Stop/Start/removal and restore. Fixture tests are not live acceptance. | The MGPU-01 lab requirements plus enough total host RAM for all full copies. Missing hardware is Blocked, not Passed. No autoscaling, multi-node replication or combined split/replicated runtime is claimed. |
| SLOT-01/05/06/07, SHR-03 · four-card NVIDIA DRA / legacy pool variants | **Implemented in isolated U/C/B layers; hardware acceptance pending** | [Selected variants](../../dashboard/apps/web/regression/profiles/gpu-p0.ts), [owning tests](../../dashboard/apps/web/regression/hardware/owning.unit.spec.ts), [Chromium fixtures](../../dashboard/apps/web/regression/hardware/configuration.browser.spec.ts), [API slot/identity contracts](../../magic-cluster/apps/dashboard/test_nvidia_card_api.py), [DRA handoff contracts](../../magic-cluster/platform/magicstick-operator/controller/test_nvidia_dra.py), [per-device diagnostic contracts](../../magic-cluster/platform/magicstick-operator/controller/test_gpu_devices.py) | 2026-10-09: four synthetic identical cards cover one legacy pool, distinct DRA rings, exact Create/Edit selection, full-card draft retention, Stop/termination release, own-slot reuse, node replacement, queue isolation, fail-closed admission and sequential exact-card diagnostic results. These are isolated fixtures, not a new live acceptance record. | Real four-card node: forward/reverse allocator transition, KubeAI-ServiceAccount admission dry run, actual Pod GPU UUIDs, Ollama/vLLM inference, diagnostics and restart recovery. Existing single-GPU live variants do not certify these multi-card paths. |
| HAR-01–11 · complete Phase 0 P0 foundation profile | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase0-p0.ts), [live fault/recovery tests](../../dashboard/apps/web/regression/harness/safety.api.spec.ts), [isolated fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [runner and dated evidence](regression-test-concept.md#phase-0-p0-acceptance) | 2026-10-04 repeat: aggregate `reg-98491d09-43a7-4d9a-b1cb-0c4c3e308d8a` passed 61/61 results, all 14 mandatory live variants and final pinned preflight. `fullPhase0Accepted: true`; no missing, failed, blocked, skipped or flaky result. Interrupted prior journal recovered separately; owned resources absent and Lease free. Reviewed source/image/current boot pins verify. Both existing vLLM definitions remained Disabled and unchanged. Historical 2 October acceptance remains in the concept. | Accepted CPU/key/test-Lease foundation. App/identity and GPU/global-product-setting adapters remain in their domain phases; no GPU-inference acceptance claimed. |
| AUTH-01/02/06, NAV-03/06, CPU LIFE-01/03/04/06, ROUTE-01/06, KEY-01/03, LOG-01/05/06, selected UX-02 · finite Phase 1 P0 smoke | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase1-p0.ts), [live CPU/UI/API workflow](../../dashboard/apps/web/regression/models/cpu-ollama.e2e.spec.ts), [real session tests](../../dashboard/apps/web/regression/auth/session.e2e.spec.ts), [isolated status browser states](../../dashboard/apps/web/regression/navigation/status.browser.spec.ts), [owning component bridge](../../dashboard/apps/web/regression/components/installed.unit.spec.ts), [profile scope/evidence](regression-test-concept.md#phase-1-p0-smoke) | 2026-10-04: aggregate `reg-2bd24d2f-74a4-4961-98e7-5d3e4733f463` passed 116/116 results and all 66 required U/C/B/A/E tuples. `fullPhase1Accepted: true`; all seven stages and final pinned clean preflight passed. Real sessions, UI keys, CPU/Ollama lifecycle, API and browser Start, inference, logs, negative keys/routes and UID-safe cleanup passed. A separate preceding observer-blocked attempt is retained. Local runner changes are uncommitted; historical wider license-unit timeouts are not overwritten by this finite acceptance. | Phase 2 P0 can proceed. Other roles, engines, GPU lifecycle, live fault injection and wider log/host/global-setting variants remain later-phase gates. |
| DISC-01/03/04, CPU LIFE-02/07/08/09/11/12/13, ENG-01/02/03/07/09/10, MEM-01/05/06/07/10, ROUTE-02/05, LOG-01/04, failure NAV-06 and final HAR-03 · finite Phase 2 P0 model control | **Implemented and accepted** | [Acceptance matrix](../../dashboard/apps/web/regression/profiles/phase2-p0.ts), [CPU Ollama/vLLM and external live workflow](../../dashboard/apps/web/regression/models/cpu-model-control.e2e.spec.ts), [live discovery](../../dashboard/apps/web/regression/models/discovery.e2e.spec.ts), [bounded failure workflow](../../dashboard/apps/web/regression/models/failure.e2e.spec.ts), [fast contracts/components](../../dashboard/apps/web/regression/models/control.contract.spec.ts), [isolated browser fixtures](../../dashboard/apps/web/regression/models/control.browser.spec.ts), [dated acceptance](regression-test-concept.md#phase-2-live-acceptance-2026-10-05), [historical findings](regression-test-concept.md#phase-2-live-findings-2026-10-04) | 2026-10-05: canonical `reg-19887a26-0dc3-4b13-b419-7b849d247b0f` passed **140/140 selected results and all 85 required U/C/B/A/E tuples**, all eight stages and final pinned preflight. `fullPhase2Accepted: true`; no missing/failed/blocked/skipped/flaky result. Real discovery revision, CPU Ollama/vLLM lifecycle/parameter edits/inference/logs, RAM-risk rejection, external routing and the Pod-backed CrashLoop/Degraded UI all passed. Owned definitions, Pods, routes and key were cleaned; Lease free; existing vLLM definitions remain unchanged and Disabled. Runner corrections are local and uncommitted; deployed source/image/boot pins were verified. Earlier failed/interrupted attempts remain in the concept/private reports. | Phase 3 P0 can proceed. This finite CPU model-control acceptance does not certify GPU/FreeToken/sharing/global-setting workflows or every parameter set of the broader catalog; those remain separate Phase 3–4 and later gates. |
| DISC-01, MOD-06 · automatic model tasks and AnythingLLM initial selections | **Implemented; local U/C/B checks passed** | API `test_model_tasks`, `test_module_parameters`, `ModelDiscovery.test.tsx`, `ServicesPage.test.tsx`, AnythingLLM bootstrap and operator substitution contracts; registered Phase 2 task variants and MOD-06 browser proof | 2026-10-10: 315 web, 96 CLI, 435 dashboard API and 56 operator tests passed. Phase 2 fast (19), Phase 2 Chromium fixtures (13), Phase 3 GPU Chromium fixtures (31), Phase 5 Chromium fixtures (9), the module owning bridge and 149 harness selftests passed from current source. Desktop/mobile selections, keyboard interaction, unknown-task rejection/reset, typed model validation and retained native preferences are covered. Installed CPU creation now accepts automatic detection or an explicit unknown-task fallback. | No new installed A/E acceptance: the test appliance is unreachable. Docker runner rebuild was blocked by workspace disk space after proxy/CA setup; source-host execution does not certify a rebuilt runner image. |
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
| HAR-04/07/10 · recovery-only Dashboard action | **Implemented; local U/C/B checks passed; exact external-run recovery verified separately** | [Snapshot/workflow tests](../../dashboard/apps/web/regression/harness/lock-recovery.unit.spec.ts), [API contracts](../../magic-cluster/apps/dashboard/test_regression_api.py), [operator contracts](../../magic-cluster/platform/magicstick-operator/controller/test_regression_runs.py), [desktop/mobile fixtures](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts) | 2026-10-13: confirmation binds the stale Lease UID/resource version, recovery selects zero phases, reports remain downloadable, polling is read-only and older operator/image paths cannot fall back to a suite. Nine focused recovery units and both browser fixtures passed. Separately, the authorized historical external run on the registered test Appliance was journal-recovered by the native pinned runner: exact owned model/key absent, lock free, temporary access restored and original report hashes retained. No new suite was started. | The new Dashboard/API/CRD/operator code remains locally validated; image publication and in-cluster button rollout/acceptance are separate. An external runner's private journal cannot be force-cleared through the Dashboard. |
| HAR-10–11 · reporting and filtered step artifacts | Implemented; local verification | [Harness fixtures](../../dashboard/apps/web/regression/harness/safety.unit.spec.ts), [artifact contracts](../../dashboard/apps/web/regression/harness/artifacts.unit.spec.ts), [allowlisted report](../../dashboard/apps/web/regression/core/report.ts), [safe reporter](../../dashboard/apps/web/regression/reporter.ts) | 2026-10-08: separate evidence/scenario/step JUnit suites, portable filtered-trace archive, bounded omissions, safe component assertion names/index/categories and secondary cleanup fences. Secret-seeded archive and symlink-refusal fixtures pass; an actual local selftest report contains 150 scenarios and their step records. LicensePage's 10 tests and 39 documentation/website checks pass locally; the historical licensing failure was not reproduced. | Reports remain private; raw Playwright traces are off. Full live acceptance and particular CI attachment-viewer support remain unverified. |
| Phase 5 P0 · 42 cases / 138 tuples | **Implemented; live acceptance pending** | [Finite denominator](../../dashboard/apps/web/regression/profiles/remaining-p0.ts), [owning tests](../../dashboard/apps/web/regression/administration/owning.unit.spec.ts), [installed workflows](../../dashboard/apps/web/regression/administration/installed.e2e.spec.ts), [runner guide](regression-remaining-p0.md) | Local checks only; no Phase 5 live run during implementation | Reviewed disposable actors/apps, optional module/profile, real PKCE plugin, signed licenses, controlled OIDC/SAML fixture IdP and least-privilege cleanup |
| Phase 6 P0 · 39 cases / 123 tuples | **Implemented; physical campaign pending** | [Host drill runner](../../dashboard/apps/web/regression/core/host-drill.ts), [draft checks](../../dashboard/apps/web/regression/administration/form-checks.ts), [cache checks](../../dashboard/apps/web/regression/administration/cache-live.ts), [one-drill procedure](regression-runner-reference.md#phase-6-one-physical-drill-at-a-time) | Local checks only; no network change, reboot or cache clear during implementation | Case-specific current-boot approval and independent console recovery. Per-drill evidence cannot silently combine different boot/source pins into full phase acceptance |
| Phase 7 P0 · 7 active cases / 25 tuples; 5 Omni cases / 17 tuples retained but excluded | **Mesh/companion implemented; live acceptance pending. Omni temporarily excluded** | [Mesh](../../dashboard/apps/web/regression/administration/mesh-live.ts), [retained Realtime cases](../../dashboard/apps/web/regression/administration/realtime-live.ts), [native companion evidence](../../dashboard/apps/web/regression/administration/companion-live.ts), [runner guide](regression-runner-reference.md#phase-7-prerequisites) | 2026-10-18: experimental Omni/Realtime is excluded from regular requirements, execution and preparation by repository policy, without altering product support or historical failures. Local selection checks are not remote Mesh/Omni inference or four-platform CI acceptance. | Mesh/companion: two distinct pinned appliances and current native build matrix. Re-enable retained Omni cases only after Realtime is ready, then obtain fresh acceptance. |
| Phase 8 P0 · 6 cases / 20 tuples | **Implemented; live acceptance pending** | [Security/CI checks](../../dashboard/apps/web/regression/administration/security-live.ts), [form oracles](../../dashboard/apps/web/regression/administration/form-checks.ts), [repeat workflow](../../dashboard/apps/web/regression/administration/installed.e2e.spec.ts), [scheduled advisory CI](../../.github/workflows/dependency-security.yml) | Local guards only, not a current vulnerability audit or measured live leak budget | Exact installed-commit fresh CI runs, configured controls and reviewed repeat/resource budgets |
| HAR-04–09 · remaining domain-specific variants; P1 and other unmapped IDs | Domain adapters now implemented where assigned to Phase 3–8; unassigned/P1 cases remain Planned | Follow the exact per-phase matrices and prerequisite guide above, not an ID-only pass count | No wider product acceptance claimed | Live evidence, remaining parameter sets and P1 implementation remain separate |

HAR-10 / UX-02 follow-up, 16 October 2026: the Dashboard start dialog selects
all phases by default, Phase 3 alone, or non-consecutive subsets. Coverage uses
the existing [component/client tests](../../dashboard/apps/web/src/pages/RegressionPage.test.tsx),
[API tests](../../magic-cluster/apps/dashboard/test_regression_api.py),
[operator tests](../../magic-cluster/platform/magicstick-operator/controller/test_regression_runs.py),
[progress tests](../../dashboard/apps/web/regression/harness/kubernetes.unit.spec.ts)
and [desktop/mobile fixtures](../../dashboard/apps/web/regression/harness/regression.browser.spec.ts).
They check immutable selection, rejection before writes, cleanup retention,
polling, reload and selected-phase denominators. Browser fixtures remain in
`phase8-fixtures`; the owning component/API/progress checks remain in `selftest`.
Local checks do not establish published images or live appliance acceptance.

Update these explicit case/group entries as tests are implemented. Report unmapped IDs as Planned so they cannot disappear
from the backlog or coverage denominator.

HAR-02/07/10 and UX-02 follow-up, 22 October 2026: fixed Phase 4 diagnostic
profiles select existing SLOT-03/09, SHR-07/12 and HAR-08 scenarios through the
Kubernetes API/operator and native runner. The canonical catalog is
[`diagnostics.json`](../../magic-cluster/apps/regression/diagnostics.json).
The [selection counterexamples](../../dashboard/apps/web/regression/harness/diagnostic-selection.unit.spec.ts)
are selected by both `selftest` and `phase4-fast`; owning API/operator tests cover
allowlists, immutable requests, mixed-version schema/image rejection and unchanged
full/safe modes. Desktop/mobile fixtures in `harness/regression.browser.spec.ts`
are selected by both `phase4-fixtures` and `phase8-fixtures`. An isolated real
subprocess verifies scoped launch, receipt handling, cleanup fencing and report
scope. These implementation checks do not establish installed hardware acceptance;
the actual selected live tuples and exact cleanup still require a new appliance run.

HAR-02/07 follow-up, 22 October 2026: the native startup registration retains
its exact ID, Appliance/Node UIDs, policy and original creation identity when
the configured dashboard/Keycloak origins are renamed. The existing Kubernetes
unit selection exercises actual private-file persistence, equivalent object/key
order, both changed origins, foreign IDs/nodes/policy/unknown fields and symlinks.
This updates only the native API account's trusted origins; it does not clear a
Lease, change recovery journals or infer successful cleanup. A fresh live run
must still pass normal preparation, baseline checks and owned-resource recovery.

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
