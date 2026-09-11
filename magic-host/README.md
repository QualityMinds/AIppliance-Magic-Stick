# magic-host

Reusable Ansible host automation for the AI Appliance.

The `host-updates` role configures Ubuntu unattended security updates with a
03:00–05:00 UTC default window and no automatic reboot. Saved per-host settings
are preserved; administrators manage them under **System → Updates**. See
[Ubuntu updates](../docs/ubuntu-updates.md) for package exclusions, maintenance
locking, optional restarts and recovery.

The host-management role also installs bounded Ethernet/Wi-Fi trial and recovery
services using Ubuntu's existing Netplan backend. See
[network management](../docs/network-management.md); installation enables the
helpers but does not apply a different network configuration.

The playbook is intentionally generic. By default, deployments use the reusable local inventory in this repository and provide deployment-specific bootstrap values through `/etc/default/ai-appliance-repo`.

See [../docs/architecture.md](../docs/architecture.md) for the bootstrap flow,
[../docs/configuration.md](../docs/configuration.md) for host metadata, and
[../docs/operations.md](../docs/operations.md) for runtime checks.
End-user installation steps are collected in
[../docs/installation/README.md](../docs/installation/README.md).

## GPU compatibility diagnostics

Live memory counters use a separate `magicstick-memory-sample.timer` (30 seconds).
It publishes Linux `MemAvailable` and per-PCI AMD VRAM/GTT usage, without engine
probes or hardware changes. Samples expire after 90 seconds in the dashboard;
Kubelet working-set estimates are not used for unified-memory free readings.

The `gpu-compatibility` role installs read-only `magicstick-gpu-preflight` and
`magicstick-hip-smoke` helpers. It does not automatically change kernel,
firmware, ROCm, memory mapping limits, or GPU eligibility. A separate explicit
preparation playbook accepts reviewed, exact package versions; it never reboots
the host. A root-owned timer publishes non-secret host evidence on the local K3s
Node after boot and every five minutes, without changing eligibility labels.
For Strix Halo, matching KFD heap evidence distinguishes firmware-reserved GPU
allocations from dynamic Linux RAM. The reported model capacity never sums
both; missing evidence stays unknown. This does not protect dynamic RAM from
other processes or change firmware settings.
See [GPU compatibility](../docs/gpu-compatibility.md) for evidence,
Strix Halo shared-memory accounting, preparation and optional manual engine tests.

## Entry Point

The `host-management` role installs the shared post-install hardware/power worker
after base convergence. It only inspects until an administrator submits a
confirmed request. Hardware preparation reuses `gpu-prepare.yml`; GPU-specific
kernel changes are not embedded in the installation path. New USB installations
use Ubuntu 26.04.1 with its native Generic kernel, independently of GPU preparation. This does
not migrate existing hosts or approve GPU-specific package changes. See
[host management](../docs/host-management.md) for exact profiles, mixed-GPU
experiment mode, state across reboot, power controls and diagnostic commands.
The same worker supports explicitly confirmed Strix Halo firmware-reservation
and dynamic-memory sliders. It verifies real post-boot RAM before applying the
TTM setting through Ansible and never changes memory just from inspection.

End users with an existing dedicated Ubuntu 26.04 or 24.04 system should start with the
repository-level [`install-from-linux.sh`](../install-from-linux.sh). It checks
that the host is new, writes `/etc/default/ai-appliance-repo`, creates the
first-run marker, and then calls the converge runner documented below. It does
not duplicate the Ansible roles.

Fresh installations use the overridable `k3s_version` role default
`v1.36.4+k3s1`, including containerd 2.x and its native NVIDIA runtime drop-in
imports. Existing K3s binaries are left untouched; updating an older cluster
and checking custom containerd templates is a separate migration step before
adopting NVIDIA Operator 26.7.

Install the versioned collection dependencies when using a minimal
`ansible-core` environment. The Ubuntu `ansible` package already includes the
community collections, but running this command is safe and keeps development
and CI reproducible:

```bash
ansible-galaxy collection install -r magic-host/requirements.yml
```

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

`magic-host/playbooks/local.yml` reads `/etc/default/ai-appliance-repo` when
present and maps these values into Ansible variables. The default
`readonly-public` installer writes only the public Flux source and
appliance-wide runtime settings; GitHub/private values are optional and only used
when `FLUX_BOOTSTRAP_MODE=github`.

| Environment value | Ansible variable |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `flux_bootstrap_mode` |
| `FLUX_PUBLIC_SYNC_PATH` | `flux_public_sync_path` |
| `MAGICSTICK_PUBLIC_REPO` | public template Git URL used by the converge runner |
| `MAGICSTICK_PUBLIC_REF` | public template tag or commit used by the converge runner |
| `MAGICSTICK_PUBLIC_REF_KIND` | public template ref field, e.g. `branch` |
| `AI_APPLIANCE_DOMAIN` | public read-only domain setting |
| `AI_APPLIANCE_DASHBOARD_HOST` | dashboard ingress hostname |
| `AI_APPLIANCE_MDNS_DOMAIN` | local mDNS domain, e.g. `magicstick.local` |
| `AI_APPLIANCE_MDNS_NAME` | local mDNS annotation suffix, e.g. `magicstick` |
| `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | legacy dashboard mDNS name |
| `AI_APPLIANCE_ENVOY_CRDS_POLICY` | Envoy Gateway Helm CRD policy; defaults to `CreateReplace` for appliance-owned clusters |

Optional overrides and GitHub bootstrap values:

| Environment value | Ansible variable |
|---|---|
| `MAGICSTICK_PUBLIC_CHECKOUT` | public template checkout path |
| `ANSIBLE_INVENTORY_PATH` | `ansible_inventory_path` |
| `ANSIBLE_PLAYBOOK_PATH` | `ansible_playbook_path` |
| `GIT_HOST` | `git_host` |
| `GIT_OWNER` | `flux_github_owner` |
| `GIT_REPO` | `flux_github_repo` |
| `GIT_BRANCH` | `flux_github_branch` |
| `FLUX_CLUSTER_PATH` | `flux_cluster_path` |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | external deployment checkout path |
| `FLUX_GITHUB_TOKEN` | `flux_github_token` |

## Converge Runner

The `ansible-pull-timer` role installs `/usr/local/sbin/ai-appliance-converge`. The runner:

- updates the pinned public template checkout
- updates the external deployment checkout in `github` mode
- runs the public playbook with the configured inventory, defaulting to the public local inventory
- uses `FLUX_GITHUB_TOKEN` through a temporary `GIT_ASKPASS` helper when a token is present

In `readonly-public` mode the runner skips the external deployment checkout and
Flux reads only the public Magicstick repository.

```bash
/usr/local/sbin/ai-appliance-converge
```

`FLUX_GITHUB_TOKEN` is a secret. Provide it at runtime or through an approved secret management mechanism. Do not commit it.

## First-Run Setup

The `first-run-setup` role distinguishes installer-created machines from
upgrades, initializes `ApplianceSetup/local`, and installs the local console
command:

```bash
sudo magicstick setup show
sudo magicstick setup reissue
```

The installer marker creates `Pending`; an existing host without that marker
is initialized as `CompletedLegacy`. This fail-closed rule prevents a repository
upgrade from exposing the setup route on an already running appliance.

On a new installation, `magicstick-setup-console.service` waits for
`cloud-final.service`, switches the physical display to virtual console 9, and
maintains a concise appliance page without touching the installation log on
virtual console 1. Its centered, color-coded panel shows the configured mDNS
name, one primary private LAN address, the prominent claim, the TLS fingerprint,
and the next steps while filtering loopback, CNI, bridge, and virtual Ethernet
addresses. The page refreshes after claim reissue and completion; `setup show`
remains a non-clearing shell command.

After the first-run claim is completed, the setup cleanup hands virtual console
9 to `magicstick-dashboard-console.service`. The `dashboard-console` role runs
the packaged Node.js client from an isolated CLI runtime Deployment with no
Service or ingress and attaches its interactive TUI to the physical monitor. On first
use it shows a Keycloak device-flow URL and one-time code; the operator
authorizes the console from another browser. No password or static administrator
credential is installed. The resulting refresh token is private state in
`/var/lib/magicstick/dashboard-console`, mounted only into the console runtime.
Use `Ctrl+Alt+F1` for the system console and `Ctrl+Alt+F9` for Magic Stick.

Before the first-run console is shown, the `kubernetes-oidc` role waits for the
Flux-managed identity CA, installs only its public certificate on the host,
restarts K3s with the Keycloak issuer/client/group claim contract, and publishes
non-secret readiness metadata for the dashboard's **Kubernetes Access** tab.
This stage never writes a human token, password, client secret, or private CA
key. The readiness metadata uses the current private host IP for the Kubernetes
API endpoint while retaining the mDNS-based Keycloak issuer. This avoids
OpenLens proxy failures caused by clients that do not use the macOS mDNS
resolver. See [../docs/authentication.md](../docs/authentication.md) for the
access levels and kubeconfig flow.
