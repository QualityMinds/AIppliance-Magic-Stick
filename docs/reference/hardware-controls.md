# Hardware API and controls

## Hardware Compatibility Controls

**System → Hardware → GPU nodes → Node: name → GPUs** contains one named,
initially collapsed accordion per physical PCI GPU, not per sharing slot. Its
physical memory layout appears first, followed by device facts and collapsed
**GPU sharing**, **AMD runtime profile** and **Shared GPU memory** sections.
AMD-only controls stay with their matching device. Bold summary titles carry
info icons without repeated inner headings. New installations default to
one model per GPU for both providers. Apply is enabled only for changed, valid
settings; sharing uses one final restart confirmation and no additional checkbox.
The backend labels are **DRA sharing configuration** and **Time-slicing configuration**.
`GET/POST /api/hardware/gpu-sharing` exposes both providers' status and guarded
configuration. See [GPU sharing](../administration/gpu-sharing.md) for its single-device-per-provider
scope, transition, memory limitations, upgrade preservation and rollback.
Existing settings are not changed merely by opening the page.

AMD DRA recovery distinguishes a ready host driver from a blocked GPU allocation
service. A stale claim or restarting DRA plugin is reported as an allocation
problem, not a missing driver installation. Optional diagnostic results survive
Job cleanup; interrupted requests require a new manual verification.

**System → Settings → Updates** manages automatic Ubuntu security updates, the UTC
maintenance window, optional automatic restarts and manual package maintenance.
It shows held/kernel/GPU packages and reboot requirements without automatically
updating the hardware stack or container images. See [Ubuntu updates](../administration/ubuntu-updates.md).

**System → Model cache** (`#/system/model-cache`) is an administrator-only tab
showing disk free space and per-engine model-cache sizes. Explicit, exact-host
confirmation clears unused Hugging Face/Ollama files through the host worker;
active models and stale inventory block cleanup. FreeToken's temporary cache is
released by stopping its model. See [model cache management](../administration/model-cache.md).

**System → Settings → Network** is an administrator-only subtab for Ethernet/Wi-Fi,
DHCP/static IPv4, DNS, route metrics and Wi-Fi scanning. Changes require
exact-host approval and a second confirmation, with local timeout/boot recovery.
See [network management](../administration/network.md) for limitations and credentials.

The Hardware page puts **GPU operators** first, followed by **GPU nodes** as the
main workspace. Only **Profile**, **Upstream operator recognition**, **Running
kernel**, **Planned kernel** and **Kernel / driver plan** remain in the node grid.
**Architecture**, **Host driver**, **Kubernetes GPU resource** and **Detected GPU
device** belong to the respective GPU accordion. Below the accordions, optional
Ollama/vLLM verification offers all GPUs on the node or one physical device.
Requests contain explicit device IDs; results stay separate per GPU and engine.
Tests require confirmation and run sequentially. Unsupported targets are never
silently omitted from an all-GPU request. See [diagnostic binding and
limitations](gpu-compatibility.md#device-specific-dashboard-diagnostics). Host preparation keeps its status and actions without a
nested card. General explanatory paragraphs are replaced
by info icons with hover, keyboard-focus, and click/touch overlays. Current
values, status badges, errors, required acknowledgements, and confirmation-dialog
warnings remain visible. An operation's details appear only in its matching
power, preparation, or memory section.

**System → Hardware → GPU nodes → Host preparation** uses the same approved Ansible workflow
after initial installation and on existing computers. Plans show exact package
changes and restart requirements; a bounded experiment mode permits explicitly
acknowledged tests on unreviewed mixed-GPU combinations. Administrators also see
the separate **System → Computer power** tab immediately after **System Status**,
with exact-host confirmation for restart or shutdown. Power controls only appear
on this tab, not on the other System tabs. Viewers/operators cannot access the tab
or execute these actions. Availability, progress, power-off limitations and
recovery are documented in [host management](../administration/host-management.md).

Host preparation already activates the matching AMD runtime profile. The
collapsed **AMD runtime profile** section inside the matching GPU retains
the manual profile override without presenting it as a second required setup
step. That override only changes the cluster's AMD `ModuleActivation`; it does
not install a kernel or driver. Host package plans and runtime profiles remain
separate backend concepts.

On an eligible host with one Strix Halo GPU (optionally alongside NVIDIA GPUs
bound to the `nvidia` driver), expand **GPU nodes → GPUs → GPU Configuration AMD → Shared GPU memory** for sliders
for the fixed firmware reservation and dynamic shared-RAM ceiling. Current
values and the local draft remain separate; moving a slider never applies a
change. An active dynamic limit above the current safety maximum offers a
corrective draft through **Review memory configuration**, even before touching
a slider. Ordinary step-rounding alone does not enable submission. The final
disruption dialog requires exact-host confirmation,
with up to two controlled restarts when the firmware reservation changes.
Stale evidence, conflicting boot settings and unsupported layouts disable the
controls. The dynamic ceiling is not a reservation or an extra RAM pool. See
the [memory control contract](../administration/host-management.md#fixed-and-dynamic-gpu-memory).

**System → Hardware** (`#/system/hardware`) separates upstream GPU support,
additional profile selection, host readiness, Kubernetes GPU registration and
optional per-engine validation. All authenticated dashboard roles can inspect this
state. Only administrators may save AMD compatibility parameters or request
validation; ordinary module operators cannot submit arbitrary probe images,
scripts or selectors through the API.

The initial additional profile is **AMD Strix Halo (experimental)**. Selecting
it requires the experimental acknowledgement and does not itself confirm
inference support. Once host/driver checks and GPU registration pass, both
configured engines are available without a test. **Verify Ollama** and
**Verify vLLM** beside each engine are optional diagnostics for that node and
engine only, requiring a saved profile and a second
confirmation because it downloads images/test models and uses GPU resources.
It uses the saved profile, not an unsaved advanced-profile draft.
Results for Ollama and vLLM remain separate from runtime readiness. Profile saves
and host preparation never start test models. Returning to upstream rules removes
the additional opt-in rather than claiming the hardware has become supported.

`POST /api/hardware/validation` requires administrator access, CSRF protection,
the current node UID, saved profile, a unique request ID and explicit resource-use
acknowledgement. It stores one scoped request annotation per node UID/engine on
`ModuleActivation/amd-gpu`, with a resource-version precondition. Other engines'
requests/results are preserved. Profile-generation changes invalidate scoped
requests; a new explicit all-engine CLI/TUI request supersedes them.

The existing all-engine flow uses `ModuleActivation/amd-gpu.spec.parameters` fields
`compatibilityProfile`, `allowExperimental` and `validationRequest` through the
existing module API. `GET /api/status` exposes the catalog and evidence under
`hardwareOperators.amd-gpu.compatibility`. Host/kernel/image changes invalidate
old evidence without automatically repeating the tests. Missing, running, stale
or failed results do not disable GPU use; host, profile and runtime-configuration
checks still apply. CLI users have `hardware list`,
`hardware profile strix-halo --allow-experimental`,
`hardware validate --yes`, and `hardware profile upstream`; the TUI provides
Hardware inspection and the same explicitly confirmed administrator actions.

Strix Halo cards show one GPU, its firmware reservation, dynamic ceiling and
corroborated driver capacity/allocation domain. The Models estimator uses the
active domain instead of adding firmware and dynamic limits. Unverified GPU
cgroup accounting stays visible as a warning, not a hard-limit promise. See
[GPU compatibility](gpu-compatibility.md) and
[unified-memory reservations](compute-targets.md#amd-unified-memory-reservations).

The reported shared capacity is conservative OS-visible RAM. The API's
`physicalMemoryMi` field is based on `MemTotal`, not installed DIMM capacity;
BIOS carve-outs and raw VRAM totals are not added to it. Hardware can therefore
contain more installed RAM than the currently exposed shared-pool budget.
