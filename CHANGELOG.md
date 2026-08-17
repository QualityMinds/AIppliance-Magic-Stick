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

### Removed

- Human default passwords and the generated `keycloak-local-admin` Secret from
  new installations.
- Application-specific manifest builders, cleanup lists, and direct workload
  permissions from the Magic Stick Operator.

### Security

- Dashboard user administration uses a dedicated scoped Keycloak service
  account, exact-name Kubernetes Secret RBAC, live administrator checks,
  same-origin mutation protection, and last-local-administrator safeguards.
