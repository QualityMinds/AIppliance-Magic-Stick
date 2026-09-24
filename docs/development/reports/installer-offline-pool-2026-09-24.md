# Installer offline-pool experiments · 2026-09-24

This is a local experiment, not a released installer or complete installation
acceptance. The normal build remains `full`. See the
[current installer options](../../../magic-installer/README.md#experimental-reduced-offline-pool).

## Measured complete images

| Measurement | Full baseline | Reduced: keep main | Online: no pool |
|---|---:|---:|---:|
| Complete USB image, bytes | 2,994,339,840 | 2,019,033,088 | 1,722,220,544 |
| Complete USB image, GiB | 2.788696 | 1.880371 | 1.603943 |
| Complete USB image, MiB | 2,855.625 | 1,925.500 | 1,642.438 |
| Offline package pool, MiB | 1,212.47 | 282.42 | 0 |
| Packages in offline pool | 186 | 149 | 0 |
| Single file strictly below 2 GiB | No | Yes | Yes |

The **complete-image saving is 975,306,752 bytes / 930.125 MiB / 32.57%**.
The reduced image is 128,450,560 bytes / 122.5 MiB below 2,147,483,648 bytes.
Removing the entire pool saves **1,272,119,296 bytes / 1,213.188 MiB / 42.48%**
against the baseline, or another **283.063 MiB** against the reduced image.
The online image has 405.563 MiB of headroom below 2 GiB.
These are logical file sizes, including boot data, the 64 MiB CIDATA partition
and padding, not estimates or `du` allocated-block sizes.

## Inputs and reproduction

- Starting repository revision: `40082989d8b12d2240c3c5227004c3bfdc245fba`, with the
  local reduced-pool implementation described here. No source push or publication.
- ISO: `ubuntu-26.04.1-live-server-amd64.iso`, unchanged repository default.
- Original ISO SHA256: `cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927`.
- Full image SHA256: `8b44d3f89e35b96807ec9449553f29a241c29c3c952e723b61f0ab3387163941`.
- Reduced image SHA256: `7cb1d54c8f83f4758b5f91b3c2c984a5fce04fb384befa0059efa87eacec242b`.
- Online image SHA256: `6beb958e232045fc51f75a30478b5c2c074173f71423a828514bed08a8c0f5d8`.
- Public, token-free `readonly-public` configuration; hostname `example-host-01`.
- Local Linux ARM64 builder through Rancher Desktop on macOS. The output remains
  an AMD64 Ubuntu installer; no target executable is run while repacking.

From the repository root, with Docker or Podman available:

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 --offline-pool full \
  --output dist/installer-pool-experiment/baseline.img

magic-installer/build-installer-image.sh \
  --hostname example-host-01 --offline-pool reduced \
  --output dist/installer-pool-experiment/reduced.img

magic-installer/build-installer-image.sh \
  --hostname example-host-01 --offline-pool online \
  --output dist/installer-pool-experiment/online.img
```

The actual run used the local builder tag `magicstick-installer-builder:pool-experiment`
and `--no-build` after building that tag from the same `Containerfile`.
Rebuilding requires new output filenames or explicitly archiving the old outputs;
the scripts do not overwrite them. FAT identifiers and timestamps can change
between builds, so the hashes above identify these particular artifacts.

## Inventory and selection rule

Original payload sizes, excluding filesystem layout/padding:

| Area | Bytes |
|---|---:|
| `/pool` | 1,271,371,026 |
| `/dists` | 311,672 |
| `/casper` | 1,635,634,351 |
| Other files | 12,459,286 |

The JSON inventories also break down every file under `/casper`, and every pool
package by name, version, architecture, path, bytes and SHA256. They describe
**package archives**, not packages removed from an installed system.

In `reduced` mode, all 149 `main` packages remain, including exact ISO kernel, bootloader and SSH
packages and their accompanying dependencies. The 37 `restricted` package
archives are removed as one component. Representative largest removed files:

| Package | ISO version | Bytes |
|---|---|---:|
| `libnvidia-gl-580-server` | `580.173.02-0ubuntu0.26.04.1` | 172,445,972 |
| `libnvidia-gl-595-server` | `595.71.05-0ubuntu0.26.04.1` | 138,532,210 |
| `linux-objects-nvidia-580-server-7.0.0-30-generic` | `7.0.0-30.30` | 97,920,880 |
| `linux-objects-nvidia-595-server-7.0.0-30-generic` | `7.0.0-30.30` | 92,758,304 |
| `libnvidia-compute-595-server` | `595.71.05-0ubuntu0.26.04.1` | 85,757,586 |

The selection is **not** based only on package names. The builder validates the
signed pool indices and package bytes, checks retained dependencies and installed
filesystem manifests, and rejects an installer configuration that needs the
removed component. The existing Magic Stick template does not request automatic
third-party/OEM driver installation. Online operator/host provisioning is unchanged.

No kernel, firmware, installed package, SquashFS layer, target-source selection,
installation dialog, host bootstrap, Kubernetes or application configuration is removed.

### Follow-up: remove the entire offline pool

The `online` variant removes `/pool` altogether, including all 186 `.deb`
archives. It sets `Enabled: no` in the existing `cdrom.sources`, keeping all
remote sources and the installed-system files unchanged. The signed local
metadata remains on the medium but is completely inactive. APT must resolve
additional packages against the selected online mirror. Packages already in the
SquashFS system are not removed or downloaded again solely for this experiment.

This includes obtaining any required kernel/bootloader packages online. The
existing `kernel.flavor: generic` setting is unchanged. During the check, both
full and online media resolved `linux-generic` to `7.0.0-34.34`; the experiment
does not introduce a new kernel track or force the ISO's older package versions.
Without a working mirror, installation must fail rather than fall back offline.

## Repository trust and media integrity

The base filesystem includes a Deb822 `cdrom.sources` with an embedded ISO-specific
public signing key. The original ISO checksum anchors that key; `gpgv` verified
the original `Release.gpg`. The original Release and both component indices remain
byte-identical. The only filesystem edit changes the local source from
`Components: main restricted` to `Components: main` for `reduced`, or adds
`Enabled: no` for `online`. Thus no active local index refers to removed packages.

The Ubuntu 26.04 installer recognizes this existing `cdrom.sources`, instead of
replacing it with a synthetic source. This was checked in the ISO's actual
`subiquity_7403.snap` (`server/apt.py`) and is also described by
[Subiquity's APT implementation](https://github.com/canonical/subiquity/blob/main/subiquity/server/apt.py).
Disabling a Deb822 source with `Enabled: no` is supported by
[APT's source format](https://manpages.debian.org/trixie/apt/sources.list.5.en.html#DEB822-STYLE_FORMAT).
Online sources still include `restricted`. No new signing key, global trusted
source, `trusted=yes`, or unauthenticated-package exception is used.

The repacked base uses the original XZ codec and 128 KiB block size. Comparison of
**79,985 filesystem entries** found only the intended source-file change, including
checks of file hashes, ownership, modes, timestamps, links, devices and xattrs.
The other layers, live kernel/initrd, EFI files and signed indices are unchanged.
The ISO `md5sum.txt` is updated, retaining upstream exclusions for regenerated
boot data; the complete USB image receives a separate SHA256.

## Checks performed

- All three variants actually built from the same original ISO and public configuration.
- 645 integrity entries passed in the online image, 794 in the reduced image,
  and 831 in the baseline. No `/pool` directory remains in the online image.
- 27 protected files were byte-identical in each smaller image, including the
  kernel/initrd, unmodified layers, EFI payloads and repository metadata.
- BIOS and UEFI boot entries plus the appended CIDATA partition are present.
- `user-data` and `meta-data` hashes match across all three built images.
- Isolated APT updates accepted the original local signature and signed Ubuntu
  archive metadata with the reduced local component selection.
- The package plans for `git`, `ansible`, `curl`, `ca-certificates`,
  `wpasupplicant` and optional `openssh-server` were identical for full/reduced
  configurations. All 27 required remote package URLs returned their expected
  content lengths. This is a resolver/download-availability check, not package installation.
- For `online`, separate BIOS and UEFI plans also included `linux-generic`,
  `grub-pc` or `grub-efi-amd64-signed` plus `shim-signed`. All 55 distinct
  required package downloads actually completed with APT's normal verification.
  The disabled local source pointed to a nonexistent directory, proving there
  was no local-package fallback. Resolved package names and versions match the
  full-media plans; ordering and available-source annotations differ as expected.
- One old optional ISO driver archive returned HTTP 404. Its exact version is
  not assumed downloadable; current archives offer newer versions. The reduced
  mode rejects requests that rely on the removed offline driver component.
- Shell syntax passed. The combined installer/documentation/website suite ran
  72 tests, with 70 passing and two PowerShell checks skipped because PowerShell
  was not available locally. The strict static documentation build passed.
- The reduced preparation and complete filesystem comparison also passed as UID
  1000 in a non-privileged container, using `fakeroot` for filesystem metadata.
- Both actual smaller USB images booted through BIOS in isolated AMD64 QEMU VMs
  using software emulation and reached Subiquity's language-selection screen.
  In the online VM, the installer service was active and the running live
  system's `cdrom.sources` still contained `Enabled: no`. The test VMs were
  stopped afterwards; no disk installation or physical USB write was performed.

## Remaining acceptance and artifacts

**Installation checked: partially.** The complete disk installation, first boot,
Magic Stick bootstrap, physical hardware support and Secure Boot execution are
not certified by the build, package solver or installer-start checks. In
particular, actual UEFI execution is distinct from verifying its boot entry.
Use a disposable VM disk or dedicated test machine for that final acceptance.

All generated media and raw evidence are Git-ignored under
`dist/installer-pool-experiment/`: `baseline.img`, `reduced.img`, `online.img`, their
`.sha256` and `.report/` sidecars, `apt-verification.json`,
`apt-online-verification.json`, APT logs and VM captures. The
images contain no private deployment values. They have not been published or
written to a physical USB drive.

Implementation lives in the two build wrappers, the existing container builder,
`magic-installer/scripts/installer-media.py`, the builder `Containerfile`, and
`tests/test_installer_pool.py`. The existing release-check workflow runs the new
unit suite; no image publication, release or rollout automation is added here.

The experiment stops at reducing or removing offline package archives. Installed
filesystem payload is deliberately not optimized further.
