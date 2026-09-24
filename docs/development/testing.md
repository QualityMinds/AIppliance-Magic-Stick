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
