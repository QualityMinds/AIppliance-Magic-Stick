---
search:
  exclude: true
---

# v0.1.0 Early Access acceptance record

Recorded on **24 September 2026** for the first versioned Magic Stick release.
This is a dated evidence record, not a hardware certification or current setup
guide. The [version tag](https://github.com/QualityMinds/AIppliance-Magic-Stick/tree/v0.1.0)
identifies the exact release source; the
[changelog](../../../CHANGELOG.md) contains the curated scope and limitations.

## Owner-reported appliance acceptance

The project owner confirmed that the proposed end-to-end smoke test was already
completed successfully and requested the remaining release steps. The confirmed
scope was:

1. Sign in to the dashboard.
2. Start a model.
3. Make an inference API request.
4. View the model's logs.
5. Stop the model.

The owner had separately confirmed a successful online installation; see the
[installation report](installer-installation-2026-09-24.md). The release work did
not rerun these operations or change a running appliance. No independent logs,
exact engine/model matrix, hardware inventory or running image identities were
supplied with this confirmation. It must not be generalized to every supported
configuration or labeled an automation-run test.

## Reused installer

The release points to the already published
[main-channel online installer](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89):

| Field | Evidence |
|---|---|
| Platform | Ubuntu 26.04.1, AMD64, online package installation |
| Build source | `7adea7a81f5a5cea1cd75a056eadc96d7a867ffa` |
| Input fingerprint | `ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89` |
| Image size | 1,722,220,544 bytes (about 1.60 GiB) |
| Image SHA-256 | `b03edf5aa58600fa740d66a0c85efb6488058b8e9adc20c10a57ccd047f37636` |

The release preparation recomputed the same input fingerprint and verified the
published image's GitHub-provided asset digest against its checksum/build
metadata. The existing asset is reused without rebuilding, renaming or replacing
it. The original CI manifest's `installationTested: false` is retained: it records
what that build job tested, not the later owner's report.

The source tag is immutable, but the installer follows the **current `main`** at
first boot. It is not a frozen offline appliance for v0.1.0. Development-channel
use remains an explicit opt-in; creating `develop` does not switch installations.

## Scope of technical evidence

The release preparation checks source/date/archive consistency, documentation,
secret scanning, installer reuse and the existing runtime descriptors. Existing
Dashboard Web/API/CLI image indexes were reachable for Linux AMD64 and ARM64;
the promoted FreeToken image index was reachable for Linux AMD64. This verifies
artifact identities and availability, not GPU execution or new image promotion.

The exact source revision must also pass the repository's Public release checks
before the draft-release workflow can succeed. The browser smoke uses real
Chromium with synthetic API fixtures; the license audit records source and
artifact findings without inventing manual approval. CI outcomes and evidence
for the exact commit are linked from the
[GitHub release](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v0.1.0),
not predeclared as successful in this preparation record.

The broader [release checklist](../release-checklist.md) remains relevant for
hardware-specific deployments, identity recovery/expiry, multi-appliance Mesh,
Realtime audio and artifact/legal reviews. The narrow owner-confirmed smoke test
does not close those separate items in `licenses/release-review.json`.
