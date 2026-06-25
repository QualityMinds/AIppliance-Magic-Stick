# Configuration

Configuration flows from installer inputs to host metadata, then into Flux
post-build variables and private overlays.

## Host Metadata

The installer writes `/etc/default/ai-appliance-repo`. The Ansible playbook
reads that file and maps environment-style keys into Ansible variables.

Default `readonly-public` metadata:

| Key | Purpose |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `readonly-public` or `github`. |
| `MAGICSTICK_PUBLIC_REPO` | Public Magic Stick repository URL. |
| `MAGICSTICK_PUBLIC_REF` | Public ref used by the converge runner and Flux source. |
| `MAGICSTICK_PUBLIC_REF_KIND` | `branch`, `tag`, `semver`, or `commit`. |
| `FLUX_PUBLIC_SYNC_PATH` | Public profile path used by `readonly-public` mode. |

Optional advanced overrides:

| Key | Purpose |
|---|---|
| `MAGICSTICK_PUBLIC_CHECKOUT` | Local checkout path for the public template. Defaults to `/opt/ai-appliance/magicstick`. |
| `ANSIBLE_INVENTORY_PATH` | Inventory path passed to the converge runner. Defaults to `magic-host/inventory/localhost.yml`. |
| `ANSIBLE_PLAYBOOK_PATH` | Playbook path passed to the converge runner. Defaults to `magic-host/playbooks/local.yml`. |

Private GitHub bootstrap keys:

| Key | Purpose |
|---|---|
| `GIT_HOST` | Git host for private bootstrap mode. Defaults to `github.com`. |
| `GIT_OWNER` | Private deployment repository owner for `github` mode. |
| `GIT_REPO` | Private deployment repository name for `github` mode. |
| `GIT_BRANCH` | Private deployment branch for `github` mode. |
| `FLUX_CLUSTER_PATH` | Private Flux bootstrap path for `github` mode. |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | Private deployment checkout path for `github` mode. |
| `FLUX_GITHUB_TOKEN` | Runtime token for private GitHub bootstrap. Do not commit it. |

## Runtime Settings

In `readonly-public` mode, Ansible renders appliance-wide settings into
`ConfigMap/ai-appliance-settings` in namespace `flux-system`. Flux
Kustomizations use it through `postBuild.substituteFrom`.

| Setting | Default | Used by |
|---|---|---|
| `AI_APPLIANCE_DOMAIN` | `example.local` | App and observability hostnames. |
| `AI_APPLIANCE_DASHBOARD_HOST` | `dashboard.example.local` | Dashboard ingress hostname. |
| `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | `ai-appliance` | Dashboard mDNS annotation. |

## Module Advanced Parameters

Module storage is configured at runtime through Dashboard advanced options or
directly through `ModuleActivation.spec.parameters`. If a parameter is omitted,
the module manifest default such as `${AI_APPLIANCE_LOKI_STORAGE:=1Gi}` is used.

| Module | Parameter | Flux substitution |
|---|---|---|
| `litellm` | `postgresStorage` | `AI_APPLIANCE_LITELLM_POSTGRES_STORAGE` |
| `anything-llm` | `storage` | `AI_APPLIANCE_ANYTHING_LLM_STORAGE` |
| `anything-llm` | `qdrantStorage` | `AI_APPLIANCE_QDRANT_STORAGE` |
| `observability` | `lokiStorage` | `AI_APPLIANCE_LOKI_STORAGE` |
| `observability` | `alertmanagerStorage` | `AI_APPLIANCE_ALERTMANAGER_STORAGE` |
| `observability` | `prometheusStorage` | `AI_APPLIANCE_PROMETHEUS_STORAGE` |

## Model Catalog Settings

| Setting | Default | Purpose |
|---|---|---|
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | `qwen3635b` | Preferred default chat model for the generated model catalog. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | `qwen352bvlembedding` | Preferred default embedding model for the generated model catalog. |

Generated model catalog values such as `AI_APPLIANCE_MODEL_CATALOG_READY`,
`AI_APPLIANCE_MODEL_CATALOG_HASH`, and model counts are outputs, not user
inputs. See [model-catalog.md](model-catalog.md).

App-specific host, storage, and preferred model values are runtime
`AppInstance` parameters. Module storage values are runtime `ModuleActivation`
parameters. Local and external model selections are runtime `ModelActivation`
resources.

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
