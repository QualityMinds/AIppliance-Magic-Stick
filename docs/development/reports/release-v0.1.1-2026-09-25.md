---
search:
  exclude: true
---

# v0.1.1 Early Access patch evidence

Recorded on **25 September 2026** for the build-reliability patch after v0.1.0.
This is a dated evidence snapshot, not a GPU certification or operating guide.
The [version tag](https://github.com/QualityMinds/AIppliance-Magic-Stick/tree/v0.1.1)
identifies the final release source; the [changelog](../../../CHANGELOG.md)
defines the public scope.

## Changes and verified development builds

The patch contains `9697ad317c12428ca0fa30d79df4ba7e9bf855bc` (Windows line
endings, early real ROCm imports and post-test registry caching) and
`070e8c833a354fdbcbd199d60ea8680d432df3ea` (image inventory without a duplicate
Docker archive). Both were first publicly distributed on 24 September 2026.
The pinned upstream runtime versions and appliance runtime catalog are unchanged.

| Evidence | Verified result |
|---|---|
| [Companion run 36031460641](https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/36031460641) | Windows x64, Linux x64, macOS x64 and macOS ARM64 builds passed at `9697ad3`; permanent client publication was intentionally skipped on `develop` |
| [ROCm run 36044508854](https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/36044508854) | Contracts and native Linux AMD64 build passed at `070e8c8`, including real imports, offline one-/two-device stage projection, inventory and publication |
| [Public release checks 36044508851](https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/36044508851) | Successful checks for the exact development source `070e8c8` |

The final release commit must separately pass Public release checks on `main`
before the draft workflow can succeed. Final release CI links belong on the
[GitHub release](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v0.1.1),
not as predeclared success in this preparation record.

## ROCm development candidate identity

The successful build published:

```text
ghcr.io/qualityminds/magicstick-omni-rocm@sha256:ede9e0e3b66ff903d8cf085ecc41a9c8859c6eb25c6a97a2d3917a016b7ee0cd
```

Its `omni-rocm-evidence-070e8c833a354fdbcbd199d60ea8680d432df3ea` CI artifact
contains the runtime reference, tested image identity, stage contracts and SBOMs.
The inventory record identifies Linux AMD64 image
`sha256:bc2c3229d5a466dc5e2228816b14fda19fc729b54b3766b21242140eacc5fdca`
and source `070e8c833a354fdbcbd199d60ea8680d432df3ea`. Its Syft JSON SHA-256 is
`0da7121b13c0e8e9cf804f3ecd9069afe9abe02580a68ce8aeec67a174d83554`.

Inventory completed for 2,188 packages: 323 copyleft-review, 398
expression-review, 1,202 missing-license-evidence and 265 notice-review findings.
These are advisory inventory findings, not publication approval. The evidence
was downloaded during release preparation for retention outside CI's expiry
window; full audit archives are not attached as public release assets.

The candidate is **not promoted into the default runtime catalog** by this patch.
Passing imports and offline contracts does not prove GPU allocation, live
inference, audio streaming, throughput or compatibility with every AMD GPU.

## Unchanged installer and operational boundary

The existing [online installer](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89)
is reused unchanged. Its identity and owner-reported installation acceptance
remain in the [v0.1.0 record](release-v0.1.0-2026-09-24.md). It bootstraps current
`main`, rather than a frozen offline appliance.

No appliance rollout, GPU reconfiguration or new physical-hardware acceptance
test was performed as part of this release preparation. Existing appliances
continue following their configured channel. The [release checklist](../release-checklist.md)
and [license audit](../license-audit.md) retain their separate acceptance and
advisory-review scopes.
