# Configuration

Post-install Ethernet/Wi-Fi configuration is available in **System → Network**.
It uses runtime host operations, not deployment metadata or public Git values.
See [network management](network-management.md) for confirmation and recovery.

Configuration flows from installer inputs to host metadata, Flux post-build
variables, dashboard settings, runtime CRs, and optional external overlays.

## Host Metadata

Kernel choice for **new** installations belongs to
`magic-installer/user-data`: `autoinstall.kernel.flavor` defaults to `generic`
for Ubuntu 26.04.1. It is not runtime metadata and does not upgrade existing
hosts. The native USB boot default is described in
[installer kernel selection](../magic-installer/README.md#kernel-selection).

APT mirrors also belong to installer configuration, not runtime metadata.
`autoinstall.apt` uses GeoIP-based `country-mirror` followed by the main Ubuntu
archive, with `apt` in `interactive-sections` for manual URL selection. Disable
`geoip` in a private CIDATA copy if location lookup is unwanted. See
[APT mirror selection](../magic-installer/README.md#apt-mirror-selection).

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

Optional GitHub bootstrap keys:

| Key | Purpose |
|---|---|
| `GIT_HOST` | Git host for optional GitHub bootstrap mode. Defaults to `github.com`. |
| `GIT_OWNER` | External deployment repository owner for `github` mode. |
| `GIT_REPO` | External deployment repository name for `github` mode. |
| `GIT_BRANCH` | External deployment branch for `github` mode. |
| `FLUX_CLUSTER_PATH` | External Flux bootstrap path for `github` mode. |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | External deployment checkout path for `github` mode. |
| `FLUX_GITHUB_TOKEN` | Runtime token for optional GitHub bootstrap. Do not commit it. |

## One-command installer options

[`install-from-linux.sh`](../install-from-linux.sh) maps its options to the
same host metadata instead of introducing a second configuration model:

| Installer option | Written setting |
|---|---|
| `--repository` | `MAGICSTICK_PUBLIC_REPO` |
| `--ref` | Resolved to a commit and written as `MAGICSTICK_PUBLIC_REF`; kind becomes `commit` |
| `--domain` | `AI_APPLIANCE_DOMAIN` and `AI_APPLIANCE_DASHBOARD_HOST` |
| `--mdns-domain` | `AI_APPLIANCE_MDNS_DOMAIN` plus the derived mDNS names |
| `--install-dir` | `MAGICSTICK_PUBLIC_CHECKOUT` |

[`deploy-on-k8s.sh`](../deploy-on-k8s.sh) and
[`deploy-on-k8s.ps1`](../deploy-on-k8s.ps1) have no host metadata. They create
`ConfigMap/ai-appliance-settings` and the public Flux source directly in the
selected cluster. Their `--ref`/`-Ref`, domain, and mDNS options have the same
meaning as the Linux installer. The default `main` ref is convenient for
development; use a release tag or 40-character commit for controlled
installations.

## GPU compatibility configuration

Host convergence also installs `magicstick-memory-sample.timer`. It publishes
direct Linux/AMD memory counters every 30 seconds, using the configured GPU
evidence node name and `gpu_compatibility_publish_evidence` switch. It opens no
network listener, runs no engine probe, and changes no memory allocation limits.

Additional AMD profiles are runtime module intent, not installer defaults or
appliance-wide domain settings. Administrators configure
`ModuleActivation/amd-gpu.spec.parameters.compatibilityProfile`,
`allowExperimental` and an optional unique `validationRequest` through
**System → Hardware**, CLI/TUI, or the runtime CR. Unknown profiles, arbitrary
probe images and implicit experimental consent are rejected by the API.

`ai-system/magicstick-gpu-compatibility-catalog` provides versioned profile and
fixed test-image/model definitions. The initial `strix-halo` profile remains
experimental; fresh host evidence and GPU registration remain required, while
per-engine validation is optional and manual. Runtime-owned
keys in `flux-system/magicstick-gpu-runtime-images` carry successful image
digests to KubeAI Helm `valuesFrom`; public manifests contain no machine-specific
validation results or image-ID evidence.

The host `gpu-compatibility` role installs read-only diagnostics and a bounded
evidence publisher. `gpu_compatibility_publish_evidence` defaults to true;
`gpu_compatibility_node_name` defaults to the local hostname. It publishes only
the local Node's non-secret `appliance.magicstick.dev/gpu-host-preflight`
annotation, not GPU eligibility labels.

Host preparation is separate and opt-in: `gpu_compatibility_prepare_host`
defaults to false, `gpu_compatibility_package_versions` to an empty mapping,
and `gpu_compatibility_ttm_limit_mib` to null (unchanged). Supply exact reviewed
package versions and a bounded shared-memory limit only when needed. No
automatic kernel/firmware upgrade, KMM enablement or reboot follows generic GPU
detection. See [GPU compatibility](gpu-compatibility.md) for variables,
preparation, rollback and accounting constraints.

## Runtime Settings

Host package preparation and power actions are not ordinary appliance settings.
The shared [post-install host workflow](host-management.md) uses immutable
`HostOperation` requests and root-owned, versioned package profiles. It never
accepts package URLs or shell commands from the dashboard. The installer only
provides this mechanism; it does not approve or run an experimental preparation.

In `readonly-public` mode, Ansible renders appliance-wide settings into
`ConfigMap/ai-appliance-settings` in namespace `flux-system`. Flux
Kustomizations use it through `postBuild.substituteFrom`.

| Setting | Default | Used by |
|---|---|---|
| `AI_APPLIANCE_DOMAIN` | `magicstick.example.com` | Public app and derived instance hostnames. |
| `AI_APPLIANCE_DASHBOARD_HOST` | `magicstick.example.com` | Compatibility key for the public dashboard ingress; the Dashboard API keeps it synchronized with `AI_APPLIANCE_DOMAIN`. |
| `AI_APPLIANCE_MDNS_DOMAIN` | `magicstick.local` | Local mDNS domain used for dashboard, app, and derived instance hostnames. |
| `AI_APPLIANCE_MDNS_NAME` | `magicstick` | Local mDNS name suffix used in mDNS annotations. |
| `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | `magicstick` | Legacy dashboard mDNS name, kept for compatibility. |
| `AI_APPLIANCE_ENVOY_CRDS_POLICY` | `CreateReplace` | Helm CRD policy for the appliance-owned Envoy Gateway installation. Use `Skip` only when an external platform manages the same CRDs. |
| `AI_APPLIANCE_NAME` | `Magicstick` | Human-readable appliance name selected during first-run setup. |
| `AI_APPLIANCE_TIMEZONE` | `UTC` | Appliance timezone selected during first-run setup. |
| `AI_APPLIANCE_LANGUAGE` | `de` | Dashboard/setup language preference. |
| `AI_APPLIANCE_KEYCLOAK_POSTGRES_STORAGE` | `1Gi` | Persistent storage requested by the local identity database. |

AppInstance hostnames are derived from runtime settings and are not arbitrary
per-instance configuration:

```text
<instance-name>.<instance-type>.<domain>
```

## Module Advanced Parameters

Module storage is configured at runtime through Dashboard advanced options or
directly through `ModuleActivation.spec.parameters`. If a parameter is omitted,
the module manifest default such as
`${AI_APPLIANCE_LITELLM_POSTGRES_STORAGE:=1Gi}` is used.

| Module | Parameter | Flux substitution |
|---|---|---|
| `litellm` | `postgresStorage` | `AI_APPLIANCE_LITELLM_POSTGRES_STORAGE` |
| `anything-llm` | `storage` | `AI_APPLIANCE_ANYTHING_LLM_STORAGE` |
| `anything-llm` | `qdrantStorage` | `AI_APPLIANCE_QDRANT_STORAGE` |

## Model Catalog Settings

| Setting | Default | Purpose |
|---|---|---|
| `AI_APPLIANCE_DEFAULT_CHAT_MODEL` | `auto` | Preferred default chat model; `auto` selects the first available chat model. |
| `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` | `auto` | Preferred default embedding model; `auto` selects the first available embedding model. |

`AI_APPLIANCE_DEFAULT_OPENCODE_MODEL` is a generated output in
`litellm/<model-id>` form. It follows the selected default chat model and is not
a separate user input.

Generated model catalog values such as `AI_APPLIANCE_MODEL_CATALOG_READY`,
`AI_APPLIANCE_MODEL_CATALOG_HASH`, and model counts are outputs, not user
inputs. See [model-catalog.md](model-catalog.md).

App-specific storage and preferred model values are runtime `AppInstance`
parameters. Module storage values are runtime `ModuleActivation` parameters.
Local and external model selections are runtime `ModelActivation` resources.

## Installer Build Variables

The shell and PowerShell wrappers pass `MAGICSTICK_*` environment variables to
the installer build container. Most users should prefer wrapper CLI flags over
setting these variables directly.

Common build-only variables:

| Variable | Purpose |
|---|---|
| `MAGICSTICK_HOSTNAME` | Hostname written to cloud-init metadata. |
| `MAGICSTICK_DEPLOYMENT_NAME` | Name used to derive optional external Flux paths. |
| `MAGICSTICK_FLUX_BOOTSTRAP_MODE` | Installer bootstrap mode. |
| `MAGICSTICK_FLUX_PUBLIC_SYNC_PATH` | Public profile path for read-only installs. |
| `MAGICSTICK_FLUX_GITHUB_TOKEN` | Token passed into optional GitHub installer image generation. |
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

Use Kubernetes Secrets from runtime bootstrap, optional external overlays, or an
approved external secret management flow.

New installations do not generate a human administrator Secret. The first-run
claim is stored as a root-only host file, while Kubernetes stores only its
SHA-256 hash. Human and recovery passwords are written directly to Keycloak.

Human Kubernetes access also stores no static credential. Direct membership in
one of the `magicstick-kubernetes-*` Keycloak groups is the authorization
source. The optional
`identity-system/magicstick-kubernetes-access-info` ConfigMap contains only the
public API endpoint, OIDC issuer/client ID, a public CA certificate, and an
`enabled` marker. Downloaded kubeconfigs contain the same public trust material
and an OIDC exec-plugin declaration, never a token, password, private key, or
OAuth client secret.

Appliance K3s publishes its current private host IP as the API endpoint. The
dashboard also upgrades a legacy marker that still names the appliance mDNS
host to the current Ready control-plane `InternalIP` at download time. A
platform-managed endpoint such as a control-plane load balancer or public-safe
DNS name is preserved exactly as published.
