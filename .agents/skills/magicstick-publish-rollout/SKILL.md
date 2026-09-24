---
name: magicstick-publish-rollout
description: "Carry out requested Magic Stick commit/push, GitHub Pages publication, container promotion or appliance rollout, with separate evidence for each stage. Not a trigger to publish ordinary implementation work."
---

# Publish and roll out

Read [project instructions](../../../AGENTS.md). Determine the requested outcome
before selecting a path; do not turn a commit-only request into a live deployment.

| Requested outcome | Procedure and stopping point |
|---|---|
| Commit/push | Review the intended diff and relevant checks, commit the requested scope, push the requested branch, verify the remote revision and remaining worktree/ahead-behind state. Do not dispatch builds or promote images unless requested. |
| Static website/Pages | Read [documentation publication](../../../docs/development/documentation.md#ci-and-publication) and [website checks](../../../docs/development/website.md#preview-and-checks); verify the matching Pages workflow and served content. This does not update the appliance. |
| Container publication/appliance rollout | Read [dashboard image promotion](../../../docs/development/image-promotion.md) for dashboard/API/CLI images, or the affected image workflow and runtime manifest for another component. Verify source build, immutable promotion and live acceptance separately. |
| Versioned distribution/release review | Select applicable sections of the [release checklist](../../../docs/development/release-checklist.md) and [license audit](../../../docs/development/license-audit.md). A strict full-distribution review is opt-in, not implied by an ordinary push. |

## Source publication

Check the current branch, remote, diff and existing user changes. Commit only the
requested scope; "all" includes all reviewed intended changes, never credentials
or ignored local caches. Do not force-push, rewrite history or fold unrelated
remote work into a conflict resolution without authority.

Use relevant local checks and the redacted public-safety scan. If checks were
explicitly deferred, record them as skipped, not passed. Do not silently disable
CI. Normal CI triggered by an authorized push may publish Pages/images; inspect
and report only the stages relevant to the user's request.

## Image and live acceptance

A source build or mutable tag does not replace a deployment's pinned image. Match
builds to the source commit, inspect required architectures, promote immutable
image-index digests in the owning manifests and verify the tracked revision.
For the dashboard, promote coordinated Web/API/CLI images as the canonical guide
requires; do not restart an unchanged Pod as an image update.

For an authorized rollout, verify Flux source/applied revision, relevant Helm and
Deployment conditions, configured digests, running Pod image IDs and health.
Check the changed user flow under the intended role. Retain existing workloads
unless their restart/change is part of the rollout. UI-only rollout does not
require GPU probes, model downloads or a computer restart.

If CI fails, the image is missing, the target is ambiguous or the appliance is
offline, stop at the last verified stage and report the concrete gap. Diagnose
within scope rather than retrying destructive actions or bypassing gates. An
offline appliance may reconcile when it returns only after the required promoted
manifests are on its tracked branch; that expectation is not live verification.

## Completion report

State the source commit/branch and push result; CI/build result; promotion commit
if any; live revision/image/behavior evidence when checked; and remaining gaps.
Do not imply unrequested stages ran. Keep advisory license findings visible
without inventing approval or turning them into unrelated release blockers.
