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

After renaming the appliance, native preparation refreshes the dashboard and
Keycloak origins supplied by that same installation. Its saved registration ID,
Appliance/Node identities and policy must still match exactly. This does not
replace registration, discard old journals or bypass previous-run cleanup.

For focused Phase 4 checks, **Test selection** offers **Last GPU slot race**
(`SLOT-09`), **Sharing persistence after reload** (`SHR-12`), **Exact sharing and
resource restoration** (`HAR-08`), or their combined profile including `SLOT-03`
and `SHR-07`. Choosing one sets full mode and only Phase 4. Normal automatic
preparation, baseline checks and exact cleanup still run. The report retains the
profile after reload and is not full Phase 4 acceptance. **All tests in selected
phases** returns to ordinary phase selection. Unsupported installed versions do
not offer these profiles or silently expand them into a whole phase.
**Refresh tests** remains available during automatic updates. **Cancel tests**
requests bounded cleanup.

Experimental **Omni/Realtime tests are temporarily excluded** (`RT-01`–`RT-08`).
Phase 7 still runs Mesh/companion checks. Setup does not prepare Omni models or
GPU transitions for these excluded tests; reports list `VLLM-Omni` as excluded,
not passed or blocked. Ordinary Ollama/vLLM tests and product Omni support stay
unchanged. Re-enable the retained cases after Realtime is ready for acceptance.

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

The Dashboard, HTML, JSON, text and JUnit use the same reasons. JUnit includes
scenario/step outcomes and filtered traces; Blocked rows are skipped entries with
cause properties. The archive retains every row, even when the Dashboard limits
its expanded list. Raw credentials, journals and runtime logs stay private.
`HAR-10 / REPORT_EXPORT` means downloads could not be published: completed counts
remain visible, and it does not imply a cleanup failure. Inspect report size or
storage; do not repeat a multi-hour run or force recovery to recreate a download.
Tests skipped after a failed serial sibling link to that sibling's failure;
they are not reported as newly missing prerequisites.
Phase 5 shared application/service setup failures also retain their original
case and trace after browser-worker replacement, instead of repeating the same
failed setup. Application tests automatically choose and size a small model with
verified native context for all selected applications and their context edits;
the ordinary CPU smoke model remains separate. `APPLICATION_MODEL` means no
compatible catalog candidate fits the currently available RAM. API/estimator
errors remain failures, not missing prerequisites.
Missing AMD/NVIDIA hardware uses `GPU_PROVIDER`; unavailable current-boot
exact-card verification uses `GPU_VALIDATION`. Independent providers still run.
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
`diagnosticSelectionVersion: "1"` capability advances with that exact qualified
image. Do not add this capability to an older runner pin.

On registered test Appliances, host software convergence defers while a test or
cleanup run is active. Updates reserve the same lab Lease through Flux rollout;
start tests only after both the Runner and Dashboard revisions have converged.

See the [test catalog](regression-test-catalog.md),
[technical reference](regression-runner-reference.md) and
[image promotion](image-promotion.md). Installation tests and P1 are separate.
