# Governance

AIppliance-Magic-Stick uses lightweight maintainer governance.

## Project Scope

The project provides a reusable public template for building a local AI
appliance with host automation, K3s, Flux, Kubernetes modules, runtime CRDs, and
a dashboard.

External deployment overlays, customer-specific configuration, runtime secrets,
and production support contracts are outside the scope of this public
repository.

## Change Process

Changes are proposed through pull requests. Maintainers review for:

- public-safe values
- compatibility with the reusable template model
- clear documentation
- renderable Kubernetes manifests
- reasonable operational risk

Breaking changes should include migration notes in [CHANGELOG.md](CHANGELOG.md)
or the pull request description.

## Releases

Release tags should be created only after the checks in
[docs/public-release-checklist.md](docs/public-release-checklist.md) pass.
Downstream deployments should pin tags or commit SHAs instead of tracking
`main` directly.

## Conduct And Security

Community behavior is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Security reporting is governed by [SECURITY.md](SECURITY.md).
