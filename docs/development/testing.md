# Build and test

## Real-browser smoke

The dashboard now has a separate Playwright suite against its built production
web client, in desktop Chromium and mobile Chromium. API responses are isolated
fixtures: navigation, reload, administrator/viewer boundaries, expired sessions,
model stop/start, revision conflicts, log viewing and horizontal overflow are
checked without touching an appliance or creating a model.

```sh
cd dashboard
pnpm install --frozen-lockfile
pnpm --filter @magicstick/dashboard-web exec playwright install chromium
pnpm test:browser
```

On Linux CI, installation uses `playwright install --with-deps chromium`.
`pnpm test:components` retains the previous Vitest/jsdom application tests;
`pnpm test` remains the unit/component suite. Neither is labeled a real-browser
test. The dedicated browser CI runs for dashboard changes on PRs, main and
develop, and supports manual dispatch. Failure screenshots/traces are retained
for seven days and contain only synthetic fixture data.

The browser smoke does not prove Keycloak login, live Kubernetes reconciliation,
GPU inference, actual capacity, firmware changes or application data migrations.
Use the relevant live acceptance guide for those contracts.

## Installed-appliance regression plan

The [regression test concept](regression-test-concept.md) defines the incremental
API/UI/inference test strategy, safe use of the Mac and physical test appliance,
hardware matrix, execution profiles, evidence and incremental implementation
gates. The [test case catalog](regression-test-catalog.md) gives stable case IDs
for the dashboard's main functions, negative paths and known live regressions.

The [local Linux test container](regression-test-concept.md#local-phase-0-runner)
provides isolated safety/browser fixtures, a **read-only** live `preflight`,
and separately opt-in `locktest` and `ownedtest` safety subsets. It also has
an opt-in, run-owned **CPU/Ollama** `smoke` lifecycle and explicit `recover`
command; see the [smoke safety and setup](regression-test-concept.md#opt-in-cpu-model-smoke-and-recovery).
Use
`bash tools/regression.sh build`, `typecheck` and `selftest` from the repository
root before a live run. The lock test mutates only a dedicated lab Lease; the
owned test creates and revokes run-owned API keys. The model smoke is
implemented and its selected five-case CPU/Ollama lifecycle and inference
subset passed live after the LiteLLM certificate was corrected. GPU inference,
applications and complete live cleanup remain later gates. No GitHub Runner
is registered and no regression CI schedule is enabled by this implementation.

On 2026-10-01 the selected preflight, Lease/revision/polling subset and
API-key ownership/cleanup subset passed on the test appliance. Their private
reports and exact limits are recorded in the concept and catalog. A green
selected-case report is **not** acceptance of the full Phase 0 gate, model
lifecycle or inference.

The broader catalog remains a design/backlog, not live acceptance of those
features. Keep the current isolated browser suite independent. Installer/VM
provisioning tests remain a separate deferred work package.

## Release Validation

Run the public release checklist before tagging a public version:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
gitleaks detect --source . --config .gitleaks.toml --no-git
```

Also run the value scans from
[public-release-checklist.md](release-checklist.md). Expected findings
must be documented and safe.
