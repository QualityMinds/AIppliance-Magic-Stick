# installer

Reusable Ubuntu autoinstall and cloud-init files for the AI Appliance template.

These files intentionally contain placeholders only. Copy them into a deployment directory before creating installation media.

## Files

| File | Purpose |
|---|---|
| `meta-data` | Example cloud-init instance metadata |
| `user-data` | Autoinstall config and first `ansible-pull` command |

## Required Deployment Values

Set these in a deployment-specific copy such as `deployments/<name>/installer/user-data`:

| Variable | Description |
|---|---|
| `REPLACE_WITH_GIT_OWNER` | GitHub owner or organization, for example `example-org` |
| `REPLACE_WITH_GIT_REPO` | Repository name |
| `REPLACE_WITH_GIT_BRANCH` | Branch for `ansible-pull` and Flux |
| `deployments/CHANGEME_DEPLOYMENT/infra-cluster/flux-bootstrap` | Replace with the real deployment Flux path |
| `deployments/CHANGEME_DEPLOYMENT/infra-host/inventory/localhost.yml` | Replace with the real deployment inventory |
| `REPLACE_WITH_FLUX_GITHUB_TOKEN` | Runtime-only token value; do not commit a real token |

## Creating Installation Media

Place `user-data` and `meta-data` on the `CIDATA` partition of the USB stick:

```bash
sudo cp deployments/<name>/installer/user-data /mnt/user-data
sudo cp deployments/<name>/installer/meta-data /mnt/meta-data
sync
```

The public template uses `example-host-01` as a safe hostname. Real hostnames belong in `deployments/<name>/installer/meta-data` and the deployment inventory.
