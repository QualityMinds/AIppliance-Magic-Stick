# Dashboard development

## React Dashboard

The standard frontend is developed as a pnpm workspace under `dashboard/`:

```text
dashboard/
  apps/web                 React browser application and nginx image
  apps/cli                 standalone command line client and terminal UI
  apps/api                 license verification module, issuer and API runtime image
  packages/contracts       typed API contracts and response validation
  packages/api-client      authenticated transport shared by all clients
  packages/core            role, formatting, catalog, and selection logic
```

It deliberately uses the existing backend API and runtime resources. It does
not duplicate Kubernetes access, Keycloak administration, model discovery, or
reconciliation logic in a client. The CLI and TUI reuse the same contracts, API
client, and core rules without importing React.

Normal dashboard-source pushes to `main` and `develop` build and automatically
promote a coordinated Web/API/CLI image set after required CI succeeds. The
Deployments still use immutable digests, and feature-branch/manual builds remain
explicit promotion candidates. Verify promotion and live convergence separately in
[dashboard image promotion](image-promotion.md#dashboard-image-promotion).

The React frontend is the only browser dashboard, deployed as
`dashboard/ai-appliance-dashboard`. Open `https://<mDNS-domain>/` (by default
`https://magicstick.local/`) or the configured public-domain root. The existing
Service, primary routes, OIDC callbacks and `MagicStickAccessToken` cookie names
are retained. The local route keeps `lab42.io/mdns.enabled: "true"`, so kdns
publishes the primary hostname when the route is accepted and the Gateway has
an address. First-run setup and the physical CLI/TUI console keep their existing
handoff URLs and do not require another dashboard address.

The former ConfigMap frontend and separate preview Deployment, Service, route,
OIDC policy and mDNS hostname are removed. There is no old-UI fallback link.
See [operations](../administration/troubleshooting/dashboard-upgrades.md#dashboard-upgrade-cleanup) for upgrade cleanup,
including old containers retained by another server-side-apply field manager
(`FailedMount`/Flux `HealthCheckFailed`) and external GitOps installations that
disable pruning. The opt-in administrator migration helper preserves the new
frontend and runtime data; it does not add workload-write access to the API.

The React implementation retains the established tab-by-tab feature contract:

| Area | React parity contract |
|---|---|
| Overview | Appliance and object counts, discovered module and instance URLs with local/public/direct classification and copy/open actions, plus appliance, module, instance, model, removal, and Flux attention items. |
| Models | CPU and per-GPU memory gauges; preset, direct-reference, Hugging Face, and Ollama discovery; popular and family shortcuts; paginated repositories and quantizations/tags; metadata, download size, context, memory estimator, over-capacity markers, creation, revision-safe parameter editing, progress, registered catalog models, removal, and local-runtime cleanup. |
| Services | Catalog-driven Applications, AI Runtime, and Platform groups; dependency-aware enable/disable controls; parameters; credentials; collapsible instances; progress, messages, routes, removal, and all OpenClaw, Hermes, Paperclip, KubeOpenCode, Odysseus, and Pi Coding Agent create options. |
| API Access | Endpoint display/copy, named-key creation, one-time secret display/copy, non-secret metadata, refresh, and guarded revocation. |
| Mesh | Administrator-only top-level page immediately after API Access; optional module activation, membership, invitations, local-model sharing, relay configuration, and status. Former Settings Mesh links redirect here. |
| Kubernetes Access | OIDC readiness, role explanations and warnings, user search/pagination, access assignment/removal, and readiness-guarded kubeconfig download/copy. |
| Federated SSO | Entitlement status, stable issuer and per-provider callback, OIDC/SAML metadata validation, redacted provider state, exact role mappings, guarded save/delete, and local-recovery guidance. |
| System | Category tabs for public/mDNS settings; offline license administration and software notices; server-side user administration; federated SSO; Hardware profiles and validation; administrator-only Model cache cleanup at `#/system/model-cache`; hardware, Flux, Pod, Service, Ingress, and route status; and administrator-only Computer power controls at `#/system/power`. Legacy `#/settings`, `#/license`, and `#/users` hashes resolve to their new nested System routes. |

`dashboard/apps/web/src/FeatureParity.test.tsx` protects these user-visible
contracts independently of the smaller application-shell tests. Catalog and
API behavior remain covered by the existing Python dashboard tests.

## Updating The Dashboard

The dashboard may read Kubernetes status and create or patch
`ModuleActivation`, `ModelActivation`, and `AppInstance` resources. It must not
directly create workloads, Flux Kustomizations, HelmReleases, or specialized
operator CRs.
Provider Secrets created from user-entered model credentials must stay scoped to
that dashboard workflow. Keep dashboard examples limited to `example.local`,
`example.com`, `CHANGEME`, or documented variables.

The standard React frontend and terminal clients live under `dashboard/`.
Deployment resources and the shared API remain in `magic-cluster/apps/dashboard`;
there is no separate preview frontend or ConfigMap-based HTML renderer. All
clients share framework-neutral contracts, transport, and core logic. Install
and verify them with the pinned workspace lockfile:

```bash
cd dashboard
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` creates both the React bundle and the standalone
`apps/cli/dist/magicstick.js` executable. Smoke-test the CLI without a live
server:

```bash
pnpm cli --version
pnpm cli --help
```

Build production images from the **repository root** (not `dashboard/`) so
source-of-truth license notices can be included:

```bash
cd .. # when still in dashboard/ from the commands above
docker build -f dashboard/apps/web/Dockerfile -t magicstick-dashboard:local .
docker build -f dashboard/apps/cli/Dockerfile -t magicstick-cli:local .
docker build -f dashboard/apps/api/Dockerfile -t magicstick-api:local .
```

The dashboard nginx configuration and the identity `auth-pilot` use one worker,
matching their fractional CPU budgets. Do not scale their workers to the host's
CPU count: that can exceed the Pod's memory limit on a many-core appliance.
The pilot mounts a hash-named generated ConfigMap, so configuration changes roll
its Pod. Keep the existing CPU/RAM limits and the dashboard's non-root, read-only
runtime. CI runs both nginx configurations inside their declared resource budgets:

```bash
MAGICSTICK_RUN_NGINX_CONTAINER_TESTS=1 python3 -m unittest -v tests.test_nginx_runtime
```

The tests check HTTP responses, exactly one worker, no cgroup OOM events and no
container restarts; they need Docker and no appliance access.

The API Dockerfile has one final runtime containing the BSL-licensed
`magicstick_core` package, license texts and third-party notices.
Only Federated SSO depends on a signed entitlement. Do not split the source or
images by edition. Follow [the release audit](license-audit.md) before publishing.

For coordinated API/ConfigMap changes, matching immutable images must publish
before deployment pins advance. Normal push builds on `main`/`develop` perform
this promotion automatically only after public and browser checks succeed.
The workflow can also build an integration branch via `workflow_dispatch`, but
does not automatically promote manual candidates. `main` builds update mutable
`web`, `react-preview`, `console` and `api-licensing-v1` aliases; `develop` builds
update only their development aliases. Integration branches publish SHA tags
without moving either installation channel. Aliases alone never change a pinned
Deployment. See [image promotion](image-promotion.md#automatic-promotion).

Software channel selection extends the existing host-operation contract rather
than creating another update controller. `software_contract.py` is shared by the
API image and host worker. `SoftwareChannelEditor` uses typed host status and
check/apply requests; the host performs Git/registry inspection, Ansible execution,
Flux verification and durable recovery. Tests cover role enforcement, ref syntax,
stale previews, moved branches, failure pause and matching image verification.
Keep Ubuntu package policy separate. See [API contract](../reference/dashboard-api.md#software-channel-operations).

The browser and terminal apps may import only `packages/api-client`,
`packages/contracts`, and `packages/core` for control-plane behavior. Keep DOM,
React, ANSI, filesystem, and process dependencies out of those packages. New
API capabilities must be implemented and authorized in the shared dashboard
API, not directly against Kubernetes from any client. CLI mutations should use
explicit commands. The TUI uses role-filtered controls and tested confirmation
dialogs for mutations; it must not bypass shared API authorization.
