# Getting Started

This guide covers local validation and the public read-only installer flow. For
private deployment repositories, read [gitops-overlays.md](gitops-overlays.md)
after this page.

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
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/platform/observability
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/apps/ai
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
  --domain example.local \
  --dashboard-host dashboard.example.local \
  --dashboard-mdns-name ai-appliance \
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

## Private GitHub Bootstrap

Private mode is opt-in and writes Flux bootstrap state to a private deployment
repository.

```bash
export FLUX_GITHUB_TOKEN=<personal-access-token>

magic-installer/build-installer-image.sh \
  --flux-bootstrap-mode github \
  --deployment-name example-deployment \
  --hostname example-host-01 \
  --git-owner example-org \
  --git-repo example-deployment \
  --git-branch main \
  --flux-cluster-path deployments/example-deployment/infra-cluster/flux-bootstrap \
  --output dist/magicstick-installer-private.img
```

Images built in `github` mode are sensitive because the rendered cloud-init
configuration can contain the Flux GitHub token. Keep them out of Git and treat
them as secrets.

## After First Boot

On the host:

```bash
sudo systemctl status k3s
sudo /usr/local/sbin/ai-appliance-converge
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get kustomizations
```

From another machine with a kubeconfig:

```bash
kubectl -n flux-system get gitrepositories,kustomizations
kubectl get namespaces
kubectl -n ai get pods
```

Continue with [operations.md](operations.md) for runtime checks.
