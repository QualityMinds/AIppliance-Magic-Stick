# flux-bootstrap

This Ansible role installs the Flux CLI and performs the cluster bootstrap.

## What the role does

1. **Install Flux CLI** — installs the versioned, SHA-256-verified Linux binary when `/usr/local/bin/flux` is absent. The reviewed default is `2.9.5`; existing binaries are retained.
2. **Wait for K3s API** — first waits for port `6443` on `127.0.0.1` (max `120s`), then waits for both the API readiness endpoint (`/readyz`) and API discovery (`/apis`) with retry logic (default: `24` retries with `5s` delay each, so up to ~2 minutes per check). Together the two API checks can take up to ~4 minutes; including the port wait the maximum combined wait time is ~6 minutes.
3. **Bootstrap Flux** — supports two modes:
   - `github`: runs `flux bootstrap github` against a CLI-owned seed path, then applies the deployment-owned `magicstick-sync.yaml`.
   - `readonly-public`: installs controllers when absent, creates a public Git source for this repository, applies cluster-local settings, and reconciles the public profile without writing to Git. Existing controllers are not reinstalled on every convergence run.

## Variables

| Variable | Required for auto-bootstrap | Description |
|---|:---:|---|
| `flux_bootstrap_mode` | No | `github` or `readonly-public`; default: `readonly-public` |
| `magicstick_public_repo` | Yes | Public template Git URL, loaded from `MAGICSTICK_PUBLIC_REPO` |
| `magicstick_public_ref` | Yes | Public template ref, loaded from `MAGICSTICK_PUBLIC_REF` |
| `magicstick_public_ref_kind` | No | `branch`, `tag`, `semver`, or `commit`; default: `branch` |
| `magicstick_public_resolved_commit` | Host runner | Exact commit resolved by the host; takes precedence over ref/kind in public mode. The managed host runner accepts branch/tag/commit, not semver. |
| `flux_cli_version`, `flux_cli_checksums` | No | Reviewed initial CLI version and per-architecture SHA-256 checksums. Change together. |
| `flux_upgrade_controllers` | No | Explicit controller install/upgrade using the installed CLI; default `false`. Not an implicit channel-switch upgrade. |
| `flux_public_sync_path` | `readonly-public` | Public profile path, default: `magic-cluster/flux/entrypoints/single-node` |
| `flux_cluster_path` | `github` | Path in the external deployment repository, e.g. `deployments/<deployment>/infra-cluster/flux-bootstrap` |
| `flux_github_owner` | `github` | GitHub owner (organization or user) |
| `flux_github_repo` | `github` | Repository name (without owner prefix) |
| `flux_github_branch` | `github` | Target branch for the bootstrap |
| `ai_appliance_private_checkout` | `github` | External deployment checkout path, loaded from `AI_APPLIANCE_PRIVATE_CHECKOUT` |
| `flux_github_token` | `github` | GitHub Personal Access Token (PAT) with repo write access for `flux bootstrap github` |
| `flux_bootstrap_seed_path` | No | CLI-owned bootstrap path for `github` mode |
| `flux_custom_sync_manifest_path` | No | AI Appliance sync manifest path in the private checkout for `github` mode |
| `ai_appliance_domain`, `ai_appliance_dashboard_host`, `ai_appliance_mdns_domain`, `ai_appliance_mdns_name`, `ai_appliance_dashboard_mdns_name` | `readonly-public`/`github` | Appliance-wide settings seeded into cluster-local `ConfigMap/ai-appliance-settings` |
| `flux_reconcile_timeout` | No | Timeout for follow-up Flux reconciles (default: `5m0s`) |
| `flux_kubectl_binary` | No | Binary for the API readiness check (default: `/usr/local/bin/k3s`) |
| `flux_kubectl_subcommand` | No | Subcommand for the API readiness check (default: `kubectl`) |
| `flux_kubeconfig_path` | No | Kubeconfig path for readiness check and bootstrap (default: `/etc/rancher/k3s/k3s.yaml`) |
| `flux_k8s_ready_delay_seconds` | No | Delay between readiness retries in seconds (default: `5`) |
| `flux_k8s_ready_retries` | No | Number of readiness retries (default: `24`) |

These values are loaded centrally from `/etc/default/ai-appliance-repo` when
present. In `readonly-public` mode Flux reads only the public Magicstick
repository and does not require a GitHub token or external deployment source.

## Installation security note

New installations download the fixed archive from official Flux GitHub Releases
and verify the checksum before extraction. No moving remote install script is
executed. Existing CLI/controller versions remain unchanged during ordinary
convergence. Upgrade them deliberately after checking compatibility; selecting a
software branch is not authorization for an implicit Flux/K3s version upgrade.

## Manual GitHub bootstrap

If `flux_github_token` was not set during the Ansible run, run the bootstrap manually on the host:

```bash
export GITHUB_TOKEN=<personal-access-token>
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
. /etc/default/ai-appliance-repo

flux bootstrap github \
  --owner="$GIT_OWNER" \
  --repository="$GIT_REPO" \
  --branch="$GIT_BRANCH" \
  --path="${FLUX_CLUSTER_PATH}/bootstrap-seed" \
  --token-auth

sudo k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply \
  -f "${AI_APPLIANCE_PRIVATE_CHECKOUT}/${FLUX_CLUSTER_PATH}/flux-system/magicstick-sync.yaml"
```

After a successful bootstrap, Flux takes over continuous reconciliation of the cluster with the external deployment repository.

## Manual public read-only bootstrap

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
. /etc/default/ai-appliance-repo

flux install

sudo k3s kubectl --kubeconfig "$KUBECONFIG" -n flux-system create configmap ai-appliance-settings \
  --from-literal=AI_APPLIANCE_DOMAIN="${AI_APPLIANCE_DOMAIN:-magicstick.example.com}" \
  --from-literal=AI_APPLIANCE_DASHBOARD_HOST="${AI_APPLIANCE_DASHBOARD_HOST:-${AI_APPLIANCE_DOMAIN:-magicstick.example.com}}" \
  --from-literal=AI_APPLIANCE_MDNS_DOMAIN="${AI_APPLIANCE_MDNS_DOMAIN:-magicstick.local}" \
  --from-literal=AI_APPLIANCE_MDNS_NAME="${AI_APPLIANCE_MDNS_NAME:-magicstick}" \
  --dry-run=client -o yaml | sudo k3s kubectl --kubeconfig "$KUBECONFIG" apply -f-
```

The role performs the full read-only flow automatically, including the
appliance-wide settings ConfigMap and Flux reconciles. Module storage overrides
are handled by `ModuleActivation.spec.parameters`, not this bootstrap role.
