# Maintainers

This file documents the public maintainer model for AIppliance-Magic-Stick.

## Current Maintainer Group

The repository is maintained by the owning GitHub organization:

- QualityMinds GmbH
- https://github.com/QualityMinds

## Responsibilities

Maintainers are responsible for:

- reviewing pull requests for reusable template quality
- keeping public examples free of deployment-specific values
- triaging issues and security reports
- updating release notes and public release checks
- deciding when a release tag is ready for downstream deployments to pin

## Decision Making

Routine changes can be accepted by maintainer review. Risky changes should be
discussed in issues or pull requests before merge, especially changes involving:

- installer behavior
- Flux bootstrap paths
- CRD schemas
- security-sensitive defaults
- third-party runtime dependencies

Security-sensitive decisions should follow [SECURITY.md](SECURITY.md).
