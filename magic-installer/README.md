# magic-installer

Reusable Ubuntu autoinstall and cloud-init files for the AI Appliance template.

These files intentionally contain placeholders only. Copy them into a deployment directory before creating installation media.

See [../docs/installation/README.md](../docs/installation/README.md) for the
user-oriented installation paths,
[../docs/getting-started.md](../docs/getting-started.md) for developer-oriented
validation, and [../docs/configuration.md](../docs/configuration.md) for the
variables written into `/etc/default/ai-appliance-repo`.

Use this directory for a new Ubuntu 26.04 bare-metal or cloud-init machine. If Ubuntu 26.04 or 24.04
already runs on a dedicated host, use
[`../install-from-linux.sh`](../install-from-linux.sh). If Kubernetes already
exists, use [`../deploy-on-k8s.sh`](../deploy-on-k8s.sh) or
[`../deploy-on-k8s.ps1`](../deploy-on-k8s.ps1); those paths do not install K3s
or host services.

## Files

GPU-specific host preparation runs **after** base installation, using the same
administrator-confirmed workflow as existing appliances. The installer provides
the local worker, not a second kernel-upgrade path. See
[host management](../docs/host-management.md). The installation kernel must still
boot the machine and reach its network/storage. Kubernetes-only deployments do
not install the root worker and therefore do not expose working host power controls.

| File | Purpose |
|---|---|
| `meta-data` | Example cloud-init instance metadata |
| `user-data` | Autoinstall config and first converge runner command |

## Deployment Values

The default installer uses `readonly-public` mode and reads only the public
Magic-Stick repository. GitHub deployment values are only required when
`FLUX_BOOTSTRAP_MODE=github`.

Repository access first uses Git's negotiated HTTPS transport. If that attempt
fails, bootstrap and later converge runs retry once with HTTP/1.1. Public
bootstrap disables terminal credential prompts, so a transport failure cannot
leave cloud-init waiting for a username or password.

Default `readonly-public` metadata:

| Variable | Description |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `readonly-public` by default; use `github` only for optional Git bootstrap |
| `MAGICSTICK_PUBLIC_REPO` | Public template repository to fetch at bootstrap |
| `MAGICSTICK_PUBLIC_REF` | Public template branch, tag, semver, or commit |
| `MAGICSTICK_PUBLIC_REF_KIND` | Ref kind for Flux, usually `branch` |
| `FLUX_PUBLIC_SYNC_PATH` | Public profile path for `readonly-public`, e.g. `magic-cluster/flux/entrypoints/single-node` |
| `AI_APPLIANCE_DOMAIN`, `AI_APPLIANCE_DASHBOARD_HOST`, `AI_APPLIANCE_MDNS_DOMAIN`, `AI_APPLIANCE_MDNS_NAME`, `AI_APPLIANCE_DASHBOARD_MDNS_NAME`, `AI_APPLIANCE_ENVOY_CRDS_POLICY` | Appliance-wide runtime settings for public read-only bootstrap |

Module storage is configured later through Dashboard advanced options or
`ModuleActivation.spec.parameters`, not through installer media.

Optional advanced overrides:

| Variable | Description |
|---|---|
| `MAGICSTICK_PUBLIC_CHECKOUT` | Local checkout path for public template code; defaults to `/opt/ai-appliance/magicstick` |
| `ANSIBLE_INVENTORY_PATH` | Inventory path for the converge runner; defaults to `magic-host/inventory/localhost.yml` |
| `ANSIBLE_PLAYBOOK_PATH` | Playbook path for the converge runner; defaults to `magic-host/playbooks/local.yml` |

Optional GitHub bootstrap metadata:

| Variable | Description |
|---|---|
| `GIT_HOST` | Git host for optional bootstrap; defaults to `github.com` |
| `GIT_OWNER`, `GIT_REPO`, `GIT_BRANCH` | Required only for `github` bootstrap mode |
| `FLUX_CLUSTER_PATH` | Required only for `github` bootstrap mode |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | External checkout path; defaults to `/opt/ai-appliance/deployment` |
| `FLUX_GITHUB_TOKEN` | Required only for `github` bootstrap mode; do not commit a real token |

## Creating Installation Media

The preferred path is to build a bootable installer image with a separate
editable FAT32 partition labelled `CIDATA`. The Ubuntu installer boots from the
Ubuntu Server ISO content, and cloud-init reads `user-data` and `meta-data` from
the root of the `CIDATA` partition.

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 \
  --output dist/magicstick-installer.img
```

This default uses `--flux-bootstrap-mode readonly-public`, the public
`QualityMinds/AIppliance-Magic-Stick` repository, and
`magic-cluster/flux/entrypoints/single-node`.

For optional GitHub bootstrap, opt in explicitly:

```bash
magic-installer/build-installer-image.sh \
  --flux-bootstrap-mode github \
  --deployment-name example-deployment \
  --hostname example-host-01 \
  --git-owner example-org \
  --git-repo example-deployment \
  --git-branch main \
  --flux-cluster-path deployments/example-deployment/infra-cluster/flux-bootstrap \
  --output dist/magicstick-installer-private.img
```

In `github` mode, the script reads `FLUX_GITHUB_TOKEN` or prompts for the token
without echo. Images and USB sticks made in `github` mode are sensitive because
the rendered `CIDATA/user-data` can contain that token.

Write the generated image to a USB stick:

```bash
magic-installer/write-usb.sh --list-devices
magic-installer/write-usb.sh --image dist/magicstick-installer.img --device /dev/diskN
```

On Windows, use the PowerShell wrappers:

```powershell
.\magic-installer\build-installer-image.ps1 `
  -Hostname example-host-01 `
  -Output dist\magicstick-installer.img

.\magic-installer\write-usb.ps1 -ListDevices
.\magic-installer\write-usb.ps1 -Image .\dist\magicstick-installer.img -DiskNumber 3
```

The image builder uses Docker or Podman to run the ISO tooling. It downloads
Ubuntu Server 26.04.1 LTS AMD64, verifies the pinned SHA256 checksum, patches
the Ubuntu boot configuration with `autoinstall ds=nocloud`, and appends the
editable FAT32 `CIDATA` partition.

### Automatic online image builds

The [installer CI workflow](../.github/workflows/build-installer-image.yml) uses
`online` mode only. Relevant installer changes on `main` or `develop` produce
separate test/prerelease downloads; unchanged build inputs reuse an existing
image. Product version changes alone do not trigger a rebuild. See
[automatic installer images](../docs/development/installer-images.md) for download
assets, checksums, retention, input fingerprints and recovery from failed uploads.
Local builds below keep their explicit `full`, `reduced` and `online` choices.

### Experimental reduced offline pool

The normal build remains `--offline-pool full`. Two experimental variants reduce
the package archive and require a working online Ubuntu mirror:

| Mode | Offline package archives | Default output |
|---|---|---|
| `full` | All original packages | `dist/magicstick-installer.img` |
| `reduced` | Keep `main`, remove `restricted` | `dist/magicstick-installer-reduced.img` |
| `online` | Remove the entire `/pool` | `dist/magicstick-installer-online.img` |

To remove **all offline package archives**:

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 \
  --offline-pool online \
  --output dist/magicstick-installer-online.img
```

Use `--offline-pool reduced` to retain the main package pool. PowerShell accepts
the same modes as `-OfflinePool online` or `-OfflinePool reduced`. Existing images,
checksums and report directories are never overwritten. Choose another output
name for a new build.
The checksum-verified original ISO is shared in `.installer-cache` and is never
modified. Each build uses a separate temporary workspace; transformed ISO or
SquashFS files are not reused from the download cache.

The `reduced` variant is deliberately component-scoped:

- Keep **all of `pool/main`**, including the original kernel, bootloader, SSH and
  dependency packages. This avoids guessing which individual libraries can go.
- Remove **only `pool/restricted`**, the additional third-party driver package
  archive on the currently pinned Server ISO. This does not uninstall anything
  from the live or target systems and does not remove firmware or kernel drivers.
- Keep the original signed `dists` metadata byte-for-byte. The only logical
  change inside the base SquashFS is `Components: main` in
  `/etc/apt/sources.list.d/cdrom.sources`. The now-inactive restricted index is
  retained so the original repository signature remains valid. No active local
  index refers to the removed package files. Online mirror components, keys and
  signature verification are unchanged; no signing key or trust exemption is added.
- Preserve the codec and block size when repacking that filesystem. Verify its
  file contents, ownership, modes, timestamps, links, devices and extended
  attributes; reject changes outside that single source file. Other SquashFS
  layers, `vmlinuz`, `initrd` and the target package selection stay unchanged.

The `online` variant removes **all 186 package archives** on the pinned ISO,
including the kernel, bootloader and driver **archives**, not the running kernel,
installed software, firmware or installer files. It keeps the original signed
repository metadata inactive and sets `Enabled: no` in the existing
`cdrom.sources`. The file must remain present: Subiquity 26.04 would recreate an
enabled local source if it were deleted. All packages that need downloading
during installation then come from the chosen mirror, using current available
versions rather than pinning old ISO archive versions. Packages already supplied
by the installed-system SquashFS are not unnecessarily downloaded again.

Both modified variants verify the original local repository signature and package
hashes, preserve filesystem metadata, and require `apt.fallback: abort` in the
template. They neither disable signature checks nor allow an offline fallback.
The `reduced` variant additionally checks retained-package dependencies and
refuses a template that explicitly requests a removed package or enables
third-party/OEM driver installation, interactive driver/package selection or an
offline APT fallback. Use `full` for those cases. These checks cover the supplied
template, not subsequent manual changes to `CIDATA` on the stick. The `online`
variant deliberately relies on the mirror's package resolver instead of an
offline dependency closure; unavailable or explicitly pinned old versions can
still prevent installation.

**A working Ubuntu mirror and Internet access are required.** Older optional
driver versions included on an ISO can disappear from the normal Ubuntu archive;
neither smaller image promises that those exact versions can be re-downloaded.
Magic Stick's post-install GPU/operator provisioning is not changed. This is not
a smaller Ubuntu edition, a minimal-system switch or an offline installation mode.

Every completed build writes:

- `<image>.sha256`: checksum of the complete USB image, including CIDATA/padding.
- `<image>.report/size-report.json`: logical image size in bytes/MiB/GiB, strict
  `< 2 GiB` comparison, source ISO hash, selection policy and filesystem checks.
- `<image>.report/pool-before.json` and `pool-after.json`: files and package
  name/version/architecture/path/size/hash inventory, including `/pool`, `/dists`,
  `/casper` and other payload sizes. These are package archives, not installed sizes.

The ISO's `md5sum.txt` is refreshed for boot configuration changes, the reduced or
removed pool and the one repacked filesystem. Upstream exclusions for generated boot data
are preserved. A successful build and checksum verification are **not** a complete
VM or hardware installation acceptance. See the
[dated experiment report](../docs/development/reports/installer-offline-pool-2026-09-24.md)
for measured results and remaining checks.

### Kernel selection

New images select the standard **Try or Install Ubuntu Server** entry. Ubuntu
26.04 already supplies a modern native kernel; a separate HWE entry is neither
required nor selected. The builder identifies the entry by `/casper/vmlinuz`,
requires its kernel/initrd and patches `autoinstall ds=nocloud` into native and
any optional HWE entries, including loopback configurations.

The target uses `autoinstall.kernel.flavor: generic`, following the Ubuntu
26.04 native kernel track. The live kernel comes from the checksum-pinned ISO;
it is not updated merely by rebuilding the same ISO. The ISO URL and checksum
must be updated together, using [Ubuntu's published checksums](https://releases.ubuntu.com/26.04.1/SHA256SUMS).

This is a **fresh-install migration**, not an in-place upgrade of existing
appliances. Existing Ubuntu 24.04 hosts retain their separate host-preparation
profile. Strix Halo remains experimental; a newer kernel alone does not certify
all GPU drivers, operators or inference engines. See
[GPU compatibility](../docs/gpu-compatibility.md) and
[Subiquity kernel selection](https://github.com/canonical/subiquity/blob/main/doc/reference/autoinstall-reference.rst#kernel).

An existing USB stick does not receive boot-menu changes through Git/Flux.
Rebuild the builder container and installer image (do not use `--no-build` for
this migration), then write the stick again; back up private `CIDATA` settings
first. The builder container remains Debian-based: it only runs ISO tools and
does not determine the installed OS.

The media contains installer configuration, not a snapshot of every local
Ansible/Flux change. First boot fetches `MAGICSTICK_PUBLIC_REPO` at
`MAGICSTICK_PUBLIC_REF`; publish the matching host/operator changes to that ref
before installing. New host installs pin K3s to `v1.36.4+k3s1`; existing clusters
are not automatically upgraded. NVIDIA 26.7 needs the compatible containerd 2.x
runtime/drop-in setup, and its R595 driver does not support pre-Turing GPUs.

### Network configuration

The network screen remains interactive. During installation, a supported Wi-Fi
adapter can therefore be selected and its SSID and passphrase entered locally;
wired DHCP continues to work as before. The template deliberately contains no
wireless credentials. Subiquity applies the selected Netplan configuration
during installation and carries it into the installed system. The passphrase is
therefore stored only on that system, where Netplan files must remain readable
only by root. If the Ubuntu installer does not detect a wireless adapter, use a
supported adapter or Ethernet for installation and configure the device later.

### APT mirror selection

The **Ubuntu archive mirror configuration** screen is interactive (`apt` in
`interactive-sections`). Subiquity suggests a country mirror using Ubuntu's
GeoIP service. Accept it or enter a different official Ubuntu mirror URL;
Subiquity checks mirror usability. Country selection is an approximation, not a
latency benchmark or a promise of the fastest server.

Candidates are `country-mirror`, then the Ubuntu main archive for AMD64 (or
Ubuntu Ports for other architectures). If no candidate works, fix the network
or URL and retry: `fallback: abort` avoids silently attempting an incomplete
offline installation. The selected archive is carried into the installed
system; APT package-signature verification and security updates remain enabled.
This does not change the separate ISO download source or container registries.

To avoid the request to `https://geoip.ubuntu.com/lookup`, edit your private
`CIDATA/user-data`: set `autoinstall.apt.geoip: false` and replace
`country-mirror` with the desired mirror's `uri`. Leave `apt` interactive to
allow a last-minute change. Never place mirror credentials in the public
template. See [Subiquity APT configuration](https://github.com/canonical/subiquity/blob/main/doc/reference/autoinstall-reference.rst#apt)
and the [official Ubuntu mirror list](https://launchpad.net/ubuntu/+archivemirrors).

For manual debugging, `user-data` and `meta-data` can still be copied to any
mounted FAT or ISO9660 filesystem labelled `CIDATA`:

```bash
sudo cp deployments/<name>/installer/user-data /mnt/user-data
sudo cp deployments/<name>/installer/meta-data /mnt/meta-data
sync
```

The public template uses `example-host-01` as a safe hostname. Real hostnames belong in `deployments/<name>/installer/meta-data`; the default K3s node name follows the installed hostname.

At first boot, cloud-init writes a one-time new-install marker before the first
converge. Host automation consumes that marker to generate the root-only setup
claim and `Pending` state. The generated human password is never placed on the
installer media or in Kubernetes. After cloud-init completes, the physical
display switches from the boot-log console to a dedicated virtual console with
a centered, color-coded setup page containing only the usable local access
paths, TLS fingerprint, prominent claim code, and immediate next steps.
Continue with
[../docs/first-run-setup.md](../docs/first-run-setup.md).
