# Dashboard image promotion

### Dashboard image promotion

Dashboard images are pinned by immutable digest, not by mutable registry aliases.
A source push starts the build; it is not itself a rollout. For ordinary pushes
to `main` or `develop`, **Build MagicStick dashboard clients** now promotes the
tested Web, API and CLI images back to that same branch automatically. No new
GitHub Release tag or manual Pod restart is needed for a branch follower.

## Automatic promotion

1. The build job runs client/API tests and publishes the three multi-architecture
   images from one exact source commit.
2. The promotion job requires successful **Public release checks** and
   **Dashboard browser smoke** push runs for that commit and branch. A failed,
   cancelled, skipped or missing check cannot count as success; the latest run
   attempt is authoritative. Pending checks have a bounded 20-minute wait.
3. `tools/promote_dashboard_images.py` inspects registry metadata, not image
   layers. It verifies each index, platform manifest and configuration against
   its SHA-256 digest. Every component must contain Linux AMD64 and ARM64 and
   carry the expected project, component and source-revision labels.
4. The helper checks the current branch head. A newer runtime, promotion-policy
   or image-pin change supersedes the older build. Documentation, host-only or
   ConfigMap advances can be retained when they do not change baked image inputs;
   their own public source checks must also succeed.
5. A clean CI checkout receives one scoped commit changing only the three image
   pins and generated deployment-reference inventory. Existing dependency and
   license-review metadata is preserved. The normal fast-forward push rejects
   a concurrent branch change; there is no force-push or conflict overwrite.

The build and browser workflows use matching path filters, so a normal image
build cannot silently omit its required browser check. `main` promotion never
updates `develop`, and `develop` promotion never updates `main`. Feature-branch
and manually dispatched builds remain candidates for explicit promotion,
including manual builds with `skip_tests: true`.

The promotion job uses only its repository `GITHUB_TOKEN`, with `contents: write`
and `actions: read`. The repository's branch rules must allow that scoped push.
If rules prohibit it, the job fails instead of weakening protection or falling
back to a personal token. GitHub does not start another push workflow for a
[push made with `GITHUB_TOKEN`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
preventing recursive image builds. The image pins and inventory are checked
before that generated commit is pushed; it is not a new tested runtime build.

## Appliance convergence and diagnosis

On a standard `readonly-public` host following the branch, the existing
15-minute host-convergence timer resolves the promotion commit, checks image/source
compatibility, applies Ansible and gives Flux the same commit. Flux then rolls
out the cluster Deployments; host convergence updates the console runtime while
retaining its persisted state. External GitOps installations must adopt the pins
in their owning repository. Fixed tags and commits do not move automatically.

If a source push has not appeared on an appliance, inspect these distinct stages:

- **Build:** did all three images publish successfully?
- **Promotion:** did the job write a promotion commit to the selected branch?
  Check its summary for failed CI, unavailable registry metadata, a superseded
  build, a concurrent push or branch-rule rejection.
- **Host/Flux:** has the selected promotion commit converged? A failed image/source
  check must remain a blocker; do not clear maintenance state or disable this check.
- **Live:** do the running image IDs and changed user flow match the intended build?

A superseded build makes no changes. Inspect the newer build before retrying.
For a concurrent push or branch-rule failure, review the new branch head/rules
and use the explicit promotion path below; rerunning a push job cannot bypass
the provenance or compatibility checks. An offline appliance is not verified
deployed merely because its branch contains the promotion.

## Explicit candidate promotion

For an approved feature-branch or manual build, inspect `sha-<commit>`,
`api-sha-<commit>` and `cli-sha-<commit>` together. Verify both Linux architectures
and matching source labels, then commit their **image-index** digests to the
branch tracked by the appliance:

| Component | Owning pin |
|---|---|
| Web | `magic-cluster/apps/dashboard/deployment.yaml` |
| API | `magic-cluster/apps/dashboard/api-deployment.yaml` |
| CLI/TUI | `magic-host/roles/dashboard-console/defaults/main.yml` |

Refresh the generated evidence with `python3 tools/license_audit.py --refresh-references`
without inventing new package or legal metadata. Use an isolated checkout and
commit only the intended promotion. A mutable alias or restart of an unchanged
Pod does not update any of these pins.

For normal `main`/`develop` push candidates, the helper also supports a read-only
verification mode. Supply the exact source commit and the three build-output
index digests:

```sh
python3 tools/promote_dashboard_images.py \
  --branch develop --source "$SOURCE_COMMIT" \
  --web-digest "$WEB_INDEX_DIGEST" --api-digest "$API_INDEX_DIGEST" \
  --cli-digest "$CLI_INDEX_DIGEST" --check-only
```

This requires authenticated `gh` access to Actions status and public dashboard
registry metadata. It fetches the selected Git branch but edits no worktree files
and pushes nothing. `--push` is the CI publishing mode and requires an authorized,
clean checkout; it is not a bypass for feature branches or failed checks.

An explicitly requested manual rollout may dispatch the image workflow with
`skip_tests: true`. The default is `false`; normal push builds always run tests.
A no-tests build still compiles and checks the license trust bundle, but is never
automatically promoted. Report skipped validation honestly and complete the
deferred checks separately.

## Live acceptance

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
