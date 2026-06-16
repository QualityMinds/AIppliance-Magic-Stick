# flux-bootstrap

This Ansible role installs the Flux CLI and performs the cluster bootstrap.

## What the role does

1. **Install Flux CLI** — runs the official install script if `/usr/local/bin/flux` is not already present.
2. **Wait for K3s API** — first waits for port `6443` on `127.0.0.1` (max `120s`), then waits for both the API readiness endpoint (`/readyz`) and API discovery (`/apis`) with retry logic (default: `24` retries with `5s` delay each, so up to ~2 minutes per check). Together the two API checks can take up to ~4 minutes; including the port wait the maximum combined wait time is ~6 minutes.
3. **Bootstrap Flux** — supports two modes:
   - `github`: runs `flux bootstrap github` against a CLI-owned seed path, then applies the deployment-owned `magicstick-sync.yaml`.
   - `readonly-public`: runs `flux install`, creates a public Git source for this repository, applies cluster-local settings, and reconciles the public profile without writing to Git.

## Variables

| Variable | Required for auto-bootstrap | Description |
|---|:---:|---|
| `flux_bootstrap_mode` | No | `github` or `readonly-public`; default: `readonly-public` |
| `magicstick_public_repo` | Yes | Public template Git URL, loaded from `MAGICSTICK_PUBLIC_REPO` |
| `magicstick_public_ref` | Yes | Public template ref, loaded from `MAGICSTICK_PUBLIC_REF` |
| `magicstick_public_ref_kind` | No | `branch`, `tag`, `semver`, or `commit`; default: `branch` |
| `flux_public_sync_path` | `readonly-public` | Public profile path, default: `magic-cluster/flux/entrypoints/single-node` |
| `flux_cluster_path` | `github` | Path in the private deployment repository, e.g. `deployments/CHANGEME_DEPLOYMENT/infra-cluster/flux-bootstrap` |
| `flux_github_owner` | `github` | GitHub owner (organization or user) |
| `flux_github_repo` | `github` | Repository name (without owner prefix) |
| `flux_github_branch` | `github` | Target branch for the bootstrap |
| `ai_appliance_private_checkout` | `github` | Private deployment checkout path, loaded from `AI_APPLIANCE_PRIVATE_CHECKOUT` |
| `flux_github_token` | `github` | GitHub Personal Access Token (PAT) with repo write access for `flux bootstrap github` |
| `flux_bootstrap_seed_path` | No | CLI-owned bootstrap path for `github` mode |
| `flux_custom_sync_manifest_path` | No | AI Appliance sync manifest path in the private checkout for `github` mode |
| `ai_appliance_*` | `readonly-public` | Runtime domain and storage settings rendered into `ConfigMap/ai-appliance-settings` |
| `flux_reconcile_timeout` | No | Timeout for follow-up Flux reconciles (default: `5m0s`) |
| `flux_kubectl_binary` | No | Binary for the API readiness check (default: `/usr/local/bin/k3s`) |
| `flux_kubectl_subcommand` | No | Subcommand for the API readiness check (default: `kubectl`) |
| `flux_kubeconfig_path` | No | Kubeconfig path for readiness check and bootstrap (default: `/etc/rancher/k3s/k3s.yaml`) |
| `flux_k8s_ready_delay_seconds` | No | Delay between readiness retries in seconds (default: `5`) |
| `flux_k8s_ready_retries` | No | Number of readiness retries (default: `24`) |

These values are loaded centrally from `/etc/default/ai-appliance-repo` when
present. In `readonly-public` mode Flux reads only the public Magicstick
repository and does not require a GitHub token or private deployment source.

## Installation security note

The install script is downloaded via HTTPS from `fluxcd.io`. For production environments with stricter security requirements, it is recommended to download a versioned binary directly from the FluxCD GitHub Releases and verify the sha256 checksum:

```bash
# Example (adjust version):
FLUX_VERSION=2.5.1
ARCH=linux_amd64
curl -sL \
  "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_${ARCH}.tar.gz" \
  | tar xz -C /tmp flux
mv /tmp/flux /usr/local/bin/flux
```

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

After a successful bootstrap, Flux takes over continuous reconciliation of the cluster with the private deployment repository.

## Manual public read-only bootstrap

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
. /etc/default/ai-appliance-repo

flux install

sudo k3s kubectl --kubeconfig "$KUBECONFIG" -n flux-system create configmap ai-appliance-settings \
  --from-literal=AI_APPLIANCE_DOMAIN="${AI_APPLIANCE_DOMAIN:-example.local}" \
  --dry-run=client -o yaml | sudo k3s kubectl --kubeconfig "$KUBECONFIG" apply -f-
```

The role performs the full read-only flow automatically, including all
`AI_APPLIANCE_*` settings and Flux reconciles.
