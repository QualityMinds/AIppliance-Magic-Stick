# GPU sharing

**System → Hardware → GPU nodes → GPU Configuration AMD / NVIDIA → GPU sharing** provides the same administration
for AMD and NVIDIA: **Exclusive** or **Shared**, a model-slot limit, transition
status and explicit restart confirmation. The backend stays visible:

| Provider | Exclusive | Shared |
| --- | --- | --- |
| AMD | AMD device plugin | Experimental AMD DRA, one shared claim |
| NVIDIA | NVIDIA device plugin, one allocation | NVIDIA device-plugin time-slicing |

The settings are independent, including on mixed NVIDIA/Strix Halo hosts.
New installations use **Exclusive · one model per GPU** for both providers.
Merely opening Hardware does not change either provider. Apply is enabled only
when the selected mode or shared-model count differs from the current settings,
including configurations that were not saved through this dashboard. Reverting
an edit disables Apply again. The backend labels are **DRA sharing configuration**
and **Time-slicing configuration**; no extra sharing checkbox is required.
The final confirmation still explains model restarts and the lack of isolated
GPU memory. AMD runtime profiles and collapsed GPU-memory controls are grouped
inside **GPU Configuration AMD**, before the separate NVIDIA section.
NVIDIA DRA, MIG and MPS are not enabled by these controls.

## Initial scope and limits

- One physical GPU on one selected, identity-checked node **per provider**.
  Multiple GPU nodes, multiple physical NVIDIA GPUs on that node and MIG are
  not managed by this first version; existing custom configurations are not
  silently adopted or overwritten.
- Model namespace `ai`, one replica per model, and 2–16 shared model slots.
  Exclusive NVIDIA mode admits one model. Additional models wait, ordered by
  creation time and name; disabling/removing a model releases its admission slot.
- AMD DRA requires Kubernetes 1.36 or newer, native mutating admission policies
  and CDI. Existing Strix Halo host/profile checks remain required.
- Pinned AMD DRA driver `rocm/k8s-gpu-dra-driver:v1.0.1`, managed by the AMD
  operator instead of its mutually exclusive device plugin.

This is cooperative sharing for trusted workloads. Models compete for compute,
bandwidth and memory. A slot is not a memory partition, a guaranteed throughput
share or a tenant-security boundary. Existing memory estimates, RAM requests and
risk warnings remain in force. A successful small test is not a guarantee that
two arbitrary large models fit together.

## Common API and configuration

`GET /api/hardware/gpu-sharing` returns a `providers` array. Each entry includes
`provider`, `backend`, `mode` (`exclusive`/`shared`), `managed`, `experimental`,
availability, desired slot count, observed phase, node identity and admitted
models. AMD also reports its device PCI address and shared claim.
Administrator-only `POST /api/hardware/gpu-sharing` uses the normal CSRF checks,
`provider` (`amd`/`nvidia`), `mode`, `maxModels`, `nodeName`, `nodeUid`, the current
`expectedRevision`, `acknowledgeSharing` for shared mode and
`acknowledgeRestart`. The dashboard supplies these acknowledgements only after
the final confirmation, without a separate checkbox. The underlying AMD
integration retains its bounded opt-in and hardware checks; its `experimental`
API flag is not a label for Kubernetes DRA itself.
The API stores bounded JSON in the selected ModuleActivation's
`spec.parameters.gpuSharing`, not `Appliance.spec`:

- `amd-gpu`: internal mode `exclusive` or `dra-shared`.
- `gpu`: internal mode `exclusive` or `time-slicing`.

Generic module/profile edits preserve this separate setting; the dedicated API
is the only dashboard write path. `ModelActivation.status.gpuSharing` records
allocation mode and node, plus claim/PCI device for DRA. Model readiness remains
separate from configuration readiness.

## AMD backend

The operator stops only generated AMD KubeAI models before changing allocation
backends. It retains their activations and downloaded model data; CPU and NVIDIA
models are untouched. Unmanaged legacy AMD workloads block a backend change.
After the DRA driver publishes matching `ResourceSlices`, the operator creates
one namespaced `ResourceClaim` for the real device. Admitted models share it.

KubeAI's generated AMD resource profiles retain the existing CPU/RAM settings
and selected node. A native, fail-closed admission policy attaches the claim only
to marked AMD model Pods created by the KubeAI controller. An unadvertised
sentinel resource prevents CPU fallback if that adapter is absent. Neither CPU
nor NVIDIA profiles are rewritten by the AMD adapter.

Optional Ollama/vLLM validation uses the same shared claim in `ai`, without
privileged workloads or GPU host-path mounts. Validation is manually requested
and does not gate normal GPU use.

## NVIDIA backend

NVIDIA keeps its existing GPU Operator, ClusterPolicy, driver and device plugin.
The shipped `time-slicing-config` ConfigMap contains immutable named profiles:
`magicstick-exclusive` and `magicstick-shared-2` through `magicstick-shared-16`.
The Helm default is `magicstick-exclusive`. The legacy two-slot `any` profile
remains available unchanged for existing installations. The operator switches only the
selected node's `nvidia.com/device-plugin.config` label; NVIDIA's config manager
reloads the named configuration. No external ConfigMap is overwritten.

Before a change, only generated NVIDIA KubeAI models are stopped. Their
activations/downloads remain, and AMD/CPU models are untouched. Unmanaged NVIDIA
GPU workloads block the change. The controller waits for a ready device-plugin
Pod, the selected configuration label, matching `nvidia.com/gpu.replicas` and
matching allocatable slots. Model profiles then request one `nvidia.com/gpu`
allocation on the selected node, retaining their runtime, CPU settings and
CPU-offloading RAM requests/limits. No DRA claim is added to NVIDIA Pods.

An existing MIG configuration, externally selected plugin profile or a
ClusterPolicy pointing to a different ConfigMap blocks management without
rewriting those settings. A changed node UID requires a fresh selection.
The general `mig.strategy=single`/`mixed` setting alone does not imply active
partitions: non-MIG cards with `mig.capable=false` remain eligible. MIG-capable
cards using those strategies need corroborated `all-disabled`/`success` state;
MIG resources, partition labels or a pending MIG configuration block management.

### Upgrading older NVIDIA defaults

Before reconciling the new Helm default on an older installation, inspect the
current ClusterPolicy, node profile label and advertised replica count. If the
node still inherits the former `any` profile and that existing allocation should
remain, pin `nvidia.com/device-plugin.config=any` on that node before the upgrade.
Retain existing explicit or custom node profiles; do not overwrite them or infer
a profile from an unknown configuration. New nodes without an explicit profile
use the exclusive default. Changing an existing allocation remains a separate,
confirmed Hardware action.

## Recovery and diagnostics

Select **Exclusive · one model per GPU** and confirm the restart. For AMD, the controller stops
managed AMD models, waits for claim consumers to release the GPU, removes its
shared claims and restores the device plugin before resuming models. The reverse
operation remains available if the selected hardware no longer qualifies.
Do not remove the DRA driver while its Pods are still terminating: Kubelet needs
the driver to unprepare their claims.
If host evidence temporarily becomes stale, new DRA model admission is blocked
but the driver stays on its selected node so existing claims can still be
released. An eligibility-label change must not tear down that driver first.

Inspect `compatibility.sharing` in the appliance's AMD operator status for
`Switching`, `Starting`, `Ready` or `Blocked`. Inspect the actual claim allocation
and Pod events if models remain pending; an `amd.com/gpu` extended resource is
not expected while DRA owns allocation. The dashboard counts the physical DRA
device once, not once per model slot.

For NVIDIA, the same action selects `magicstick-exclusive`, waits for one
allocatable GPU slot and admits one model. Inspect
`Appliance.status.hardwareOperators.gpu.sharing`, the selected node label and
device-plugin/config-manager logs for progress. Neither path treats replicated
slots as additional physical GPUs. This is not a NVIDIA DRA migration; that
would require separate operator and hardware acceptance.

## Upstream references

- [AMD operator DRA integration](https://instinct.docs.amd.com/projects/gpu-operator/en/latest/dra/dra-driver.html)
- [AMD driver: multiple Pods sharing one claim](https://github.com/ROCm/k8s-gpu-dra-driver/blob/v1.0.1/example/example-multiple-pod-share.yaml)
- [Kubernetes mutating admission policies](https://kubernetes.io/docs/reference/access-authn-authz/mutating-admission-policy/)
- [NVIDIA time-slicing and per-node configuration](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html)
