# Run regression tests

Use a **dedicated, disposable test Magic Stick**. Tests may stop models, change
settings, deploy services, replace test licenses and clear model caches.

## In the Dashboard

**No license is required.** Test-server registration is separate from licensing.

1. Open **System → System Status → Regression tests** as an administrator.
2. Once: **Enable regression runner**, wait for readiness, then **Register test
   Appliance** and confirm `DISPOSABLE TEST SERVER`.
3. Choose **Start regression tests**, then **Non-destructive only** (default) or
   **Include destructive tests**. Keep all phases selected for a complete run,
   or use **Clear selection** and select, for example, **Phase 3**. Confirm with
   **Start tests**. Credentials, scoped Kubernetes access and small model fixtures
   are prepared automatically.
4. Watch progress, then download **Download report**, **HTML summary** or **JUnit XML**.

On a new installation, **Enable regression runner** is available before the
runner's permissions exist. The test lock remains unverified until installation;
opening or refreshing this page does not enable or start anything.
Activation shows an activity bar: first **Enabling regression runner…**, then
**Waiting for runner readiness…** after the request is accepted. Image downloads
and service startup can take several minutes. Status updates automatically; the
bar is not a time estimate, and activation never starts tests. Registration is
offered only after readiness is confirmed.

**Non-destructive only** runs isolated checks and live read-only inventory. It
does not stop or deploy models, run inference, change settings/sharing/services/
licenses/caches or restore old test resources. Only the temporary viewer account,
runner Job and reports are created and cleaned up. A previous interrupted run
must be cleaned up separately first. Reports name excluded live steps; a green
limited selection is not full-phase acceptance. This mode is currently available
in the Dashboard/API's Kubernetes runner, not the external Docker launcher.

Every full start cleans up the previous run, checks the baseline, creates a **new test
ID**, and runs the selected P0 phases from the beginning. All Phase 0–8 tests are
selected by default. Progress and reports identify the saved selection; other
phases are not run or counted as passed. Earlier results are never reused.
Reloading the page does not stop the Kubernetes Job.

Full cache scenarios automatically populate a small owned model cache, remove
the exact model resources and wait for fresh host inventory before deleting.
The cache race requires observed overlap or the worker's exact safe cache-in-use
rejection; finishing too early is blocked, not proof of a race. SEC-03/MESH-09
need fresh CI for the installed GitOps commit, including a later image-pin
promotion. A green build for the earlier image source alone does not supply
those separate checks. Preparation queries that exact commit rather than only
the most recent repository-wide runs; older results are never rewritten.

After renaming the appliance, native preparation refreshes the dashboard and
Keycloak origins supplied by that same installation. Its saved registration ID,
Appliance/Node identities and policy must still match exactly. This does not
replace registration, discard old journals or bypass previous-run cleanup.

For focused checks, **Test selection** offers fixed subsets of existing cases:
the Phase 2 controlled external provider (`ROUTE-05`); Phase 3 single-GPU or
all-GPU verification (`HW-06`, each including Ollama and vLLM), or the existing
two-card independent-copy Ollama lifecycle (`MGPU-02`); and Phase 4
slot consumers (`SLOT-03`), two- or four-card shared split Ollama (`MGPU-01`), **Last GPU
slot race** (`SLOT-09`), **Sharing persistence after reload** (`SHR-12`), **Exact
sharing and resource restoration** (`HAR-08`), or the combined remaining-sharing
profile including `SHR-07`. Choosing one sets full mode and only its advertised phase. Normal automatic
preparation, baseline checks and exact cleanup still run. The report retains the
profile after reload and is not full-phase acceptance. **All tests in selected
phases** returns to ordinary phase selection. Unsupported installed versions do
not offer these profiles or silently expand them into a whole phase.
Before a live scenario acquires the test Lease, a readiness-only miss refreshes
the complete baseline for at most 90 seconds. The source and image pins remain
exact; changed identities, different pins and read failures stop immediately.
The worker's private `preflight-pins/<scope>.json` names the fixed failing component
index and condition, first failure and bounded transitions without credentials,
raw responses or workload names. A
failed check keeps `REVISION` and its stage rather than becoming a generic timeout.
**Refresh tests** remains available during automatic updates. **Cancel tests**
requests bounded cleanup.

Experimental **Omni/Realtime tests are temporarily excluded** (`RT-01`–`RT-08`).
Phase 7 still runs Mesh/companion checks. Its read-only Mesh navigation proof
checks complete saved module intent plus UIDs/generations through the existing
observer, separately from volatile reconciliation status and the no-write fence.
Setup does not prepare Omni models or
GPU transitions for these excluded tests; reports list `VLLM-Omni` as excluded,
not passed or blocked. Ordinary Ollama/vLLM tests and product Omni support stay
unchanged. Re-enable the retained cases after Realtime is ready for acceptance.

All **product-service/application live workflows are deferred to separate
regression**, not only Hermes. Standard Phase 5 excludes live `MOD-03`, `MOD-04`,
`MOD-10`, `APP-02/05/06/07/09/10` and `ACL-01/02/04/06`: no service fixture
enable/disable, credential reveal, instance creation, app inference or app ACL
workflow is prepared or executed. Automatic/terminal setup and retained input
profiles use the same exclusion. Existing resource cleanup remains available,
with unchanged ownership checks. Unverifiable old receipts remain blocked.
The existing `excludedSteps` metadata records these fixed labels in the Dashboard,
JSON, HTML, text and the separate not-selected JUnit suite:

- `phase5/applications-live (deferred to separate regression)`
- `phase5/services-live (deferred to separate regression)`
- `phase5/service-credentials-live (deferred to separate regression)`

Isolated U/C/B contracts remain selected. Core user/authentication/key/license/
Kubernetes/model/GPU checks remain active; `MOD-06` checks AMD profile readiness
independently of application fixtures. Exclusions add no Passed or Blocked rows,
do not disable product services, and do not grant full Phase 5 service/application
acceptance. Historical failures and recorded Hermes-only exclusions remain
unchanged. The separate native suite has not yet been implemented.

<a id="if-cleanup-is-blocked"></a>

### Clean up without starting tests

Choose **Clean up previous test run** to prepare a clean baseline in advance.
It runs only the old-run cleanup, not any test phases. Normal Start still cleans
up automatically when needed. If cleanup is blocked, inspect its reason and
stage: `recovery-journal`, `recovery-resource`, `recovery-module`,
`recovery-sharing`, or `gpu-validation` identifies the failed operation.
`gpu-backend` identifies a wait for the original GPU allocator to become ready.
The outer cleanup deadline preserves that current step rather than replacing it
with a generic `cleanup` stage. Keep the journal and resolve the reported backend
condition; a timeout is never permission to release its lock.
Retained setup access can need cleanup even when the test lock is already free.
The button handles that state too. Its adjacent explanation distinguishes
already clean, active work and missing ownership evidence; disabled never
means an unverified clean baseline.
The cleanup button stays visible and is disabled with a ready-state explanation
when no previous run needs cleanup.

Keep the retained journal and correct that specific cause, then retry. A repeated
cleanup recognizes completed steps. An active owner, missing journal, changed UID
or intervening revision requires inspection; the lock cannot be force-released.
External-run journals must be cleaned up on their original runner. Historical
failed reports remain unchanged.

`PROCESS_STATE` means the old runner did not prove all its workers stopped; it
is a harness failure, not a missing prerequisite or proof of another owner.
The bounded private `process-state.json` records process states and birth
identities, never command lines or environment. Live or unreadable workers stay
fenced. Linux zombies are already unable to write and are reaped by the runner's
init. For an old Kubernetes session, normal cleanup verifies the retained
account's exact completed run, Job, Pod/container and node identity before
attesting termination. The original session/report is not changed; resource
absence, restored settings and Lease release are still checked separately by
the existing recovery. A missing old Pod or changed identity requires review,
not a manual lock release.

Service checks borrow an idle standalone service, test enable/disable and restore
its original state. An empty instance-provider module is not a service fixture.
Missing optional parameter maps are preserved, not treated as invalid setup.
Mutation receipts are isolated per worker, including after a failed case restarts
its browser worker. Cleanup checks the full resource inventory, then verifies
each mutated journal scope independently. Adding a later already-cleaned worker
does not invalidate an unchanged root receipt. Any open resource or changed
receipt still fences writes; older receipts without sufficient proof require
the same exact-journal recovery rather than inferred approval.
Each GPU scenario also reserves its own recovery journal,
even when consecutive successful cases share a worker. Fresh exclusive GPU
defaults need no manual sharing setup. Full GPU scenarios borrow that baseline,
configure the required allocator and restore exclusive device-plugin readiness
before removing only the settings they introduced. Missing maps, missing fields
and empty strings are restored distinctly; existing saved sharing settings and
unrelated parameters are preserved. Custom/inherited sharing is not silently
adopted. An ambiguous write or foreign revision still blocks cleanup.
Kubernetes-access tests
use the pinned plugin's actual local
OAuth callback flow with verified IdP, client, PKCE and callback state.
K8S-02–06 run independently: an export failure does not stand in for failed
Viewer/Operator/admin permissions. Export waits for the actual copy and download,
checks complete current-user contents privately, then clears/deletes them.
Access-switch/revocation checks sign in afresh after the old session is ended.
Only the administrator case requires the cluster-admin grant; export needs no
exec plugin. `kubeconfig-copy`/`kubeconfig-download` identify export failures;
`kubernetes-access`/`kubernetes-revoke` identify permission/revocation failures.
License checks restore the original document or no-document baseline; a first
test activation must not leave a test entitlement installed. LIC-02 only previews
the automatically generated Free Registered and Commercial fixtures; LIC-03
rejects invalid documents independently; only LIC-04 activates and restarts the
API Pod. An identical-document import need not change its revision. Confirmed
revisions and private restoration receipts are saved before UI postconditions.
Restart completion requires the exact old API Pod to be absent as well as one
owned, Running, nonterminating, Ready replacement on the expected image digest.
A replacement serving HTTP while the old Pod drains is not completion; the
unchanged final deployment-pin check still inspects the installed baseline.
An unfinished receipt fails cleanup and retains the safety lock. License stages
are `license-review`, `license-reject`, `license-activate`, `license-restart` and
`license-restore`; historical reports are not rewritten after repair.

The in-Appliance runner cannot independently verify its own reboot, power loss,
network disconnection or software replacement. Those checks report
**Blocked / EXTERNAL_RUNNER**; use the external runner below. Missing GPUs, Mesh
peers, test identity providers or current CI evidence block only dependent cases.

<a id="once"></a>

## External runner: once

From the repository root, with Docker running:

```bash
bash tools/regression.sh build
bash tools/regression.sh setup
```

Enter the Dashboard URL and test administrator credentials. Supply the trusted
Appliance CA PEM if required. Setup discovers endpoints, creates scoped access
and registers this installation. It never adopts a replacement Appliance.

<a id="every-run"></a>

## External runner: every run

```bash
bash tools/regression.sh all
```

No repeated setup, approvals or manual JSON files. Current boot/source/image pins
and fixtures are prepared automatically. Rebuild after changing runner code.
Optional subset: `all --phases 2-4`. Keep the private directory so automatic
cleanup can verify old resources and restore recorded settings. Ctrl+C stops
further tests and requests cleanup.

For an individual diagnosis after preparation, use, for example,
`bash tools/regression.sh phase5-live LIC-04`. Phases 5–8 accept one of their own
live case IDs this way. The same registered-lab, identity, lock and cleanup rules
apply. This creates a fresh **scoped** report, not a full-phase acceptance result.
Rebuild the runner after source changes; do not run another test while the lab
lock is owned by an active run.
The same Phase 4 catalog is available externally as
`bash tools/regression.sh phase4-sharing slot-race`, `reload`, `restoration` or
`remaining`. It uses the existing sequential launcher and per-scenario budgets,
not a second test engine. Diagnostic discovery requires every selected live
case/variant/layer tuple, and missing execution evidence remains a harness failure.

The lab lock renews independently of browser/model waits. Independent checks
continue after failures; unproved cleanup blocks later live writes. A campaign
may clean up an exact finished child before continuing, retaining its original
failure. The next invocation still starts tests from the beginning.

Phase 4 runs sharing and multi-GPU scenarios one at a time. Each has its own
60-minute test budget and ten-minute cleanup budget; earlier scenarios cannot
use up a later one's test time. No extra configuration is needed.
The page separates test completion, resource cleanup and account removal.
Only `verified` resource cleanup proves a clean baseline. For `required` or
`blocked`, keep the private journal and inspect its reason/stage; use **Clean up
previous test run**, not a forced unlock. Old missing cleanup fields mean
not verified. Successful cleanup never turns an old failed test into a pass.

## Results

- **Passed:** the selected scenario ran and its assertions passed.
- **Failed:** a product assertion, API, timeout or harness error failed.
- **Blocked by prerequisite:** required hardware, capability or external fixture
  is missing. The report gives the concrete prerequisite and next action.
- **Blocked by failure:** an earlier step or cleanup failed. The report links
  its original test ID, stage, reason and available filtered trace.

**All checks** is the main Dashboard/HTML/text total: case/variant/layer evidence,
isolated and live together, including runner/cleanup errors without a scenario ID.
**Executable scenarios** follows separately (closed by default in the Dashboard
and HTML). Its blocked-cause counts describe scenarios, not all evidence.
Live evidence and phase results remain separately labelled. Use the report's
global totals directly; phases can overlap and the displayed failure list can be
limited. Missing final totals are unavailable, not zero; recorded progress can
show only explicitly preliminary scenario counts. **100% means execution
finished, not passed.** JSON and JUnit keep their separate counting units.
Passed fixture checks do not prove live acceptance. New reports flag missing required
execution evidence as `HAR-10 / MISSING_EVIDENCE`, rather than guessing a missing
prerequisite. Older reports keep unknown causes and their original outcomes.

Phase 1's reporter and post-cleanup finalization use the same step-specific
requirements from `profiles/phase1-p0.ts`. Core CPU/Ollama evidence does not
include the separate session, browser-fixture or final-preflight checks. The
complete Phase 1 report still requires all selected variants and layers across
those steps. A genuine missing selected check still fails `MISSING_EVIDENCE`;
repairing the scope does not remove failures from historical reports.

A recorded failed preparation remains the original `HAR-02` failure. Live checks
refused by that explicit barrier are **Blocked by failure**, not additional
`HAR-10 / MISSING_EVIDENCE` errors. Missing isolated coverage still fails.
An explicit case's saved cause takes precedence over a later inherited recovery
cause; the original case, stage and trace remain available. Standalone worker
imports are checked with plain Node, not only Playwright's transpiler. An
unsupported TypeScript import is reported as `CONFIG` at `input-discovery` with
the fixed `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` detail, never a raw stack or private
path. Resource-cleanup proof remains independent and old reports stay unchanged.

The Dashboard, HTML, JSON, text and JUnit use the same reasons. JUnit includes
scenario/step outcomes and filtered traces; Blocked rows are skipped entries with
cause properties. The archive retains every row, even when the Dashboard limits
its expanded list. Raw credentials, journals and runtime logs stay private.
`HAR-10 / REPORT_EXPORT` means downloads could not be published: completed counts
remain visible, and it does not imply a cleanup failure. Inspect report size or
storage; do not repeat a multi-hour run or force recovery to recreate a download.
For a pinned-baseline failure, inspect **Preflight observations** in the HTML or
text report, or the filtered trace JSON: the first failed predicate, observation
windows, resource fingerprints and bounded transition history remain visible
even if the baseline later converges. Exact-object events and fixed container
restart/exit reasons help distinguish rollout, stale generation and crashes.
Short native controller logs, when authorized and available, stay private.
Unavailable diagnostics are explicitly labelled, not treated as an empty history
or proof of a cause. No log permission is added to the read-only observer.
Tests skipped after a failed serial sibling link to that sibling's failure;
they are not reported as newly missing prerequisites.
The retained, separately deferred Phase 5 application/service adapters preserve
their original diagnostics for future separate acceptance. Their setup failures retain the original
case and trace after browser-worker replacement, instead of repeating the same
failed setup. Application tests automatically choose and size a small model with
verified native context for all selected applications and their context edits;
the ordinary CPU smoke model remains separate. `APPLICATION_MODEL` means no
compatible catalog candidate fits the currently available RAM. API/estimator
errors remain failures, not missing prerequisites.
Hermes uses its native `/chat` terminal, not a generic Send form. The existing
application workflow observes the browser's own PTY and same-channel events
feed, requires the owned local model and a fresh completed assistant turn, then
checks **Copy last assistant response** and clears the clipboard. The separate
sidebar/configuration connection and prompt echoes are not inference evidence.
A wrong built-in UI adapter is a harness failure, not an external prerequisite.
KubeOpenCode uses its pinned OpenCode workspace/session composer. The browser's
real native submission must select the owned `litellm` model and `/workspace`;
native POST directory headers and GET query scopes are checked explicitly.
Before opening that composer, APP-02 waits for the instance's same-Agent Service
and fully observed single-server Deployment, with exactly one owned ready Pod
and the configured runtime image. A Helm-ready CR can still have two native
server Pods during a rollout; creating a session on one and prompting the other
does not establish a working application.
The adapter first waits for loaded owned-model and agent controls, not just the
editor: native submission can return without sending while those queries load.
Missing/wrong selections fail at `app-ready`; the first request is not retried.
Only a fresh completed assistant message with the submitted parent/model/session
identity and matching visible assistant content proves inference. Prompt echoes,
old turns, tool-only/partial/error messages and external models cannot pass.
The private `opencode-chat-proof.json` contains readiness/submission/completion
booleans and the native prompt HTTP status when observed, not raw messages.
KEY-04's unmanaged-key transaction belongs beside that worker's journal, including
after an earlier case restarted the worker. It must not change the original
worker's verified scope. A successfully recovered cleanup can coexist with a
historical cleanup error in the same report; neither outcome is rewritten.
Missing AMD/NVIDIA hardware uses `GPU_PROVIDER`; unavailable current-boot
exact-card verification uses `GPU_VALIDATION`. Independent providers still run.
MOD-06 waits for the saved ModuleActivation generation and its projected profile
before reloading Hardware; a stale or missing projection is not a persisted-form
failure after five seconds. A foreign intent fails immediately, and restoration
has its own bounded `recovery-module` readback. KEY-04 consumes the existing
administrator credential response as opaque header material, not a user API token
with a prescribed prefix. No master credential is copied into reports or URLs.
An observed HW-06 binding or image mismatch after verification was submitted
is a failed proof at `gpu-binding`, not evidence that hardware is absent. Its
private `verification-binding-failure.json` retains only fixed check codes and
run/request identity; no credentials or raw runtime output are exported. Inspect
that exact proof before changing allocator settings or repeating the test.
NVIDIA binding is observed while the diagnostic runs. Kubernetes can clear the
claim's allocation when its last consumer completes, before the successful Pod
is deleted. Only an allocation already verified for that same Pod and unchanged
Claim UID/generation/spec may then prove the completed diagnostic. A raced Pod
read is refreshed by exact UID; an unseen, replaced, changed, still-running or
wrong-card allocation is not accepted as successful verification.
Native Kubernetes ResourceClaims have immutable specs and do not maintain a
CRD-style positive `metadata.generation`. Verification requires an observed UID
and resource version, retains the exact spec and any supplied generation, and
permits status-only resource-version advancement during allocation/release.
Missing identity, changed intent and unobserved physical binding still fail.
This follows Kubernetes' [native ResourceClaim strategy](https://github.com/kubernetes/kubernetes/blob/v1.36.4/pkg/registry/resource/resourceclaim/strategy.go),
not the generation contract of Magic Stick's editable CRDs.
Functional browser, API, inference and Realtime probes use HTTPS but do not
validate its certificate. Certificate acceptance belongs to HAR-01 and trusted
credential setup; Kubernetes access still checks the downloaded CA contract.
MOD-03 probes the registered connection's local/public/direct scope, not every
advertised URL: a local run does not require public example-domain DNS. Missing
local routes, DNS/connection failures and unexpected HTTP responses still fail.
Service probes share prepared DNS mappings; new exact local service names remain
only in the current private run directory, without capturing another appliance.
Module/application route changes also check gateway process stability. GPU
verification closes the request page during the native Job and uses a fresh
page for the terminal result, without retries or weaker GPU checks.
GPU startup and first CPU inference retain structured Pod/routing/response
diagnostics; Realtime readiness also retains bounded private runtime logs before
cleanup. vLLM collective preflight exports only fixed reason/transport/cleanup
fields and the last fixed milestone per rank (import, assignment, NCCL
initialization or data exchange) when available. Raw startup output stays
private; historical traces without milestones stay unchanged. A failed cleanup
journal retains its operation and fixed reason/stage for exact-resource diagnosis
and safe retry.
The native collective probe explicitly uses matching Float32 send/receive
buffers. Its owning-layer counterexample exercises every directed peer pair
for two- and four-GPU groups; live MGPU-01 still requires successful native
qualification and routed inference rather than treating that fixture as hardware
acceptance.
Repeated-cycle checks separate model-cache growth from other disk
growth and verify model, Pod, claim, route and key cleanup. Expected service
rollouts compare stable workload UIDs and replica counts, not replaceable Pod
UIDs; extra replicas, replaced workloads and leftover test Pods still fail.

External reports are under `.regression/private/runs/reg-…/`; the console prints
`all-summary.txt`. Open `summary.html` or extract `report-artifacts.tar.gz` before
importing `junit.xml` so relative filtered-trace links resolve. Exit codes:
**0** passed, **1** failures, **2** blocked without failures.

## CI and details

Use the same commands on a trusted runner with persistent private lab inputs.
For first registration, `setup --url … --username … --password-file … --ca-file …`
is available; `all` is noninteractive. Never expose lab access to untrusted forks.

The `regression-image` CI job builds the pinned Linux runner and runs isolated
checks before promoting its immutable digest on `main` or `develop`. A source
push alone does not verify installation. Check both runner and Dashboard image
revisions before live acceptance. Physical multi-GPU inference still needs real
hardware; synthetic card fixtures only prove their recorded UI/contracts.

For an explicitly approved feature-branch rollout, manually dispatch **Regression
runner** on that branch with `publish_candidate: true`. All build and isolated
checks still run. Only the tested exact-source image is published and verified
by anonymous pull; the summary records its immutable digest. Manual dispatch
never promotes `main` or `develop`. Adopt that digest and `sourceRevision` in
`magic-cluster/apps/regression/runtime.yaml` on the feature branch, refresh
the generated deployment references and verify the installed revision separately.
Use the tested-source replacement in `tools/promote_regression_image.py` so its
`diagnosticSelectionVersion: "2"` capability advances with that exact qualified
image. Do not add this capability to an older runner pin.

On registered test Appliances, host software convergence defers while a test or
cleanup run is active. Updates reserve the same lab Lease through Flux rollout;
start tests only after both the Runner and Dashboard revisions have converged.

See the [test catalog](regression-test-catalog.md),
[technical reference](regression-runner-reference.md) and
[image promotion](image-promotion.md). Installation tests and P1 are separate.
