---
name: magicstick-host-hardware
description: "Diagnose or change Magic Stick installer and host behavior for networking, updates, kernels, GPU drivers, sharing and memory. Use for hardware/host boundaries, not ordinary dashboard layout or source publication."
---

# Host and hardware work

Read [project instructions](../../../AGENTS.md). Select references by the symptom
or changed behavior; do not run every hardware procedure by default:

| Area | Reference |
|---|---|
| Installer/host setup | [Installer](../../../magic-installer/README.md), [host automation](../../../magic-host/README.md), [host management](../../../docs/administration/host-management.md) |
| GPU detection, startup, reboot recovery | [GPU setup](../../../docs/administration/gpu-setup.md), [diagnostics](../../../docs/administration/troubleshooting/gpus.md) |
| Sharing or shared RAM | [Sharing](../../../docs/administration/gpu-sharing.md), [memory controls](../../../docs/administration/gpu-memory.md), [accounting](../../../docs/concepts/memory.md) |
| Network or package maintenance | [Network/recovery](../../../docs/administration/network.md), [updates](../../../docs/administration/ubuntu-updates.md) |

## Diagnose before changing state

Confirm the intended host/cluster from the user-provided access context; never
copy private access details into the repo. Collect read-only evidence for the
running OS/kernel, all PCI GPUs, host driver, device registration and the failing
workload. Correlate boot/reconciliation timestamps, conditions, events and logs.

Separate firmware/host readiness, operator state, Kubernetes resources and engine
inference. AMD DRA uses claims/slices, so a missing extended GPU resource alone is
not a failure. Runtime-visible devices are not proved by a healthy driver Pod.
Use durable device identity rather than volatile card/render indices. Treat each
vendor and every GPU on a mixed host independently, while remembering that all
GPUs on that host share its kernel.

For memory, compare allocation-domain-specific counters and sample freshness with
saved budgets; do not equate reservations with live usage or add overlapping RAM.
For network/package failures, verify interface/driver, connectivity and actual
package sources before assuming a mirror or installer-screen problem.

## Implement or recover only within scope

If a fix is authorized, identify the smallest owning change, its interruption
risk and recovery path. Use the existing host-operation/Ansible workflow instead
of a second installer-only GPU preparation path. Preserve operator compatibility,
user-selected settings, operation locks and versioned host-bound plans.

Before a reboot, network/firmware change, driver reinstall or destructive cleanup,
confirm that existing authorization covers the target and disruption; otherwise
ask. Do not repeatedly ask for already-authorized steps. Stop on lost access or
an ambiguous host identity; never erase pending operation state or widen a failed
recovery automatically. Retain an available recovery route for disruptive changes.

Read the exact upstream version's documentation before changing support profiles,
packages or runtime flags. A successful local experiment does not certify a GPU
combination or justify silently adding it to default support.

## Verify

Use affected role suites under `magic-host/roles/*/tests`, installer tests in
`tests/`, shell syntax checks and Ansible syntax validation as relevant. API or
controller changes also need their consumer tests. A CLI `--help` check alone is
not a host-behavior test.

Perform hardware acceptance only when authorized. Verify post-operation state,
re-registration and affected workloads, not just request acceptance. Report local
checks separately from tested hardware, remaining recovery work and live evidence.
