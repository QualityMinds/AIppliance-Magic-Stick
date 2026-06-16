# flux-bootstrap

This Ansible role installs the Flux CLI and performs the cluster bootstrap.

## What the role does

1. **Install Flux CLI** — runs the official install script if `/usr/local/bin/flux` is not already present.
2. **Wait for K3s API** — first waits for port `6443` on `127.0.0.1` (max `120s`), then waits for both the API readiness endpoint (`/readyz`) and API discovery (`/apis`) with retry logic (default: `24` retries with `5s` delay each, so up to ~2 minutes per check). Together the two API checks can take up to ~4 minutes; including the port wait the maximum combined wait time is ~6 minutes.
3. **Run Flux bootstrap** — bootstraps Flux into the cluster using a CLI-owned seed path so Flux can install and become healthy without depending on the public template include.
4. **Apply AI Appliance sync** — applies the private deployment's `magicstick-sync.yaml`, then reconciles the public source, private source with include, and primary Flux kustomization.

## Variables

| Variable | Required for auto-bootstrap | Description |
|---|:---:|---|
| `flux_cluster_path` | Yes | Path in the private deployment repository, e.g. `deployments/CHANGEME_DEPLOYMENT/infra-cluster/flux-bootstrap` |
| `flux_github_owner` | Yes | GitHub owner (organization or user) |
| `flux_github_repo` | Yes | Repository name (without owner prefix) |
| `flux_github_branch` | Yes | Target branch for the bootstrap |
| `magicstick_public_repo` | Yes | Public template Git URL, loaded from `MAGICSTICK_PUBLIC_REPO` |
| `magicstick_public_ref` | Yes | Public template tag or commit, loaded from `MAGICSTICK_PUBLIC_REF` |
| `ai_appliance_private_checkout` | Yes | Private deployment checkout path, loaded from `AI_APPLIANCE_PRIVATE_CHECKOUT` |
| `flux_github_token` | Yes | GitHub Personal Access Token (PAT) with `repo` scope |
| `flux_bootstrap_seed_path` | No | CLI-owned bootstrap path (default: `{{ flux_cluster_path }}/bootstrap-seed`) |
| `flux_custom_sync_manifest_path` | No | AI Appliance sync manifest path in the private checkout |
| `flux_reconcile_timeout` | No | Timeout for follow-up Flux reconciles (default: `5m0s`) |
| `flux_kubectl_binary` | No | Binary for the API readiness check (default: `/usr/local/bin/k3s`) |
| `flux_kubectl_subcommand` | No | Subcommand for the API readiness check (default: `kubectl`) |
| `flux_kubeconfig_path` | No | Kubeconfig path for readiness check and bootstrap (default: `/etc/rancher/k3s/k3s.yaml`) |
| `flux_k8s_ready_delay_seconds` | No | Delay between readiness retries in seconds (default: `5`) |
| `flux_k8s_ready_retries` | No | Number of readiness retries (default: `24`) |

`flux_cluster_path`, `flux_github_owner`, `flux_github_repo`,
`flux_github_branch`, `magicstick_public_repo`, `magicstick_public_ref`, and
`ai_appliance_private_checkout` are loaded centrally from
`/etc/default/ai-appliance-repo` (created by cloud-init). `flux_github_token` is
a secret and must be set at runtime (e.g. via Ansible Vault or environment
variable).

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

## Manual bootstrap

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
