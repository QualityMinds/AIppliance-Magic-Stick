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
- New appliances are GPU-neutral. GPU Operator and KubeAI are activated on
  demand by local models, while external models run without the local GPU
  runtime.

### Fixed

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
  to authorized operators and administrators from the dashboard Modules tab.
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
