# magic-installer

Reusable Ubuntu autoinstall and cloud-init files for the AI Appliance template.

These files intentionally contain placeholders only. Copy them into a deployment directory before creating installation media.

See [../docs/getting-started.md](../docs/getting-started.md) for the
end-to-end installer workflow and [../docs/configuration.md](../docs/configuration.md)
for the variables written into `/etc/default/ai-appliance-repo`.

## Files

| File | Purpose |
|---|---|
| `meta-data` | Example cloud-init instance metadata |
| `user-data` | Autoinstall config and first converge runner command |

## Deployment Values

The default installer uses `readonly-public` mode and reads only the public
Magic-Stick repository. Private GitHub deployment values are only required when
`FLUX_BOOTSTRAP_MODE=github`.

Default `readonly-public` metadata:

| Variable | Description |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `readonly-public` by default; use `github` only for private Git bootstrap |
| `MAGICSTICK_PUBLIC_REPO` | Public template repository to fetch at bootstrap |
| `MAGICSTICK_PUBLIC_REF` | Public template branch, tag, semver, or commit |
| `MAGICSTICK_PUBLIC_REF_KIND` | Ref kind for Flux, usually `branch` |
| `FLUX_PUBLIC_SYNC_PATH` | Public profile path for `readonly-public`, e.g. `magic-cluster/flux/entrypoints/single-node` |
| `AI_APPLIANCE_DOMAIN`, `AI_APPLIANCE_DASHBOARD_HOST`, `AI_APPLIANCE_MDNS_DOMAIN`, `AI_APPLIANCE_MDNS_NAME`, `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | Appliance-wide runtime settings for public read-only bootstrap |

Module storage is configured later through Dashboard advanced options or
`ModuleActivation.spec.parameters`, not through installer media.

Optional advanced overrides:

| Variable | Description |
|---|---|
| `MAGICSTICK_PUBLIC_CHECKOUT` | Local checkout path for public template code; defaults to `/opt/ai-appliance/magicstick` |
| `ANSIBLE_INVENTORY_PATH` | Inventory path for the converge runner; defaults to `magic-host/inventory/localhost.yml` |
| `ANSIBLE_PLAYBOOK_PATH` | Playbook path for the converge runner; defaults to `magic-host/playbooks/local.yml` |

Private GitHub bootstrap metadata:

| Variable | Description |
|---|---|
| `GIT_HOST` | Git host for private bootstrap; defaults to `github.com` |
| `GIT_OWNER`, `GIT_REPO`, `GIT_BRANCH` | Required only for `github` bootstrap mode |
| `FLUX_CLUSTER_PATH` | Required only for `github` bootstrap mode |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | Private checkout path; defaults to `/opt/ai-appliance/deployment` |
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

For private GitHub bootstrap, opt in explicitly:

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
