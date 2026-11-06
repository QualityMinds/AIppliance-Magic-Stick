# Dashboard image promotion

### Dashboard image promotion

Runtime manifests use immutable digests, never mutable registry aliases. Main is
the integration trunk. A source merge/build is neither a stable release nor a
verified appliance rollout. Normal fresh installations stay on their selected
[product release](releases.md), not main.

## Automatic promotion

1. Main source builds run native tests before publishing the coordinated Web/API/
   CLI AMD64+ARM64 images and AMD64 regression runner. Manual branch candidates
   remain explicitly requested; skipped tests never qualify a product release.
2. **Propose tested image promotion PR** observes trusted same-repository main
   push completions. `tools/trunk_promotion.py` requires current successful public
   checks, matching browser checks when a dashboard build exists, native testing/
   publishing steps and anonymous registry hash/platform/source-label verification.
   Missing/pending evidence waits without writing; a newer failed attempt is not
   replaced with an old green result. A newer runtime/policy source supersedes an
   obsolete candidate.
3. The helper starts from the current main head and changes only canonical Web,
   API, CLI and runner pins plus generated deployment references. Package identities,
   licensing decisions and unrelated changes are retained. It opens a normal
   `codex/promote-images-…` PR to main, never pushes main or merges itself.
4. Normal current-base PR checks and review remain required. If GitHub requires
   approval for repository-token-created PR workflows, approve them normally or
   use an approved PR identity; there is no protection bypass, personal-token
   fallback, auto-merge, force push or suppressed check. A branch already present
   without one matching open PR requires inspection, not an overwrite.
5. After merge, a content proof recognizes a pure-pin/reference delta. It proves
   canonical replacements and unchanged package/legal fields, not a bot identity
   or commit message. The runner job verifies pinned image hashes/source consistency
   and the original successful native publishing steps. Dashboard rebuilding is
   explicitly skipped for this proven case. The promotion coordinator does not
   treat that merge as a new image source: no recursive build/pin loop.

The final pin commit still needs its own public, security, license, browser and
release-acceptance evidence before a product tag is published. Original image
source and later GitOps/promotion revision are always reported separately.
Legacy direct-main promotion entrypoints are disabled; they are not a workaround
for branch protection or missing CI. Feature-branch pins remain explicit, scoped
publication within separately granted authority.

## Appliance convergence and diagnosis

On a standard `readonly-public` host following the branch, the existing
15-minute host-convergence timer resolves the promotion commit, checks image/source
compatibility, applies Ansible and gives Flux the same commit. Flux then rolls
out the cluster Deployments; host convergence updates the console runtime while
retaining its persisted state. External GitOps installations must adopt the pins
in their owning repository. Fixed tags and commits do not move automatically.

On registered regression labs, host convergence first reserves the existing
test Lease and refuses active/queued test or cleanup runs and any held test
Lease. It renews that reservation through the actual Flux rollout, then releases
only its own UID-bound reservation. Failed or unverified convergence keeps the
lab fenced: inspect `ansible-pull.service` and Flux readiness before host recovery;
the test cleanup button never clears a host maintenance reservation.

If a source push has not appeared on an appliance, inspect these distinct stages:

- **Build:** did all three images publish successfully?
- **Promotion:** was the normal tested pin PR reviewed and merged to main?
  Check its summary for failed CI, unavailable registry metadata, a superseded
  build, a concurrent push or branch-rule rejection.
- **Host/Flux:** has the selected promotion commit converged? A failed image/source
  check must remain a blocker; do not clear maintenance state or disable this check.
- **Live:** do the running image IDs and changed user flow match the intended build?

A superseded build makes no changes. Inspect the newer build before retrying.
For repeated concurrent pushes or a branch-rule failure, review the new branch
head/rules and use the explicit promotion path below; rerunning a push job cannot bypass
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

For normal main push candidates, the legacy helper also supports a read-only
verification mode. Supply the exact source commit and the three build-output
index digests:

```sh
python3 tools/promote_dashboard_images.py \
  --branch main --source "$SOURCE_COMMIT" \
  --web-digest "$WEB_INDEX_DIGEST" --api-digest "$API_INDEX_DIGEST" \
  --cli-digest "$CLI_INDEX_DIGEST" --check-only
```

This requires authenticated `gh` access to Actions status and public dashboard
registry metadata. It fetches the selected Git branch but edits no worktree files
and pushes nothing. Direct `--push` to main is disabled. Use the coordinated
normal PR workflow, not a branch-protection or failed-check bypass.

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
