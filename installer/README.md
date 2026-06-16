# installer

Reusable Ubuntu autoinstall and cloud-init files for the AI Appliance template.

These files intentionally contain placeholders only. Copy them into a deployment directory before creating installation media.

## Files

| File | Purpose |
|---|---|
| `meta-data` | Example cloud-init instance metadata |
| `user-data` | Autoinstall config and first converge runner command |

## Required Deployment Values

Set these in a deployment-specific copy such as `deployments/<name>/installer/user-data`:

| Variable | Description |
|---|---|
| `REPLACE_WITH_GIT_OWNER` | GitHub owner or organization, for example `example-org` |
| `REPLACE_WITH_GIT_REPO` | Repository name |
| `REPLACE_WITH_GIT_BRANCH` | Private deployment branch for host converge and Flux |
| `FLUX_BOOTSTRAP_MODE` | `github` for private Git bootstrap or `readonly-public` for public-only Flux sync |
| `MAGICSTICK_PUBLIC_REPO` | Public template repository to fetch at bootstrap |
| `MAGICSTICK_PUBLIC_REF` | Public template branch, tag, semver, or commit |
| `MAGICSTICK_PUBLIC_REF_KIND` | Ref kind for Flux, usually `branch` |
| `MAGICSTICK_PUBLIC_CHECKOUT` | Local checkout path for public template code |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | Local checkout path for private deployment code |
| `deployments/CHANGEME_DEPLOYMENT/infra-cluster/flux-bootstrap` | Replace with the real deployment Flux path |
| `FLUX_PUBLIC_SYNC_PATH` | Public profile path for `readonly-public`, e.g. `infra-cluster/profiles/single-node/flux-bootstrap` |
| `infra-host/inventory/localhost.yml` | Reusable local host inventory from the public template |
| `AI_APPLIANCE_*` | Domain, dashboard, mDNS, and storage settings for public read-only bootstrap |
| `REPLACE_WITH_FLUX_GITHUB_TOKEN` | Runtime-only token value; do not commit a real token |

## Creating Installation Media

The preferred path is to build a bootable installer image with a separate
editable FAT32 partition labelled `CIDATA`. The Ubuntu installer boots from the
Ubuntu Server ISO content, and cloud-init reads `user-data` and `meta-data` from
the root of the `CIDATA` partition.

```bash
installer/build-installer-image.sh \
  --deployment-name QM-Worker1 \
  --hostname ai-box-01 \
  --git-owner QualityMinds-Vibecoding \
  --git-repo QM-Worker1 \
  --git-branch main \
  --flux-cluster-path deployments/QM-Worker1/infra-cluster/flux-bootstrap \
  --output dist/magicstick-installer.img
```

When `--flux-bootstrap-mode github` is used, the script reads
`FLUX_GITHUB_TOKEN` or prompts for the token without echo. The generated image
and USB stick are sensitive because the rendered `CIDATA/user-data` can contain
that token.

Write the generated image to a USB stick:

```bash
installer/write-usb.sh --list-devices
installer/write-usb.sh --image dist/magicstick-installer.img --device /dev/diskN
```

On Windows, use the PowerShell wrappers:

```powershell
.\installer\build-installer-image.ps1 `
  -DeploymentName QM-Worker1 `
  -Hostname ai-box-01 `
  -GitOwner QualityMinds-Vibecoding `
  -GitRepo QM-Worker1 `
  -GitBranch main `
  -FluxClusterPath deployments/QM-Worker1/infra-cluster/flux-bootstrap `
  -Output dist\magicstick-installer.img

.\installer\write-usb.ps1 -ListDevices
.\installer\write-usb.ps1 -Image .\dist\magicstick-installer.img -DiskNumber 3
```

The image builder uses Docker or Podman to run the ISO tooling. It downloads
Ubuntu Server 24.04.4 LTS AMD64, verifies the pinned SHA256 checksum, patches
the Ubuntu boot configuration with `autoinstall ds=nocloud`, and appends the
editable FAT32 `CIDATA` partition.

For manual debugging, `user-data` and `meta-data` can still be copied to any
mounted FAT or ISO9660 filesystem labelled `CIDATA`:

```bash
sudo cp deployments/<name>/installer/user-data /mnt/user-data
sudo cp deployments/<name>/installer/meta-data /mnt/meta-data
sync
```

The public template uses `example-host-01` as a safe hostname. Real hostnames belong in `deployments/<name>/installer/meta-data`; the default K3s node name follows the installed hostname.
