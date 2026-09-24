---
name: magicstick-release
description: "Prepare or review a versioned Magic Stick release: main/develop channels, immutable license dates, curated notes, relevant checks, image evidence and an optional draft GitHub release. Use for release preparation, not an ordinary commit-only request."
---

# Prepare a versioned release

Read [project instructions](../../../AGENTS.md) and the complete
[release procedure](../../../docs/development/releases.md). Select the applicable
sections of the [release checklist](../../../docs/development/release-checklist.md)
and [license audit](../../../docs/development/license-audit.md). These are canonical;
do not copy their details into another checklist or invent approval.

## Establish the boundary

Inspect branch, worktree and exact source revision. Preserve unrelated work.
`develop` is the development channel; `main` is the release/installation channel.
A merge to main is already deployment-eligible for branch-following appliances.
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
   are included. Keep development candidates out of main until release approval.
4. Report passed, failed, skipped and unavailable checks, open advisory reviews
   and any necessary user decisions. Normal reviews stay advisory; strict
   full-distribution approval is only required when explicitly selected.

## Publish only when requested

Follow [publication and rollout](../magicstick-publish-rollout/SKILL.md) for any
authorized source push, image promotion or appliance rollout. The manual draft
release workflow requires an existing main-reachable tag and successful checks
for its exact commit; it does not publish the draft or deploy an appliance.
Do not move tags, replace old assets or publish a failed/partially verified build.

Conclude with the version/commit, local checks, CI result, draft/publication status,
promoted digest and live acceptance as separate facts. Pending steps remain pending.
