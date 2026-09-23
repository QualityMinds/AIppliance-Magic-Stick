# GPU operator support and discovery

## Hardware-Driven GPU Operators

### Ubuntu 26.04 baseline

The installer now targets Ubuntu 26.04 LTS. GPU chart versions were checked
against the vendors' stable Helm indexes on 2026-09-11:

| Integration | Pinned version | Ubuntu 26.04 position |
|---|---|---|
| NVIDIA GPU Operator | `v26.7.0`, driver `595.91.07` | NVIDIA lists Ubuntu 26.04, K3s 1.33–1.37, containerd 2.0–2.3 and kernel 7.0 / R595. |
| AMD GPU Operator | `v1.5.1` | Repository pin at the recorded review. Ubuntu 26.04 is not in the published operator OS matrix; the host/inbox-driver path remains a migration candidate, not a certified stack. |
| Intel Device Plugins Operator and GPU plugin | `0.36.0` | Repository pins at the recorded review. Actual support depends on the GPU, the host `i915`/`xe` driver and the container's user-mode runtime. |

NVIDIA's R595 default no longer supports Maxwell, Pascal or Volta. Those GPUs
need a separately reviewed R580/OS/kernel combination; changing
`kernelModuleType` alone does not restore their support. The catalog's NVIDIA
Kubernetes minimum is 1.33. Existing clusters are not upgraded merely by changing
a chart pin. Check their Kubernetes/containerd versions before reconciling this
baseline, and do not interpret a PCI detection label as complete hardware support.

The NVIDIA toolkit uses K3s' actual containerd config and socket, with a drop-in
at `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/99-nvidia.toml`.
The selected K3s 1.36.4 release imports this directory in its native v3 template,
so no copied or frozen containerd config template is needed. Existing custom
templates or older K3s versions must be reviewed for that import before upgrade.
The NVIDIA Device Plugin / ClusterPolicy path stays enabled; NVIDIA DRA and the NRI plugin
remain disabled. Shared NFD, AMD host-driver mode and Intel kernel-driver mode
are unchanged.

**System → Hardware → GPU sharing** manages NVIDIA exclusive/time-sliced
allocation through `ModuleActivation/gpu.spec.parameters.gpuSharing` and the
selected node's device-plugin configuration label. New installations default to
one model per GPU; the legacy `any` two-slot profile remains available for existing
nodes and must be pinned before upgrading an inherited configuration. AMD uses the same management UI with
its independent DRA backend; device/profile validation remains separate. See [GPU sharing](../administration/gpu-sharing.md)
for limits, model restarts, status and recovery.

References: [NVIDIA 26.7 platform support](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/26.7/platform-support.html),
[NVIDIA GPU deprecation schedule](https://forums.developer.nvidia.com/t/unix-graphics-feature-deprecation-schedule/60588),
[AMD operator compatibility](https://instinct.docs.amd.com/projects/gpu-operator/en/release-v1.5.1/index.html#compatibility),
[Intel GPU driver/runtime contract](https://github.com/intel/intel-device-plugins-for-kubernetes/blob/v0.36.0/cmd/gpu_plugin/README.md#kmd-and-umd).
An installer build and GPU-specific acceptance on Ubuntu 26.04 remain required;
upstream release metadata is not a Magic Stick hardware test result.

### Discovery and activation

One static Node Feature Discovery (NFD) installation scans every node and
refreshes its labels every 60 seconds. Vendor charts never install their own NFD
copy. Magic Stick watches the display/3D-controller vendor labels and creates an
auto-enabled vendor `ModuleActivation` only when compatible hardware is present.

| Module | Detection | Vendor support gate | Allocatable resource | Driver behavior |
|---|---|---|---|---|
| `gpu` | `feature.node.kubernetes.io/pci-10de.present` | same label; NVIDIA validates through ClusterPolicy | `nvidia.com/gpu` | NVIDIA GPU Operator managed |
| `amd-gpu` | `feature.node.kubernetes.io/pci-1002.present` | AMD's NFD support rule, or an explicitly acknowledged compatibility profile with host evidence | `amd.com/gpu` | portable baseline uses the host/inbox `amdgpu` driver |
| `intel-gpu` | `feature.node.kubernetes.io/pci-8086.present` | `intel.feature.node.kubernetes.io/gpu` from Intel's NFD rule | `gpu.intel.com/i915` or `gpu.intel.com/xe` | Linux kernel driver plus Intel device plugin |

Detection is deliberately broader than the vendor support gate. AMD and Intel
upstream support remains defined by their shipped `NodeFeatureRule`. Additional
AMD compatibility is kept separately in a versioned, explicitly selected
catalog; it never changes the vendor's support labels or treats unknown cards
as supported. Before
activation the controller also requires Linux, a supported architecture, and
the catalogued Kubernetes minimum. If the vendor CRD already exists without a
Magic Stick activation, installation stops with `Conflict` rather than creating
a second operator.

Temporary label loss during reboot does not uninstall an existing operator.
The status becomes `Unknown` and the activation is retained. An explicitly
disabled activation is also authoritative and is never re-enabled by hardware
detection. A provider reaches `Ready` only after Kubernetes publishes at least
one allocatable vendor resource.

The model form exposes `cpu`, `nvidia-gpu`, `amd-gpu`, and `intel-gpu`. A target
is selectable only after its provider is `Ready` and the corresponding
allocatable resource exists. Intel remains one user-facing target while the
runtime resolves `gpu.intel.com/xe` or `gpu.intel.com/i915` to a matching KubeAI
resource profile.

### Additional AMD compatibility profiles

`ConfigMap/magicstick-gpu-compatibility-catalog` in `ai-system` supplies
`profiles.json`. The initial `strix-halo` profile matches `1002:1586`, expects
observed `gfx1151`, and declares unified memory and experimental status. It is
not a certified stack. Administrators select it through
`ModuleActivation/amd-gpu.spec.parameters.compatibilityProfile` together with
`allowExperimental: "true"`; the empty profile retains upstream-only behavior.
A unique `validationRequest` explicitly requests GPU tests, image/model
downloads and resource usage. This is optional; the dashboard and CLI require
confirmation. Saving a profile or preparing the host does not start engine tests.

The AMD Helm chart installs the controller and CRDs without its default
`DeviceConfig`. Magic Stick reconciles that operand separately against its own
`appliance.magicstick.dev/amd-gpu-eligible` label after upstream support or
explicit, prepared profile eligibility is established. This avoids coupling
controller installation to an unmatched GPU selector. Eligible hardware with a
registered GPU enables both catalogued engines by default. Optional smoke-test
results do not gate selection or placement; effective runtime configuration must
still be adopted by KubeAI. See
[GPU compatibility](gpu-compatibility.md) for host preparation, evidence,
shared-memory constraints and remaining acceptance gates.
