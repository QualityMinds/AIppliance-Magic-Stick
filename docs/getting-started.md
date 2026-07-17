# Getting Started

This guide covers local validation and the public read-only installer flow.

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

For GPU model serving:

- NVIDIA GPU hardware
- a host compatible with K3s, the NVIDIA GPU Operator, and the configured GPU
  sharing mode

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

The physical console displays the first-run setup screen after Flux and the
identity platform are ready. Scan its QR code or open
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
