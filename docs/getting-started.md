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

For local model serving:

- enough CPU RAM for the selected CPU preset, or a supported NVIDIA, AMD, or
  Intel GPU with its host driver prerequisites
- for NVIDIA, a host compatible with K3s, the NVIDIA GPU Operator, and the
  configured GPU sharing mode; AMD uses ROCm and Intel uses the XPU runtime

External LiteLLM-backed providers and CPU inference do not require GPU hardware
or drivers. AMD and Intel targets appear only after their operator and
allocatable Kubernetes resource are ready.

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

For an existing dedicated Ubuntu 24.04 system, the repository-level wrapper
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
