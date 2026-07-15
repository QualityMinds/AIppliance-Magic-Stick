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

- GitHub Pages landing page with legal notice and privacy policy.
- Public support, maintainer, and governance documentation.
- A Git-owned application catalog and per-application Helm charts for runtime
  `AppInstance` resources.

### Changed

- Public documentation is being aligned with runtime CRs, catalog-driven modules,
  derived instance hostnames, and dashboard-managed settings.
- `AppInstance` now uses `spec.application` and `spec.values`; the Magic Stick
  Operator creates one Flux HelmRelease per instance instead of rendering app
  workloads in controller code.

### Removed

- Application-specific manifest builders, cleanup lists, and direct workload
  permissions from the Magic Stick Operator.
