# Dashboard image promotion

### Dashboard image promotion

A source commit and a successful `Build MagicStick dashboard clients` workflow
do not change the image used by existing appliances. The Web and API Deployment
manifests pin immutable digests; updating the mutable registry aliases or
restarting an unchanged Pod does not replace those pins.

An explicitly requested manual rollout can dispatch the image workflow with
`skip_tests: true`. The default remains `false`, and normal push builds always
run the test suites. A manual no-tests build still compiles the clients and
checks the approved license trust bundle; it is not a successful test result.
If automatic push checks must also be deferred, use GitHub's `[skip ci]` commit
marker and dispatch only this image workflow. Do not report skipped checks as
passed, and perform the deferred validation after the requested user testing.

After the workflow succeeds, inspect the `sha-<commit>` and `api-sha-<commit>`
registry tags. Verify their `linux/amd64` and `linux/arm64` manifests, then promote
their image-index digests together in `magic-cluster/apps/dashboard/deployment.yaml`
and `magic-cluster/apps/dashboard/api-deployment.yaml`. Commit the promotion to
the branch tracked by the appliance. Flux must reconcile that new revision
before the Deployment can roll out the new containers.

Promote the same commit's `cli-sha-<commit>` image-index digest in
`magic-host/roles/dashboard-console/defaults/main.yml` for the physical TUI.
The normal host convergence applies that runtime Deployment and retains its
persisted console state. Changing the mutable `console` alias alone does not
restart an already running console Pod.

Verify the configured image, running Pod image ID and readiness for both
`dashboard/ai-appliance-dashboard` and
`identity-system/ai-appliance-dashboard-api`. Finally reload the primary
dashboard in a browser and check the changed screen under the intended role.
For Hardware controls, verify **Node: name**, a node-only kernel/profile grid,
and one named accordion per physical PCI GPU. GPU facts must never be copied
from AMD onto NVIDIA. Physical memory appears first inside each GPU; sharing,
AMD runtime profile and shared memory start collapsed with bold info-icon
summaries. Below the GPU accordions, check the all/single-GPU selector and
independent Ollama/vLLM results and verification buttons. Merely opening the page must not submit a validation,
preparation or memory request. Do not launch GPU probes during a UI-only rollout.
Report source publication, image build and live rollout as separate results;
an old digest is not a browser-cache problem.

For unified-memory inventory changes, also let normal host convergence install
the updated read-only GPU preflight and refresh its Node annotation. Verify
`installedMemoryMi`, `firmwareReservedMi`, `physicalMemoryMi` (Linux RAM) and
`gpuAccessibleMi` (dynamic ceiling), `gpuCapacityMi`, `gpuAllocationMode` and
`gpuCapacitySource` separately. The PCI-matched KFD heap must corroborate the
allocation domain. Models shows one compact GPU gauge with four dedicated/shared
readings and info popups; Hardware retains the detailed inventory. Neither adds
firmware and dynamic limits. Check that missing dedicated live metrics render as
a dashed ring and `—`, and shared readings stay bounded by Linux `MemAvailable`
and the dynamic ceiling minus live GTT usage. The separate
`magicstick-memory-sample.timer` publishes direct procfs/sysfs counters every
30 seconds under `appliance.magicstick.dev/memory-sample`; samples expire after
90 seconds and are bound to the Node UID, kernel and boot. Compare the CPU ring
to `/proc/meminfo`, shared free to `min(MemAvailable, GTT ceiling - GTT used)`,
and dedicated free to the AMD sysfs VRAM counters. Do not subtract reservations
from measured free memory, or GPU usage from Linux availability a second time.
Kubelet working-set metrics are not a substitute on unified-memory hosts.
For fixed allocations, check that the generated
KubeAI profile requests host runtime RAM, not the GPU weight budget again;
for dynamic/unknown allocations retain the conservative shared-RAM request.
Verify the activation's `memoryRequiredMi` and `gpuAllocationMode` after
convergence. Until then, existing larger requests remain counted. Without
live fixed-GPU metrics, free VRAM must stay unknown, not equal Linux available RAM.
This inventory refresh needs no firmware write or computer restart. Missing
`dmidecode`/SMBIOS data stays unknown rather than inferred from GPU counters.
No protected dynamic reserve or new cgroup limit is installed by this change.
Before claiming such protection, test non-AI and host-service budgets plus
GPU/cgroup accounting under memory pressure; do not use a GTT ceiling or
Kubernetes request as proof.
