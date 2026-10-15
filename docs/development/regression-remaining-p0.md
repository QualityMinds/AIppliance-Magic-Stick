# Run regression tests

Use a **dedicated, disposable test Magic Stick**. Tests may stop models, change
settings, deploy services, replace test licenses and clear model caches.

## In the Dashboard

**No license is required.** Test-server registration is separate from licensing.

1. Open **System → Regression tests** as an administrator.
2. Once: **Enable regression runner**, wait for readiness, then **Register test
   Appliance** and confirm `DISPOSABLE TEST SERVER`.
3. Choose **Start regression tests**. Credentials, scoped Kubernetes access and
   small model fixtures are prepared automatically.
4. Watch progress, then download **Download report**, **HTML summary** or **JUnit XML**.

Every start cleans up the previous run, checks the baseline, creates a **new test
ID**, and runs all implemented Phase 0–8 P0 tests from the beginning. Earlier
results are never reused. Reloading the page does not stop the Kubernetes Job.
**Refresh tests** remains available during automatic updates. **Cancel tests**
requests bounded cleanup.

<a id="if-cleanup-is-blocked"></a>

### Clean up without starting tests

Choose **Clean up previous test run** to prepare a clean baseline in advance.
It runs only the old-run cleanup, not any test phases. Normal Start still cleans
up automatically when needed. If cleanup is blocked, inspect its reason and
stage: `recovery-journal`, `recovery-resource`, `recovery-module`,
`recovery-sharing`, or `gpu-validation` identifies the failed operation.
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

Service checks borrow an idle standalone service, test enable/disable and restore
its original state. An empty instance-provider module is not a service fixture.
Missing optional parameter maps are preserved, not treated as invalid setup.
Mutation receipts are isolated per worker, including after a failed case restarts
its browser worker. Each GPU scenario also reserves its own recovery journal,
even when consecutive successful cases share a worker. Kubernetes-access tests
use the pinned plugin's actual local
OAuth callback flow with verified IdP, client, PKCE and callback state.
License checks restore the original document or no-document baseline; a first
test activation never leaves a test entitlement installed.

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

The lab lock renews independently of browser/model waits. Independent checks
continue after failures; unproved cleanup blocks later live writes. A campaign
may clean up an exact finished child before continuing, retaining its original
failure. The next invocation still starts tests from the beginning.

## Results

- **Passed:** the selected scenario ran and its assertions passed.
- **Failed:** a product assertion, API, timeout or harness error failed.
- **Blocked by prerequisite:** required hardware, capability or external fixture
  is missing. The report gives the concrete prerequisite and next action.
- **Blocked by failure:** an earlier step or cleanup failed. The report links
  its original test ID, stage, reason and available filtered trace.

Scenario counts and case/variant/layer evidence counts are separate. Passed
fixture checks do not prove live acceptance. New reports flag missing required
execution evidence as `HAR-10 / MISSING_EVIDENCE`, rather than guessing a missing
prerequisite. Older reports keep unknown causes and their original outcomes.

The Dashboard, HTML, JSON, text and JUnit use the same reasons. JUnit includes
scenario/step outcomes and filtered traces; Blocked rows are skipped entries with
cause properties. The archive retains every row, even when the Dashboard limits
its expanded list. Raw credentials, journals and runtime logs stay private.
Tests skipped after a failed serial sibling link to that sibling's failure;
they are not reported as newly missing prerequisites.
GPU startup and first CPU inference retain structured Pod/routing/response
diagnostics; Realtime readiness also retains bounded private runtime logs before
cleanup. Repeated-cycle checks separate model-cache growth from other disk
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

On registered test Appliances, host software convergence defers while a test or
cleanup run is active. Updates reserve the same lab Lease through Flux rollout;
start tests only after both the Runner and Dashboard revisions have converged.

See the [test catalog](regression-test-catalog.md),
[technical reference](regression-runner-reference.md) and
[image promotion](image-promotion.md). Installation tests and P1 are separate.
