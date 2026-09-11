# Host management after installation

New and existing appliances use **one post-install workflow**. The installer
provides Ubuntu, K3s, the dashboard, diagnostic helpers and a root-owned local
worker. It does not contain a second GPU package-selection or reboot path.
The base kernel must already boot the computer and reach storage/network;
post-install preparation cannot repair an installer that cannot boot.

## User workflow

Open **System → Hardware → Host preparation**. The local worker periodically
inspects the OS, running kernel and **all PCI display GPUs**. It publishes a
versioned, host-bound plan, including exact package changes and whether a reboot
is necessary. Inspection itself never installs packages or restarts the host.

For a matching reviewed plan, acknowledge the experimental hardware profile,
select **Review hardware preparation**, and type the computer's exact name in
the confirmation dialog. The confirmation authorizes the displayed packages,
one orderly restart if required, and AMD GPU profile activation. The
local root worker runs the existing Ansible preparation role, persists its
progress, and resumes verification after reboot. Closing the dashboard does
not cancel an accepted operation. Existing working kernels are not removed.
After host verification, `Registering` waits for fresh eligible hardware and an
allocatable Kubernetes GPU. This completes preparation without an engine smoke
test. Engine validation is an optional manual action in **System → Hardware**;
no test-model or inference-image download is started by host preparation.

Package and power operations target only the selected computer. GPU runtime
profile selection uses the existing AMD `ModuleActivation`, which
applies to matching cluster Nodes; the confirmation explicitly includes that
scope. Concurrent preparation requests must not overwrite a changed module
decision: the worker detects configuration changes and stops its profile
handoff. Per-Node runtime placement/validation isolation is a separate extension.

The first shipped package profile is `strix-halo-ubuntu-24.04`, version `1`, for
Ubuntu 24.04 on x86-64 with Strix Halo (`1002:1586`). It targets
`linux-generic-hwe-24.04=7.0.0-31.31~24.04.1` / kernel `7.0.0-31-generic`.
This is a reviewed additional preparation profile, not a blanket kernel policy.
An already working host does not reinstall that package or downgrade a newer
kernel. NVIDIA, Intel and other AMD devices without this preparation requirement
retain their existing operator path; no matching profile is not proof of GPU
support. Profiles must be maintained and revalidated for future security updates;
the worker never selects arbitrary `latest` releases.

## Mixed systems and experiment mode

All GPUs **inside one computer share its kernel**. Different cluster Nodes have
independent kernels. The normal path blocks a Strix Halo kernel change on an
unreviewed mixed/multi-GPU computer, without disabling working vendor operators.
A working Strix Halo host driver alongside another vendor can still undergo
AMD engine validation without changing its kernel.

When a shipped host profile matches the OS/architecture and required Strix Halo
device but the additional GPUs are unreviewed, administrators can enable
**Experiment mode**. The UI shows the full detected GPU list and the proposed
profile. A separate acknowledgement and exact-host confirmation are required.
Other GPU drivers, graphics output or connectivity may break; have physical
console access and the previous kernel available in the bootloader. There is no
claim of automatic bootloader rollback or remote power recovery.

Experiment mode permits only the displayed, shipped package plan. It cannot
accept an arbitrary kernel URL, shell command, package name, repository, ROCm
installer or architecture override. Unknown OS/architecture and incomplete PCI
inventory remain blocked; a new package profile needs code review first. It does
not bypass inference eligibility. Multi-AMD layouts not supported by the current
node-scoped plugin profile may finish as `PreparedUnverified`: host preparation
is distinct from GPU availability. Successful AMD smoke tests do not certify
other vendors or the entire mixed system. Tests remain local evidence, never
automatic additions to the public compatibility catalog.

## Fixed and dynamic GPU memory

**System → Hardware → Shared GPU memory** provides two administrator controls
on a single supported Strix Halo GPU with compatible kernel/firmware evidence:

- **Fixed GPU reservation (firmware):** a discrete slider containing only the
  options reported by that computer's `uma/carveout_options`. This RAM is carved
  out at boot and is unavailable to Linux.
- **Dynamic GPU memory limit:** a slider in 1 GiB steps for the TTM ceiling on
  GPU use of shared Linux RAM. It is not a reservation, an additional memory
  pool, or guaranteed free memory. CPU workloads compete for that RAM.

The panel separates current values from the unsubmitted draft. Changing a
slider sends no host operation. A non-step-aligned kernel default can have a
rounded draft, but that alone cannot enable submission. The preview estimates
Linux RAM as current `MemTotal` plus the old fixed reservation minus the new
fixed reservation. The dynamic ceiling must leave at least **16 GiB** outside
GPU dynamic allocations; this allowance is not a Kubernetes memory reservation.
Actual post-boot `MemTotal`, not this projection, governs the second stage.

Select **Review memory configuration**, accept the experimental/disruption
warning and enter the exact computer name to apply. A fixed-reservation change
may require **up to two restarts**: first apply and verify the firmware choice,
then apply the dynamic limit through the existing Ansible role and verify it
after another boot. A dynamic-only change requires one restart. All workloads
on that computer are interrupted; no migration or automatic firmware rollback
is promised. Keep physical console/recovery access available. Closing the
browser does not cancel an accepted operation.

The worker independently checks the reviewed hardware/configuration identity,
actual firmware options, active memory values and safety allowance. Missing
firmware controls, mixed/unknown GPU layouts, incomplete/stale evidence and
competing boot/modprobe overrides disable this flow. Hardware experiment mode
does **not** override those memory guards. A memory operation installs no kernel
or packages, changes no inference profile and starts no GPU validation workload.
Its success confirms the requested memory settings, not inference compatibility,
performance, cgroup accounting or successful model execution.

The next-boot dynamic setting is owned in
`/etc/modprobe.d/90-magicstick-ttm.conf`; the role refreshes initramfs. Neither a
live TTM-only write nor the deprecated `amdgpu.gttsize` override is used. Firmware
option indices are resolved locally; browser requests contain no device path or
shell command. [Linux UMA controls](https://www.kernel.org/doc/html/latest/gpu/amdgpu/driver-misc.html#uma-carveout)
and [AMD shared-memory guidance](https://rocm.docs.amd.com/en/docs-7.2.0/how-to/system-optimization/strixhalo.html).

## Restart and shut down

Administrators see **Computer power** inside **System**, with **Restart computer**
and **Shut down computer**. If several managed computers are reported, select
the target explicitly. Both buttons require typing its exact name and accepting
interruption of all services/workloads on that computer. They are unavailable
for stale/offline workers or while another operation is active.

The worker uses normal systemd `shutdown -r +1` or `shutdown -P +1`: approximately
one minute after local acceptance, not an immediate forced reset. Save work
before confirming; there is no automatic Pod migration or zero-downtime promise.
The dashboard distinguishes **accepted**, **scheduled**, and **new boot observed**.
It cannot prove physical power-off while the machine is unreachable, and does
not repeatedly send a power request. Power-on requires local action or separately
configured remote power management. [systemd shutdown manual](https://www.man7.org/linux/man-pages/man8/shutdown.8.html)

## Execution and security boundary

- `magicstick-host-management.timer` runs after boot and every 15 seconds after
  the previous tick completes. It waits for cloud-init's base installation to
  finish. No installation-time consent is inferred.
- Root-owned implementation and profiles live in
  `/usr/local/lib/magicstick/host-management/`. Local progress is atomically
  persisted in `/var/lib/magicstick/host-management/state.json` (root only).
- The worker publishes `appliance.magicstick.dev/host-management` on its local
  Node. API availability requires matching Node UID, boot ID and kernel plus
  evidence no more than three minutes old.
- `GET /api/host-management` is viewer-readable. Administrator-only
  `POST /api/host-management/operations` requires existing authentication,
  same-origin/CSRF checks, exact-host confirmation, current Node/boot/plan IDs,
  explicit disruption consent, and a unique 32-hex request ID. No secrets or
  executable content are accepted. The actor subject is hashed for the request.
- One immutable namespaced `HostOperation` per Node serializes browser requests.
  New requests expire after five minutes if not accepted locally. Active requests
  cannot be replaced; terminal replacement uses a resource UID precondition.
  The worker independently rechecks all inputs, and remembers processed IDs.
- The dashboard may create/read/delete these requests in `ai-system`; it cannot
  write their status, patch Nodes or execute host commands. No privileged
  dashboard Pod, hostPath or network-facing root agent is introduced. The worker
  uses the existing root-only local K3s kubeconfig; cluster/root administrators
  remain trusted. Arbitrary external Kubernetes installs and agent-only Nodes
  without a local management credential do not silently gain host control.
- Host convergence and host operations share
  `/var/lib/magicstick/host-management/maintenance.lock` inside a root-only
  directory. Convergence skips an active
  operation and a scheduled shutdown; it does not compete with APT preparation.
- APT uses exact approved versions, signed configured repositories, no
  downgrades and no package removals. The prepare playbook is the same bounded
  Ansible implementation used for explicit local maintenance.
  [Ansible APT contract](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/apt_module.html)

## Progress and recovery

Typical preparation: `Preparing` → `RebootScheduled` → `Verifying` → `Registering`
→ `Succeeded`. A host that needs no restart enters registration directly.
`Succeeded` means fresh host/driver evidence and an eligible registered GPU,
not an engine smoke test, production model acceptance or KubeAI runtime-image
adoption. Legacy in-progress `Validating` operations now complete from the same
registration checks. Optional engine diagnostics remain visible under
[GPU compatibility](gpu-compatibility.md).

Memory configuration uses `Preparing` → `RebootScheduled` → `Verifying`, with a
second bounded cycle when both firmware reservation and TTM need changing.
Root-owned state records the stage and reboot count before side effects. An
interrupted/uncertain write is never automatically replayed. Changed hardware,
unexpected actual memory or a conflicting local setting stops the operation;
inspect the journal before issuing a new confirmed request.

`Rejected`, `Interrupted`, `Failed` and `PreparedUnverified` are terminal. An
uncertain package execution, changed boot/profile, wrong kernel after reboot,
expired request or failed engine test does **not** trigger an automatic retry,
another kernel change, or a reboot loop. Inspect and submit a new confirmed
request only when appropriate. GPU validation waits at most one hour, allowing
for large image downloads; host driver verification waits five minutes.

```bash
sudo systemctl status magicstick-host-management.timer
sudo journalctl -u magicstick-host-management --since '-30 minutes'
sudo magicstick-gpu-preflight --json
kubectl -n ai-system get hostoperations
```

Do not delete an active request or its root-owned state to force a retry. If an
administrator manually removes Kubernetes execution state, the local worker
stops rather than guessing whether a power/package operation already happened.
Retain the journal for audit and review local recovery before clearing state.

## Local verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s magic-host/roles/host-management/tests
PYTHONDONTWRITEBYTECODE=1 python3 \
  magic-host/roles/host-management/tests/rancher_contract_test.py \
  --context rancher-desktop
```

The second test explicitly targets local Rancher, creates an isolated namespace
and the CRD only if absent, and removes its own resources afterwards. It verifies
real Kubernetes validation, immutability, RBAC and status persistence with a
**fake power executor**. It neither installs a host worker nor patches/restarts
any Node. Unit tests cover package/reboot decisions and post-boot continuation;
physical power loss, bootloader fallback and actual mixed-GPU compatibility
still require a separately approved hardware test.
