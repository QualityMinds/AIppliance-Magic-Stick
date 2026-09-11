# GPU compatibility profiles

GPU discovery, Kubernetes allocation, and successful model inference are separate
checks. A PCI ID matching an experimental profile does not mean that the AMD GPU
Operator supports it, that ROCm kernels can run on it, or that both inference
engines support the same stack. Never set a vendor support label just to make a
Helm health check pass.

**Engine validation is optional and manual.** After the required profile consent,
fresh host/driver checks and Kubernetes GPU registration, both catalogued GPU
engines are selectable without running a test model. An unverified, running,
failed or stale test does not disable a ready GPU. Actual runtime configuration,
hardware eligibility and model-specific errors are still checked; availability
does not claim successful inference or memory-accounting validation.

The first additional profile is `strix-halo`, matching AMD display devices with
PCI vendor `1002` and device `1586`, with expected compute architecture `gfx1151`.
The expected architecture is compared with observed KFD/ROCm evidence; it is not
substituted for missing discovery data. Other AMD PCI IDs remain unknown unless
a separate, reviewed profile describes them. A successful HIP test alone is not
an Ollama or vLLM inference acceptance test.

## Host evidence without changing the installation

Normal host convergence installs the diagnostic helpers:

```bash
sudo magicstick-gpu-preflight --json
```

Alternatively, run the source over SSH without copying or installing anything
on the host. Verify its SSH host key first:

```bash
ssh ai@example.local 'python3 - --json' \
  < magic-host/roles/gpu-compatibility/files/magicstick-gpu-preflight.py
```

The host helper only reads files and runs bounded `rocminfo` and `dpkg-query`
commands when present. It does not download packages, load modules, write
configuration, modify GPU permissions, label nodes, or start workloads. Missing
files, absent commands, execution failures and timeouts are reported as unknown
or unavailable, not as success. It needs no Python packages beyond the standard
library. A host-level `rocminfo` command is optional when runtime probing is done
in the actual container image.

The JSON includes OS/kernel versions, loaded `amdgpu`, firmware package evidence,
PCI identities, KFD/render character devices, per-device KFD architectures,
VRAM/GTT counters, TTM limits, and OS-visible RAM. Its stable hardware fingerprint
changes with kernel, driver, firmware package or device identity, not with free
memory. `nodeAnnotation` is a sanitized controller input proposal for a single
matching Strix Halo device; the diagnostic script does not publish it itself. It leaves
`memoryAccountingVerified` false because file inspection cannot prove how GPU
allocations are charged to cgroups.

A separate root-owned `magicstick-gpu-preflight.timer` publishes that evidence
after boot and every five minutes once local K3s is available. Its publisher
checks the Node's kernel and boot identity, adds its actual UID, and patches only
`appliance.magicstick.dev/gpu-host-preflight`. It does not modify eligibility
labels or disclose kubeconfig contents. A missing profile removes only a stale
annotation owned by this publisher. Evidence has a UTC timestamp for freshness
checks. `gpu_compatibility_node_name` defaults to the local hostname and can be
overridden for a custom K3s node name; `gpu_compatibility_publish_evidence=false`
disables the publication timers without disabling the read-only diagnostic command.

A separate `magicstick-memory-sample.timer` runs every 30 seconds and uses
`magicstick-gpu-preflight --memory-only` through the same publisher. This cheap
path reads only `/proc/meminfo` and PCI-matched AMD VRAM/GTT sysfs counters; it
does not run ROCm, package queries, engine validation, or inference. It patches
only `appliance.magicstick.dev/memory-sample`, not compatibility evidence or
eligibility labels. The API checks Node UID, kernel, boot and a 90-second TTL.
CPU availability uses `MemAvailable`; shared GPU free additionally respects the
remaining GTT ceiling, without double-subtracting GPU allocations from RAM.
Stale or missing samples stay unknown on unified-memory hosts instead of falling
back to potentially inflated Kubelet working-set availability.

For tests, `--root /absolute/snapshot/path` uses a filesystem fixture and disables
all subprocesses. `--require-profile strix-halo` exits with status 2 if that exact
PCI profile is absent; this switch is not a compute test.

## Kernel and shared-memory constraints

AMD documents required Strix Halo kernel fixes in upstream Linux 6.18.4+ and a
specific Ubuntu 24.04 OEM backport at 6.14.0-1018+. ROCm userspace compatibility
is version-specific even when those fixes are present. The helper reports this
kernel evidence but does not certify an arbitrary ROCm/container combination.
Older or unrecognized backports require further verification.
[AMD Strix Halo guidance](https://rocm.docs.amd.com/en/docs-7.2.0/how-to/system-optimization/strixhalo.html)

Strix Halo has one GPU and unified physical RAM, not two GPU deployment targets.
GTT/TTM values are dynamic mapping ceilings inside Linux RAM, not an exclusive
reservation. The helper reports their conservative intersection as
`gpuAccessibleMi`; this is separate from the driver's ordinary device-allocation
capacity. Keep operating-system/Kubernetes headroom and validate actual
container accounting before promising memory protection.
[AMD memory explanation](https://rocm.docs.amd.com/en/docs-7.2.0/how-to/system-optimization/strixhalo.html)

In the current JSON contract, `physicalMemoryMi` specifically means
**OS-visible RAM from `/proc/meminfo` `MemTotal`**, not total installed DIMM
capacity. It excludes the firmware GPU carve-out. `gpuAccessibleMi` remains a
mapping bound within Linux RAM, not total GPU memory. The PCI/render-node-matched
KFD local heap must agree with the firmware/VRAM and GTT/TTM counters before the
helper publishes `gpuCapacityMi`, `gpuCapacitySource: kfd-topology` and
`gpuAllocationMode`:

- `firmware-reserved`: the KFD heap agrees with the active firmware carve-out
  and GTT is no larger. GPU budgets use this pool, outside Linux `MemTotal`.
- `shared-gtt`: GTT is larger than VRAM and KFD agrees with TTM. Capacity is
  bounded by GTT, TTM and Linux RAM; model planning also intersects remaining
  host RAM budgets after safety headroom.
- `unknown`: missing, stale, ambiguous or contradictory evidence does not
  become an inferred capacity. GPU capacity is unknown and host requests stay
  conservative.

For example, a corroborated 64 GiB firmware heap with a 46 GiB dynamic ceiling
reports one 64 GiB GPU capacity, not 46 or 110 GiB. A 512 MiB carve-out with a
corroborated 109 GiB GTT heap reports 109 GiB, not 109.5 GiB. This matches the
[amdgpu APU allocation rule](https://github.com/torvalds/linux/blob/v7.0/drivers/gpu/drm/amd/amdgpu/amdgpu_ttm.c#L2159).
Driver capacity is not proof that an engine can successfully allocate all of
it; engine buffers, current usage and runtime validation remain separate.

The read-only inventory also publishes `installedMemoryMi` from populated
SMBIOS type-17 devices (`dmidecode --type 17`) and `firmwareReservedMi` when the
selected `uma/carveout_options` entry agrees with `mem_info_vram_total`. Missing
tools, unknown SMBIOS device sizes or conflicting firmware evidence remain
unknown; installed capacity is never inferred by adding Linux and GPU counters.
Only the aggregate capacities are published, not DIMM identifiers or raw DMI
output. These two inventory fields do not change scheduling, model estimates,
GPU eligibility, firmware settings or reboot plans.

The dashboard separates installed RAM, the fixed GPU carve-out, Linux-visible
RAM, the dynamic GPU ceiling and driver-reported model capacity/allocation
domain. The dynamic value is **inside** Linux RAM and
must not be added to it. Where the measured totals reconcile, the difference
`installed - fixed - Linux-visible` is labelled other firmware/platform memory,
not extra GPU capacity. Existing CPU/GPU gauges remain conservative model-budget
views, not hardware-inventory totals. Fixed GPU free memory is not inferred
from Linux `MemAvailable`; without vendor usage metrics it stays unknown.

Neither a GTT ceiling nor a Kubernetes memory request protects RAM for a future
GPU process. Protecting a dynamic AI budget would require bounded non-AI/host
workloads, system headroom and verified GPU/cgroup accounting under load. This
implementation does not install that protection or claim a hard GPU limit.
Firmware reservation choices remain exactly those advertised by the BIOS;
there is no arbitrary larger carve-out or automatic firmware/TTM change.

## Explicit Ansible preparation

Administrators can also configure the **fixed firmware reservation** and
**dynamic GPU memory ceiling** using sliders in **System → Hardware → GPU nodes → GPU memory → Shared
GPU memory**. Only discovered firmware options are offered, with a 16 GiB
CPU/OS allowance for the dynamic ceiling and explicit restart confirmation.
The host worker verifies actual RAM after changing the carve-out before applying
TTM through the role below. This does not expand the scheduler's capacity using
unverified projected RAM. See the [memory workflow and recovery
contract](host-management.md#fixed-and-dynamic-gpu-memory).

The normal user entrypoint is now **System → Hardware → GPU nodes → Host preparation** for
both new and existing machines. It uses the same Ansible role below through a
local root worker, with explicit package/reboot confirmation and resumable
verification. **System** also provides administrator restart/shutdown controls.
See [host management](host-management.md), including the bounded experiment mode
for unreviewed GPU combinations. The command below is a low-level local
maintenance/check-mode entrypoint, not a second installer workflow.

Generic AMD detection never performs a kernel, firmware, driver or ROCm upgrade.
The independent preparation entrypoint is disabled by default:

```bash
ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook \
  -i magic-host/inventory/localhost.yml magic-host/playbooks/gpu-prepare.yml \
  -e gpu_compatibility_prepare_host=true \
  -e gpu_compatibility_profile=strix-halo \
  -e @/path/to/reviewed-host-preparation.yml --check --diff
```

Create the private input file only after reviewing the installed hardware and
the exact Ubuntu/ROCm support combination. The role currently bounds preparation
to Ubuntu 24.04 and 26.04; this OS check is not a validated-stack claim. Review
check-mode output before explicitly rerunning without `--check`.

| Variable | Contract |
| --- | --- |
| `gpu_compatibility_prepare_host` | Defaults to `false`; all preparation is behind this opt-in. |
| `gpu_compatibility_profile` | Must be `strix-halo`, with matching hardware detected locally. |
| `gpu_compatibility_package_versions` | Mapping of allowed APT package names to exact versions. Empty by default; no automatic `latest`, repository additions, downgrades or vendor installer scripts. |
| `gpu_compatibility_ttm_limit_mib` | `null` leaves existing configuration unchanged; a positive integer writes the managed next-boot TTM mapping limit; `0` removes only that managed override. |
| `gpu_compatibility_system_reserve_mib` | At least 8192 MiB must remain outside an explicit TTM mapping limit. This is a safety floor, not a universal sizing recommendation. |

Allowed pinned package families are `linux-firmware`, `rocminfo`, the exact
`linux-generic-hwe-24.04` meta-package, and explicit
`linux-image-*`, `linux-modules-*`, `linux-modules-extra-*` and `linux-headers-*`
packages. All require exact package-version pins. Select versions from already
trusted Ubuntu repositories; the role
does not invent a certified kernel/firmware stack. An empty package map is a
valid read-only preparation check after helper installation.

TTM changes affect `/etc/modprobe.d/90-magicstick-ttm.conf` and refresh the
initramfs. They are not applied to a running GPU. Package changes can also need
a reboot, but the role never reboots, blacklists/loads `amdgpu`, enables KMM, or
changes Kubernetes GPU eligibility. Its evidence timer publishes non-secret
diagnostic metadata, not support claims. Schedule a controlled reboot separately and
rerun diagnostics afterwards. To remove a Magic Stick TTM override, explicitly
set its limit to `0`, review the diff, apply and reboot. Keep a previously
working kernel available when planning a kernel upgrade.

## A small computation proof in the exact inference image

Run `magicstick-hip-smoke.py` in a disposable diagnostic container based on the
same pinned ROCm vLLM image used for models, with access to the selected GPU.
The helper requires the image's own ROCm-enabled PyTorch; it does not install
dependencies. Bind or stream the script and invoke:

```bash
python3 /path/to/magicstick-hip-smoke.py --expected-architecture gfx1151
```

It rejects CPU/CUDA-only builds, unavailable GPUs and unexpected architectures.
It performs a small FP32 GPU matrix multiplication, synchronizes the device,
checks that the result is still a GPU tensor, and compares finite output with
an exact CPU reference. JSON success still includes
`modelInferenceValidated: false`.

Follow that test with tiny Ollama and vLLM model requests separately, using the
actual configured image digests. Verify GPU execution, correct responses,
memory accounting, repeated requests and restart behavior. Record image,
hardware fingerprint and outcomes; invalidate old evidence after relevant host
or image changes. Do not silently enable CPU fallback, architecture overrides,
Vulkan, or an alternative device plugin when a ROCm test fails.

A dashboard engine result of `passed` means that the bounded GPU smoke test
succeeded for that host and exact runtime image. It does not certify every
model, quantization, context length, answer quality, sustained performance or
restart scenario, and it does not establish GPU cgroup memory accounting. A
provider becomes `Ready` from hardware and registered-resource readiness,
independently of either engine test. Inspect the separate Ollama/vLLM diagnostic
results when investigating a model failure. The compatibility profile remains
experimental even after those small tests pass.

The operator publishes configured AMD images through
`magicstick-gpu-runtime-images`. KubeAI imports generic resource profiles first
and these image pins last, without duplicate inline AMD image tags. This keeps
Helm values merging from restoring a different runtime. Catalog release tags
work without validation; successful optional tests can pin their actual digest.
`runtimeReady` requires the exact configured image reference in
KubeAI's installed configuration and Ready controller Pods with matching
configuration checksums. See the [Flux values-reference contract](https://fluxcd.io/flux/components/helm/helmreleases/#values-references).

Use **Verify Ollama** or **Verify vLLM** under **System → Hardware → GPU nodes**
to request a bounded test only for that engine and node. Its scoped request does
not reset other engine results. `hardware validate --yes` and the TUI's
validation action still request both engines on matching nodes. Profile
saves and host preparation never start them. A request is bound to the host boot,
hardware and runtime images at its first test; changed evidence becomes stale
without automatically launching another test. Request a new run to refresh it.
Legacy automatic `host-<request-id>` requests are retired on upgrade.

The manually requested model fixture uses the raw completion `2 + 2 =` with a two-token
output budget and checks the exact arithmetic answer. It deliberately avoids
model-specific chat and thinking templates: a tiny model's instruction-following
failure must not be confused with a broken GPU kernel. The same fixed fixture
can be compared on CPU and GPU; arbitrary or merely nonempty output never passes.

## Local checks

```bash
python3 -m unittest discover -s magic-host/roles/gpu-compatibility/tests -v
ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook --syntax-check magic-host/playbooks/local.yml
ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook --syntax-check magic-host/playbooks/gpu-prepare.yml
```

Related operational contracts: [host automation](../magic-host/README.md),
[GPU operations](operations.md), [modules](modules.md), and
[operator orchestration](operator-orchestration.md).
