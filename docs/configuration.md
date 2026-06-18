# Configuration

Configuration flows from installer inputs to host metadata, then into Flux
post-build variables and private overlays.

## Host Metadata

The installer writes `/etc/default/ai-appliance-repo`. The Ansible playbook
reads that file and maps environment-style keys into Ansible variables.

Common keys:

| Key | Purpose |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `readonly-public` or `github`. |
| `MAGICSTICK_PUBLIC_REPO` | Public Magic Stick repository URL. |
| `MAGICSTICK_PUBLIC_REF` | Public ref used by the converge runner and Flux source. |
| `MAGICSTICK_PUBLIC_REF_KIND` | `branch`, `tag`, `semver`, or `commit`. |
| `MAGICSTICK_PUBLIC_CHECKOUT` | Local checkout path for the public template. |
| `FLUX_PUBLIC_SYNC_PATH` | Public profile path used by `readonly-public` mode. |
| `ANSIBLE_INVENTORY_PATH` | Inventory path passed to the converge runner. |
| `ANSIBLE_PLAYBOOK_PATH` | Playbook path passed to the converge runner. |
| `GIT_HOST` | Git host for private bootstrap mode. Defaults to `github.com`. |
| `GIT_OWNER` | Private deployment repository owner for `github` mode. |
| `GIT_REPO` | Private deployment repository name for `github` mode. |
| `GIT_BRANCH` | Private deployment branch for `github` mode. |
| `FLUX_CLUSTER_PATH` | Private Flux bootstrap path for `github` mode. |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | Private deployment checkout path for `github` mode. |
| `FLUX_GITHUB_TOKEN` | Runtime token for private GitHub bootstrap. Do not commit it. |

## Runtime Settings

In `readonly-public` mode, Ansible renders `ConfigMap/ai-appliance-settings` in
namespace `flux-system`. Flux Kustomizations use it through
`postBuild.substituteFrom`.

| Setting | Default | Used by |
|---|---|---|
| `AI_APPLIANCE_DOMAIN` | `example.local` | App and observability hostnames. |
| `AI_APPLIANCE_DASHBOARD_HOST` | `dashboard.example.local` | Dashboard ingress hostname. |
| `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | `ai-appliance` | Dashboard mDNS annotation. |
| `AI_APPLIANCE_ANYTHING_LLM_STORAGE` | `1Gi` | AnythingLLM PVC. |
| `AI_APPLIANCE_QDRANT_STORAGE` | `1Gi` | Qdrant PVC. |
| `AI_APPLIANCE_LITELLM_POSTGRES_STORAGE` | `1Gi` | LiteLLM PostgreSQL PVC. |
| `AI_APPLIANCE_LOKI_STORAGE` | `1Gi` | Loki PVC. |
| `AI_APPLIANCE_ALERTMANAGER_STORAGE` | `1Gi` | Alertmanager PVC. |
| `AI_APPLIANCE_PROMETHEUS_STORAGE` | `1Gi` | Prometheus PVC. |

Private deployments can supply the same values through their own
`ConfigMap/ai-appliance-settings`, Flux `postBuild` variables, or Kustomize
patches.

## AI App Settings

| Setting | Default | Purpose |
|---|---|---|
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | `qwen3635b` | Preferred default chat model for the generated model catalog. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | `qwen352bvlembedding` | Preferred default embedding model for the generated model catalog. |
| `AI_APPLIANCE_HERMES_MODEL` | `qwen3635b` | Preferred Hermes default model if present in the catalog. |
| `AI_APPLIANCE_HERMES_STORAGE` | `10Gi` | Hermes data PVC. |
| `AI_APPLIANCE_OPENCLAW_MODEL` | `qwen3635b` | Preferred OpenClaw primary model if present in the catalog. |
| `AI_APPLIANCE_OPENCLAW_STORAGE` | `10Gi` | OpenClaw data PVC. |
| `AI_APPLIANCE_PAPERCLIP_STORAGE` | `5Gi` | Paperclip app data PVC. |
| `AI_APPLIANCE_PAPERCLIP_POSTGRES_STORAGE` | `10Gi` | Operator-managed Paperclip PostgreSQL PVC. |
| `AI_APPLIANCE_PAPERCLIP_ADMIN_EMAIL` | `admin@example.com` | Email used by the in-cluster Paperclip admin bootstrap job. |
| `AI_APPLIANCE_PAPERCLIP_ADMIN_NAME` | `Admin` | Display name used by the in-cluster Paperclip admin bootstrap job. |

Generated model catalog values such as `AI_APPLIANCE_MODEL_CATALOG_READY`,
`AI_APPLIANCE_MODEL_CATALOG_HASH`, and model counts are outputs, not user
inputs. See [model-catalog.md](model-catalog.md).

## Installer Build Variables

The shell and PowerShell wrappers pass `MAGICSTICK_*` environment variables to
the installer build container. Most users should prefer wrapper CLI flags over
setting these variables directly.

Common build-only variables:

| Variable | Purpose |
|---|---|
| `MAGICSTICK_HOSTNAME` | Hostname written to cloud-init metadata. |
| `MAGICSTICK_DEPLOYMENT_NAME` | Name used to derive private Flux paths. |
| `MAGICSTICK_FLUX_BOOTSTRAP_MODE` | Installer bootstrap mode. |
| `MAGICSTICK_FLUX_PUBLIC_SYNC_PATH` | Public profile path for read-only installs. |
| `MAGICSTICK_FLUX_GITHUB_TOKEN` | Token passed into private installer image generation. |
| `MAGICSTICK_UBUNTU_ISO_URL` | Ubuntu Server ISO URL. |
| `MAGICSTICK_UBUNTU_ISO_SHA256` | Expected ISO checksum. |
| `MAGICSTICK_CACHE_DIR` | Local build cache path inside the builder. |
| `MAGICSTICK_CIDATA_SIZE` | Size of the editable `CIDATA` partition. |

## Secrets

Public manifests may reference Secrets or request generated Secrets, but they
must not contain real secret data.

Allowed public patterns:

- generated-secret annotations such as `secret-generator.v1.mittwald.de/*`
- `valueFrom.secretKeyRef` references
- safe placeholder values like `CHANGEME`
- empty public examples

Disallowed public patterns:

- real Personal Access Tokens
- kubeconfigs
- private keys
- real API keys
- real admin passwords
- provider credentials embedded in `ConfigMap/ai-external-models`

Use Kubernetes Secrets from private overlays, runtime bootstrap, or an approved
external secret management flow.
