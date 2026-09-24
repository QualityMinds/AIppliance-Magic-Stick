# Release channels and automation

## Main is the installation channel

All default installation paths follow **main**. Release-ready source, runtime
descriptors and immutable image promotions belong there. **develop** is the
explicit opt-in development channel. There is no automatic develop-to-main merge.
An authorized main push may start CI and is already eligible for reconciliation
by branch-following appliances; publishing a GitHub Release is not a deployment gate.

The Linux installer now retains the requested branch in its bootstrap metadata,
as the USB and Kubernetes entrypoints do. Explicit tags and commit pins remain
supported. Existing pinned installations do not silently change channels; see
[updates and rollback](../administration/updates-rollback.md#release-channels).

Create `develop` once from the agreed release baseline before enabling development
updates. This repository change alone does not create a remote branch, enable
Actions permissions, merge a release or switch an existing appliance.

Development dashboard builds publish commit-addressed images and separate
`web-develop`, `api-develop` and `console-develop` aliases. They cannot overwrite
the main aliases. Other container builders also accept develop and publish
commit-addressed candidates; AMD DRA, Mesh and FreeToken keep development aliases
separate. Companion develop builds provide CI artifacts, not published main
downloads. Promote tested digests into the descriptor on the intended
branch; do not insert mutable aliases into runtime manifests. Other image-specific
promotion workflows retain their explicit approval/provenance requirements.

## Weekly runtime image proposals

[Review runtime image updates](../../.github/workflows/runtime-image-updates.yml)
runs every Monday at **05:23 UTC**, or manually. It resolves the public supplier
tags for Odysseus, Chroma and ntfy, verifies the manifest digest and Linux/amd64
availability, and opens or updates one PR targeting `develop`. The runtime
chart consumes the immutable digests in its
[image lock](../../magic-cluster/apps/instances/odysseus/files/runtime-images.json).
The supplier's `latest` tag is only a discovery input, never a runtime reference.

The job tests the resolver, renders the chart and refreshes dependency-reference
evidence. It does **not** merge, restart services, change application data or
automatically upgrade main. Review supplier release notes and backup/migration
requirements, exercise an existing instance on develop, then promote the tested
change in a release. Digest identity is reproducibility, not compatibility proof.

One-time setup after publishing these workflow files:

1. Ensure the remote `develop` branch exists and uses this workflow/tooling.
2. Allow GitHub Actions to create pull requests in repository settings.
3. Run the update workflow manually once and inspect its proposal.
4. Approve the pending PR workflows, or run **Public release checks** manually
   on the proposal branch before merging. According to
   [GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
   PRs created/updated through `GITHUB_TOKEN` require workflow approval; their
   pushes do not recursively start push workflows. An approved GitHub App/token
   can be adopted later for unattended PR checks; no secret is bundled.

Local preview: `python tools/update_runtime_images.py`. Add `--write` to update
the lock, then run `python tools/license_audit.py --refresh-references` and the
focused tests. Network/registry errors fail the job without a partial lock update.
This initial automation covers the three previously floating application images,
not arbitrary GPU drivers, operators, model files or every third-party dependency.
Native Ubuntu security maintenance remains the separate
[host update policy](../administration/updates-rollback.md).

## Prepare a version

Use `$magicstick-release`, or follow these steps without an agent. Confirm the
version, actual first-public-distribution date, source revision and release scope.
Keep unreleased work on develop; prepare the reviewed release for main.

Write curated notes to a local Markdown file. Preview the metadata changes:

```sh
python tools/release.py prepare --version v1.2.3 --date 2026-09-24 --notes /tmp/release-notes.md
```

The values above are examples, not this project's next version or publication
date. Use the **actual** first-public-distribution date. Public source/image
distribution may precede a GitHub Release. A future or invented date is rejected
or invalid for this purpose. Add `--write` only after reviewing the preview.

The helper updates `LICENSE-RELEASE.json`, retains per-version records under
`licenses/releases/`, and inserts a curated changelog section. It calculates the
three-year Change Date using the existing license-date validator and refuses to
overwrite an existing version's dates or notes. It does not erase Unreleased notes,
approve `licenses/release-review.json`, commit, tag, push or deploy.

Run the release helper tests and applicable sections of the
[release checklist](release-checklist.md). Review remaining Unreleased notes so
they do not imply the version contains unfinished work. Existing legal/artifact
review findings remain advisory in normal CI; select the explicit strict mode
only for a full-distribution review. A technical check is not legal clearance.

```sh
python -m unittest tests.test_release tests.test_license_release
python tools/release.py check --version v1.2.3
python tools/license_audit.py --review
```

## Draft and publish deliberately

After the requested source publication and successful checks, create an immutable
version tag on the reviewed main commit. Never move an existing tag. The manual
[Prepare versioned release draft](../../.github/workflows/release-draft.yml)
workflow runs from main and takes that existing tag. It verifies main ancestry,
matching metadata/archive/changelog and successful **Public release checks** for
the exact commit, then creates a **draft** GitHub Release. Existing releases are
not overwritten. It does not publish the draft or attach unverified build assets.

Use [image promotion](image-promotion.md) and the affected artifact workflow for
the exact images/platforms being distributed. Review checksums, provenance,
notices and acceptance evidence before publishing any draft/assets. For a
dashboard release, run the [real-browser smoke](testing.md#real-browser-smoke)
and relevant live acceptance separately. An offline test appliance leaves live
acceptance pending; a green fixture test does not replace it.

Report source commit, CI, artifact publication, promoted digests and live rollout
as separate outcomes. Preparation or a source-only push must not be described
as a completed release/rollout.
