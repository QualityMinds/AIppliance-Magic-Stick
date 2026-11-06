---
name: magicstick-release
description: "Prepare or review a trunk-based Magic Stick release: main PRs, immutable product tags and license dates, curated notes, exact CI/image evidence and deliberate publication. Use for release preparation, not an ordinary commit-only request."
---

# Prepare a versioned release

Read [project instructions](../../../AGENTS.md) and the complete
[release procedure](../../../docs/development/releases.md). Select the applicable
sections of the [release checklist](../../../docs/development/release-checklist.md)
and [license audit](../../../docs/development/license-audit.md). These are canonical;
do not copy their details into another checklist or invent approval.

## Establish the boundary

Inspect branch, worktree and exact source revision. Preserve unrelated work.
`main` is the integration trunk; short-lived PRs replace a regular develop branch.
A main merge is development-deployment-eligible only for explicit branch followers.
Stable installations stay bound to a verified product tag and exact commit.
Do not merge, tag, push, dispatch publication or touch an appliance without a
request covering that operation. Preparation alone remains local.

Ask for missing release version, actual first-public-distribution date and
artifact scope. Never infer dates from today's date, rewrite old release records
or treat a draft GitHub release as first publication. Public source/images may
have been distributed earlier. Review the changelog against the implementation;
do not call an unfinished feature complete.

## Prepare and verify

1. Write curated release notes using Added/Changed/Fixed/Removed/Security as useful.
   Preview `tools/release.py prepare` before using its explicit `--write` mode.
   The tool does not approve license-review records or publish anything.
2. Inspect the generated metadata, immutable archive and notes. Run the focused
   release-tool tests, source license checks and applicable source/UI/render tests.
   Include the real-browser smoke for a dashboard release. Distinguish fixture
   tests from live login, GPU inference and upgrade acceptance.
3. Check upstream update candidates, resolved image digests, matching CI commit
   and required architectures. Never accept a mutable tag as deployment evidence.
   Read [image promotion](../../../docs/development/image-promotion.md) when images
   are included. Use a normal image-promotion PR; never bypass main protection.
4. Report passed, failed, skipped and unavailable checks, open advisory reviews
   and any necessary user decisions. Normal reviews stay advisory; strict
   full-distribution approval is only required when explicitly selected.

Review changed features against the [regression skill](../magicstick-regression/SKILL.md)
and select relevant release coverage. Distinguish newly implemented tests, isolated
results and dated live evidence for the actual source/images and hardware. Missing
or blocked variants remain visible; do not infer full acceptance from a smoke run.

## Publish only when requested

Follow [publication and rollout](../magicstick-publish-rollout/SKILL.md) for any
authorized source push, image promotion or appliance rollout. The product-release
workflow qualifies the exact final main/GitOps revision, license archive and
original image sources, then creates a new annotated tag and immutable release
only on explicit publication. The old draft-export workflow is not the product
publication path. Repository-policy changes also need explicit authorization.
Do not move tags, replace old assets or publish a failed/partially verified build.

Conclude with the version/commit, local checks, CI result, draft/publication status,
promoted digest and live acceptance as separate facts. Pending steps remain pending.
