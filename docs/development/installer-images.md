# Automatic reduced installer images

The [installer workflow](../../.github/workflows/build-installer-image.yml) builds
the **reduced AMD64 USB image**. It retains Ubuntu's signed `main` package pool,
including the packages Subiquity needs to configure Wi-Fi, and removes only the
large `restricted` package archive. Additional packages come from the selected
Ubuntu mirror. The live kernel, firmware, Subiquity and installed-system
filesystem layers remain present. Network access during installation is required.
See the [installer options and limitations](../../magic-installer/README.md#reduced-offline-pool).

These are **test/prerelease downloads**, not a declaration that a complete
installation or GPU setup passed. The workflow does not create a versioned
product release, promote container images, write a USB drive or roll out an appliance.
The separate [VM acceptance workflow](installer-vm-acceptance.md) can boot a
published candidate, install it onto a blank virtual disk and verify first-run
readiness. Its result is separate from the image build and from physical
USB/Wi-Fi/GPU acceptance.

The project owner confirmed a successful installation of the earlier online-only
candidate on 24 September
2026. The [dated installation result](reports/installer-installation-2026-09-24.md)
records that confirmation separately from the original CI evidence. The later
network-screen finding showed that candidate could not bootstrap Wi-Fi support.
The reduced installer is now the standard USB path; physical Wi-Fi acceptance of
each new candidate remains separate from CI. Successful manual tests do not rewrite
published build manifests or imply compatibility with every GPU.

For installation, use the [prebuilt image in the USB guide](../installation/bare-metal.md).
The build scripts are developer tools. Users do not need to clone this repository
or install Docker to prepare the standard USB installer.

## Local development builds

Use a local build only when changing or testing the installer, comparing media
modes or preparing a custom deployment. Install Git and Docker or Podman, clone
the repository, and run from its root:

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 --offline-pool reduced \
  --output dist/magicstick-installer-reduced.img
```

On Windows, the equivalent developer wrapper is:

```powershell
.\magic-installer\build-installer-image.ps1 `
  -Hostname example-host-01 -OfflinePool reduced `
  -Output dist\magicstick-installer-reduced.img
```

Choose a new output filename for each rebuild. The wrappers preserve existing
images. `reduced` is the default and matches the standard published media;
`full` remains an explicit compatibility option. Private/custom images must not be
uploaded as public downloads. For advanced metadata, optional command-line USB
writers and the media layout, see the [developer tool reference](../../magic-installer/README.md).

## Build once for each installer recipe

A push to `main` or `develop` starts the workflow only when an installer input or
its focused tests change. Manual runs are also allowed on these two branches.
Before building, the workflow computes a SHA-256 fingerprint from:

- the build scripts, media helper, Containerfile, optional Docker ignore file,
  `user-data` and `meta-data` templates;
- the pinned Ubuntu ISO URL and checksum;
- the workflow, artifact helper and public CI build configuration;
- the source license terms (`LICENSE` and `LICENSING.md`);
- the selected channel (`main` or `develop`).

The source commit and product version are **not** cache keys. Dashboard, model,
host-automation, documentation, changelog or release-date changes alone do not
rebuild the installer. The first boot fetches the selected channel's current
source, rather than embedding all Magic Stick components into the image.

If a complete, matching download already exists, CI verifies its manifest,
checksums, sizes and original source tag, then reports the existing download URL.
It does not rebuild or upload a duplicate. A manual run follows the same rule.
A changed input produces a new fingerprint and a separate download.

The fingerprint describes the **recipe**, not byte-for-byte reproducibility:
image timestamps and build-tool packages may differ between builds. For an
intentional toolchain refresh without another recipe change, increment
`recipeRevision` in [ci-build.json](../../magic-installer/ci-build.json).
Update the pinned ISO URL/checksum to adopt a new Ubuntu installation baseline.
The source-ISO cache is only a download optimization; its contents are always
checksum-verified, and eviction cannot make CI lose a published image.

## Downloads and channels

New candidates are stored as GitHub prerelease assets under
`installer-<channel>-<full-input-fingerprint>`. They are not marked as the latest
product release. The workflow summary links to the download containing:

| Asset | Purpose |
|---|---|
| `*.img` | Bootable USB image |
| `*.img.sha256` | Image checksum, usable with `sha256sum -c` or `shasum -a 256 -c` |
| `*.build.json` | Original source commit/run, input fingerprints and asset checksums |
| `*.evidence.tar.gz` | Media checks, package inventories and source license notices |

GitHub's generated source archives are not installer images. Each attached file
must stay below [GitHub's 2 GiB release-asset limit](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas).
The pipeline rejects larger files rather than silently splitting them.

Published assets do not use Actions' temporary artifact retention. The 14-day
Actions artifact is only the handoff between build and publication jobs. Original
tags, image bytes, source revision and notices are preserved when reused. Product
release notes can link an existing installer without rebuilding or relabeling it.
The user-facing USB guide pins a verified `main` candidate. After publishing a
new baseline, verify its download and checksums, then deliberately update that
guide's image/checksum/evidence links together. Documentation-only changes do not
rebuild the image. Do not use GitHub's generic “latest release” URL: product and
installer releases have different lifecycles, and installer candidates are prereleases.

`main` media follows `main`; `develop` media follows `develop`. Public CI fixes the
hostname to `example-host-01`, uses public example domains and `readonly-public`,
and embeds no GitHub token, user password or SSH access. Inspect/edit CIDATA for
the target computer as described in the [installer guide](../../magic-installer/README.md).
CI does not offer private-bootstrap inputs.

## Verification and recovery

The build job has read-only repository access. It checks the focused installer
tests, source-license consistency, advisory license review and public source
secret scan before building. Open approval records remain visible; the review
does not invent legal clearance or block publication solely on missing approvals.
Afterward it verifies image checksums, removal of the restricted package pool,
retention of the signed main package pool,
protected kernel/firmware/installer files, BIOS/UEFI boot entries and the actual
public CIDATA configuration. It packages reports and original source notices.
These integrity checks are not a boot test or a completed installation.

A separate publication job can write releases, but does not build media. It
verifies the exact successful build run, downloaded asset bytes and remote
upload checksums. It uploads to a draft first and publishes the prerelease only
after all four assets match. There is no overwrite or mutable `latest.img` alias.
Normal source/license checks do not claim legal or physical acceptance.

- A GitHub authentication, network or rate-limit failure stops the lookup; it
  must not cause a duplicate build.
- An incomplete draft or existing tag without a complete release stops a fresh
  run. **Rerun only the original failed publication job** while its 14-day Actions
  artifact is available. Rebuilding would produce different image bytes.
- If original artifacts have expired, recover the original bytes and evidence
  through a reviewed maintenance procedure, or deliberately bump the recipe
  revision to create a new candidate. Do not move the old tag or overwrite assets.
- After changing workflow or helper inputs, run
  `python tools/license_audit.py --refresh-references` if the dependency-reference
  check reports stale evidence; this refresh does not approve distribution reviews.

After publishing the workflow source, the first relevant push or an authorized
manual run builds/publishes a candidate. Repository rules must permit Actions to
create the installer tags and releases. Local tests alone do not prove that a
GitHub-hosted run or publication has succeeded. Keep the installation/first-boot
and GPU checks from the [release checklist](release-checklist.md) separate.
