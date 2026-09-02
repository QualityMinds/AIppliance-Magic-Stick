# Changelog

Notable public changes to AIppliance-Magic-Stick should be recorded here.

The project follows a lightweight changelog style. Until a versioning policy is
formalized, release entries should group changes under:

- Added
- Changed
- Fixed
- Removed
- Security

## Unreleased

### Added

- Fail-closed one-command installation wrappers for dedicated Ubuntu 24.04
  hosts and existing Kubernetes clusters from Bash or PowerShell 7, including
  read-only preflight modes and First-Run Setup initialization.
- A local-network-only first-run wizard with physical-console claim code,
  mDNS-independent IP access, and one-time administrator provisioning.
- `ApplianceSetup` lifecycle state and fail-closed legacy migration behavior.
- GitHub Pages landing page with legal notice and privacy policy.
- Public support, maintainer, and governance documentation.
- A Git-owned application catalog and per-application Helm charts for runtime
  `AppInstance` resources.
- An administrator-only dashboard user-management tab for local Keycloak users,
  including search, access-level assignment, enable/disable, temporary-password
  reset, and protected deletion.
- CPU-backed local vLLM inference with a target-aware dashboard selector,
  cross-architecture smoke preset, and an extensible compute-target catalog.
- Shared 60-second Node Feature Discovery plus hardware-triggered, pinned
  NVIDIA, AMD, and Intel GPU operators with preflight, conflict protection,
  retained restart state, allocatable-resource readiness, and dashboard status.
- AMD ROCm and Intel XPU vLLM targets with vendor-specific KubeAI profiles,
  automatic Intel `xe`/`i915` resolution, and availability-gated model controls.
- Ollama as a second KubeAI inference engine with engine-aware dashboard
  controls, CPU/NVIDIA/AMD profiles, a portable Qwen2.5 smoke preset, persistent
  model cache, and target compatibility enforcement.
- Administrator-managed, SSO-bound Kubernetes access with Viewer, narrow
  Magic-Stick Operator, and explicit Cluster Administrator levels, plus
  token-free OIDC kubeconfig downloads for local or brokered Keycloak users.

### Changed

- Instance creation in the dashboard now uses a two-step dialog that lists all
  catalogued types, explains missing modules for unavailable types, and then
  shows only the selected available instance configuration.
- The dashboard overview now lists complete local, public, and direct URLs for
  modules and app instances, including accepted Gateway API `HTTPRoute` hosts.
- Public documentation is being aligned with runtime CRs, catalog-driven modules,
  derived instance hostnames, and dashboard-managed settings.
- `AppInstance` now uses `spec.application` and `spec.values`; the Magic Stick
  Operator creates one Flux HelmRelease per instance instead of rendering app
  workloads in controller code.
- New appliances are accelerator-neutral. KubeAI is activated on demand by CPU
  or GPU local models, the NVIDIA GPU module only by NVIDIA targets, and
  external models run without a local inference runtime.

### Fixed

- Downloaded Kubernetes SSO kubeconfigs now use the appliance's current private
  control-plane IP instead of its mDNS name for the API endpoint, allowing
  OpenLens and other proxying GUI clients to connect without `.local` DNS
  support while preserving the stable Keycloak issuer.
- The bare-metal first-run code now appears on a dedicated, periodically
  refreshed virtual console after cloud-init has finished. A centered,
  color-coded appliance panel separates the access paths, claim code, TLS
  fingerprint, and next steps. Boot logs remain on the first console, internal
  CNI and virtual-interface addresses are hidden, and completion clears the
  claim from the physical display.
- OpenClaw instances now consume the generated LiteLLM provider catalog and
  start with the catalogued local model instead of silently falling back to the
  built-in public OpenAI provider.
- Hermes instance URLs now open the bundled web dashboard on port `9119`
  instead of routing browsers to the API-only gateway root on port `8443`.
- Odysseus instances now register their selected model and the shared LiteLLM
  endpoint through the Odysseus API instead of relying on unsupported
  environment variables.
- Magic Stick-managed KubeOpenCode templates now receive model-specific context
  and output limits, preventing OpenCode from requesting 32000 output tokens
  from local vLLM models with a smaller total context window.
- Enabled modules are suspended instead of destructively pruned while their
  dependencies are temporarily unready during a source or operator rollout.
- Browser-streamed responses from LiteLLM, AnythingLLM, KubeOpenCode, and all
  catalogued application instances are no longer terminated by Envoy's default
  15-second request timeout.
- LiteLLM's SSO policy no longer replaces its `Bearer sk-...` virtual-key
  header with the Keycloak access token on UI and API requests.
- The enabled LiteLLM module again exposes its generated UI and API credentials
  to authorized operators and administrators from the dashboard Services tab.
- The Envoy Gateway now redirects appliance HTTP URLs, including LiteLLM UI
  paths, to the equivalent HTTPS URL instead of refusing port 80 connections.

### Removed

- Human default passwords and the generated `keycloak-local-admin` Secret from
  new installations.
- Application-specific manifest builders, cleanup lists, and direct workload
  permissions from the Magic Stick Operator.

### Security

- Dashboard user administration uses a dedicated scoped Keycloak service
  account, exact-name Kubernetes Secret RBAC, live administrator checks,
  same-origin mutation protection, and last-local-administrator safeguards.
- Human Kubernetes access uses short-lived OIDC credentials, PKCE, direct
  Keycloak group membership, least-privilege RBAC, public CA material, and no
  static bearer token or password in generated kubeconfigs.
