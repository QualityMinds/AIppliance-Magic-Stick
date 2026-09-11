# Getting Started

This guide covers local validation and the public read-only installer flow.
For step-by-step end-user installation on physical hardware, cloud VMs,
existing Ubuntu VMs, or existing Kubernetes clusters, start with the
[installation guide](installation/README.md).

## Prerequisites

For local repository work:

- `git`
- `kubectl` with Kustomize support
- `rg`
- `gitleaks` for release scans
- `ansible-playbook` for host playbook syntax checks

For installer image creation:

- Docker or Podman
- enough disk space for the Ubuntu Server ISO and generated installer image
- a target machine that can boot the generated USB image

New USB images use Ubuntu 26.04.1 and its native Generic kernel for live boot
and the target. This does not upgrade existing appliances. See
[installer kernel selection](../magic-installer/README.md#kernel-selection).
Network and APT archive selection remain interactive; the installer suggests a
country mirror and permits a custom URL. See
[APT mirror selection](../magic-installer/README.md#apt-mirror-selection).

For local model serving:

- enough CPU RAM for the selected CPU preset, or a supported NVIDIA, AMD, or
  Intel GPU with its host driver prerequisites
- for NVIDIA, a host compatible with K3s, the NVIDIA GPU Operator, and the
  configured GPU sharing mode; AMD uses ROCm and Intel uses the XPU runtime

External LiteLLM-backed providers and CPU inference do not require GPU hardware
or drivers. AMD and Intel targets appear only after their operator and
allocatable Kubernetes resource are ready.

Strix Halo is an additional **experimental** AMD profile, not part of a blanket
GPU support guarantee. Live memory counters refresh every 30 seconds after host
convergence; unavailable counters remain unknown. Use **System → Hardware** to inspect host evidence,
explicitly acknowledge the profile and optionally request engine validation.
Generic detection never upgrades kernel/firmware or reboots a machine. Some
hosts need a reviewed kernel preparation first; follow
[GPU compatibility](gpu-compatibility.md) before enabling experiments. CPU and
external inference remain available independently.

## Clone And Validate

```bash
git clone https://github.com/QualityMinds/AIppliance-Magic-Stick.git
cd AIppliance-Magic-Stick
```

Render the main public entrypoints:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

Render key cluster bases:

```bash
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/hardware-discovery
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/apps/ai/model-catalog
```

If Ansible is installed, run:

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

## Public Read-Only Installer

The default installer mode uses this public repository directly and does not
need a GitHub token.

For an existing dedicated Ubuntu 26.04 or 24.04 system, the repository-level wrapper
performs the host checks, writes the public metadata, pins the resolved commit,
and starts the same Ansible playbook:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/install-from-linux.sh \
  -o /tmp/install-from-linux.sh
sudo bash /tmp/install-from-linux.sh --preflight-only
sudo bash /tmp/install-from-linux.sh
```

For an existing Kubernetes cluster, use `deploy-on-k8s.sh` or
`deploy-on-k8s.ps1`. Those wrappers install no host services and stop when the
selected context already owns another `flux-system` source or Magic Stick
state. The complete decision tree is in
[installation/README.md](installation/README.md).

To build new bare-metal installation media instead, use:

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 \
  --output dist/magicstick-installer.img
```

Useful public-mode options:

```bash
magic-installer/build-installer-image.sh \
  --hostname example-host-01 \
  --domain magicstick.example.com \
  --dashboard-host magicstick.example.com \
  --mdns-domain magicstick.local \
  --flux-public-sync-path magic-cluster/flux/entrypoints/single-node \
  --output dist/magicstick-installer.img
```

List removable devices, then write the image:

```bash
magic-installer/write-usb.sh --list-devices
magic-installer/write-usb.sh --image dist/magicstick-installer.img --device /dev/diskN
```

On Linux the device will usually look like `/dev/sdX` or `/dev/nvmeXnY`. On
macOS it will look like `/dev/diskN`. Always pass a whole disk, not a
partition.

## After First Boot

After the base system and dashboard are ready, use **System → Hardware → Host
preparation** for any additional reviewed kernel preparation. New and existing
machines share this workflow; installation never implicitly approves a kernel
change or reboot. See [host management](host-management.md) for experiments on
mixed GPUs and administrator power controls.

After cloud-init finishes, the appliance switches the physical display from
the boot-log console to a dedicated, centered first-run appliance page. Its
color-coded sections show only the mDNS name, the primary private LAN address,
the TLS fingerprint, the eight-character claim code, and the next steps;
container and cluster-internal addresses are hidden. Boot logs remain
available on virtual console 1. Open
`https://<private-node-ip>:9443/setup`; this IP path works without mDNS. Compare
the browser certificate fingerprint with the console, enter the one-time claim
code, and create the first administrator. See
[first-run-setup.md](first-run-setup.md) for the complete flow.

After completion, virtual console 9 changes automatically from the claim page
to the operational Magic Stick TUI. Authorize its one-time SSO device code from
a browser; no password is stored on the appliance. Use `Ctrl+Alt+F1` for the
system console and `Ctrl+Alt+F9` for the TUI.

On the host:

```bash
sudo systemctl status k3s
sudo /usr/local/sbin/ai-appliance-converge
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get kustomizations
sudo magicstick setup show
```

From another machine with a kubeconfig:

```bash
kubectl -n flux-system get gitrepositories,kustomizations
kubectl get namespaces
kubectl -n ai-system get appliances
kubectl -n ai get pods
```

Continue with [operations.md](operations.md) for runtime checks.

After the first administrator can sign in, the admin-only **Kubernetes Access**
tab can assign Viewer, Operator, or Cluster Administrator access to an existing
local or brokered Keycloak user. Appliance-owned K3s configures this OIDC path
during host convergence. Install `kubectl oidc-login` on the administrator
workstation before using a downloaded kubeconfig. Appliance kubeconfigs use the
current private host IP for the Kubernetes API so OpenLens does not depend on
mDNS; download the file again after a DHCP address change. Existing or managed
clusters require the platform-specific API-server step in
[installation/existing-kubernetes.md](installation/existing-kubernetes.md).

## Select Optional Capabilities

The installer brings up the base appliance. Optional modules and app instances
are selected after installation through the dashboard or runtime CRs.

Inspect the default resource:

```bash
kubectl -n ai-system get appliance local -o yaml
```

The dashboard writes `ModuleActivation`, `ModelActivation`, and `AppInstance`
resources. `Appliance/local.spec` remains Git-owned and should not be edited for
normal runtime changes.

A fresh installation is GPU-neutral. External models use the default LiteLLM
and model-catalog modules. Add a local model from the dashboard and choose an
available compute target. A CPU target requests KubeAI without a GPU driver; an
NVIDIA, AMD, or Intel target becomes selectable only after detected hardware,
its operator, and the matching allocatable resource are ready. **System
Status** shows the NVIDIA, AMD, and Intel provider lifecycle even when a
provider is not required.

For an experimental AMD profile, current host/driver evidence, profile consent
and a registered GPU enable the catalogued engines by default. Optional engine
tests can be started manually in **System → Hardware**; no validation run is
required to create a model. Strix Halo's CPU and GPU share memory; do not add their capacities
or treat a GPU mapping limit as additional RAM.
