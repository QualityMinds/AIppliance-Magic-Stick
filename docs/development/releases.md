# Trunk-based releases and automation

<a id="main-is-the-installation-channel"></a>
## Integration trunk and fixed releases

Use short-lived feature/fix branches and normal pull requests to **main**. There
is no regular `develop` integration/release branch and no automatic branch merge.
Keep unfinished behavior behind existing capability/feature controls rather than
keeping a second long-lived release line. A main merge is not a product release.

Normal fresh installations resolve **stable** to the highest verified, published
non-prerelease product tag once. They persist the version, approved commit and tag
object; Ansible and Flux use that same commit. They do not follow later tags or a
Flux semver range. Existing branch/commit installations are not silently migrated.
An administrator explicitly chooses a version in
[System → Settings → Updates](../administration/updates-rollback.md).

`main`, other branches and exact commits remain explicit development/advanced
options. An existing `develop` selection is preserved as an ordinary custom
branch, not advertised as the release channel. Old installer downloads retain
their original branch-following behavior; never relabel them as fixed media.

If no verified stable release exists, installation/version selection reports
that fact. It never falls back to main, a prerelease or a component build.

## Repository protection

`python -m tools.trunk_policy` previews the scoped policy. Only an authorized
administrator uses `--apply`. It requires main PRs, current-base public/source,
dependency and native PR CodeQL checks, resolved review threads, no force pushes
and no deletion. Independent approval is configurable with `--approvals 1`;
the owner-selected baseline is `--approvals 0` (PR plus green checks).
Required source/dependency workflows run on every main PR, including docs-only
changes, so path filters cannot leave a globally required check permanently absent.

Product `v[0-9]*` tags may be created but never updated/deleted, even by a bypass
actor. Enable immutable GitHub releases before publishing. These rules affect
future operations, not historical license dates or old release assets. The helper
adds only its two named rulesets, preserves other rules and refuses to replace a
different existing policy. Missing administration rights or organization policy
requires a real owner action, not a bypass. Settings are a separate verified
administrative outcome from merging these files.

Automatic image-pin PRs also require an explicit owner opt-in:
`python -m tools.trunk_policy --apply --allow-promotion-prs`. GitHub exposes a
combined Actions PR creation/review capability; the helper preserves default
read-only token access and the promotion workflow never approves or merges a PR.
Without this permission, create the reviewed promotion PR manually. An
organization restriction is not bypassed with a copied personal token.

## Images before tags

The sequence is: source PR → exact main build/checks → coordinated immutable-pin
PR → final exact GitOps checks → annotated product tag and immutable release →
automatic fixed-version installer build → public download verification.
See [image promotion](image-promotion.md#automatic-promotion).

Dashboard Web/API/CLI are one tested AMD64+ARM64 source set; the runner is a
tested AMD64 source. Image sources and the later pin commit are different facts.
No runtime container image is rebuilt or repinned after the product tag. A content-proven pure-pin
merge verifies the original image/native publishing evidence instead of starting
a recursive build/promotion loop. Package identities and legal decisions remain
unchanged when refreshing generated deployment references.

## Feature-branch appliance testing

Use a trusted explicit feature branch only on an authorized disposable appliance.
The existing check/apply host-operation workflow, idle/recovery fencing and
management contract still apply. A branch executes host automation, not just a
dashboard build. Manual image candidates require matching tested digests and
explicit promotion; `skip_tests: true` is never product-release qualification.
No fixture test proves installed login, GPU inference or upgrade compatibility.

## Prepare a version

Confirm the exact version, actual first-public-distribution date and artifact
scope with the release owner. Public source/images may predate a GitHub Release;
today's date or a draft is not proof of first distribution. Do not invent a date
or change old per-version archives. Product tags are `vMAJOR.MINOR.PATCH` or an
explicit prerelease such as `v1.2.3-rc.1`; installer/mesh component tags are separate.

Write curated notes and preview (values below are synthetic examples):

```sh
python tools/release.py prepare --version v1.2.3 --date 2024-02-29 --notes /tmp/release-notes.md
```

Add `--write` only after reviewing the preview. The helper updates the matching
`LICENSE-RELEASE.json`, immutable `licenses/releases/<version>.json` and curated
changelog section. It retains Unreleased notes and refuses different bytes for an
existing version. Publish the preparation through a normal main PR, build/promote
its matching images and qualify the final pin commit before tagging.

The canonical [LICENSE](../../LICENSE) and [LICENSING.md](../../LICENSING.md) remain
authoritative: owned source is BUSL-1.1 with that version's real publication date
and three-year MIT Change Date. Repackaging does not restart that clock. Referenced
or redistributed third parties keep their own licenses and mandatory notices.
Version discovery/install/update does not require a product entitlement, grant
one, create editions or change the existing Federated SSO entitlement boundary.

Run `python tools/license_audit.py --check` and `--review`, plus the applicable
[release checklist](release-checklist.md). Normal manual legal/artifact reviews
remain advisory, explicitly visible and never fabricated. Strict complete-
distribution review is the separate opt-in `--release`/`strict_release_review`.
Source/notice/date consistency, secrets and required technical checks stay strict.
Retain artifact-specific SBOMs, source offers and native/installer acceptance
evidence beyond CI retention. A source/manifest bundle is not approval of every
third-party component in a preinstalled appliance.

## Draft and publish deliberately

Run [Qualify and publish product release](../../.github/workflows/product-release.yml)
from main with the exact final revision and prepared version. Its default
`publish: false` retains the manifest, curated notes and mandatory license assets
only. It requires current successful exact-main public, browser, dependency,
license and runner checks and the independent **Release CodeQL acceptance** job.
The latter checks the latest managed native CodeQL attempt, all four exact-commit
language analyses and zero open CodeQL findings on the unchanged main head.
GitHub's job response can also contain standalone integration checks. Only exact
project/source/run-bound native job URLs count as language executions; successful
standalone check URLs with no execution steps do not become a fifth language.
The complete response and four unique expected native jobs are still required.
Failed, skipped, pending, duplicated or unattributable rows block acceptance.
Native PR CodeQL alone is not a post-merge acceptance result; uploads alone do
not prove that findings passed. Newer failed/pending attempts cannot inherit old
green results. Unexplained skips, missing permissions and partial data fail closed.

The tool anonymously verifies registry index/platform/config hashes and source/
component/project labels, without downloading image layers or storing pull tokens.
The manifest records the exact GitOps revision, image-source/digest/platform
identities, license record and CI identities. Prepared files are not overwritten.

Only an explicitly approved `publish: true` run, through the `product-release`
environment, creates a **new annotated tag**, uploads all reviewed assets to a
draft, verifies their SHA-256/size and tag identity, then publishes immutably.
The release identity needs repository Administration read (immutability preflight),
Contents write and read access to Actions/checks. Use the repository token where
allowed, otherwise an approved narrowly scoped identity in the environment secret
`PRODUCT_RELEASE_TOKEN`. Never paste tokens into Git or logs. Missing access stops
before tag creation; the workflow does not change permissions or suppress checks.
Product publication alone is not completed release delivery. The mandatory next
step dispatches the installer workflow on that exact product tag, using only
the job-scoped built-in token's Actions-write permission, then verifies the
public image, checksum, build metadata and evidence bytes. It does not need a
new personal token or a `release` event to trigger another workflow.

### Owner-operated publication with an existing GitHub login

An explicitly authorized release owner can use the same canonical tool from a
trusted computer already signed in through `gh`. No new token is needed when
that existing identity has the same required repository permissions. Do not
extract the login credential, copy it into Actions or create a broader bypass.

Use a clean checkout of the exact reviewed final main commit. Set
`RELEASE_REVISION` to that full commit and choose a new private output directory:

```sh
RELEASE_ASSETS="$(mktemp -d)"
python tools/product_release.py --prepare --version v1.2.3 \
  --revision "$RELEASE_REVISION" --output-directory "$RELEASE_ASSETS"
```

Review the six prepared files and remaining advisory license warnings. Only with
explicit publication approval, use the same directory and exact identity:

```sh
python tools/product_release.py --publish --version v1.2.3 \
  --revision "$RELEASE_REVISION" --output-directory "$RELEASE_ASSETS"
```

This retains the immutable-settings preflight, current exact-main CI, original
native image/source/hash proofs, mandatory license assets and no-replacement
guards. It is an owner-operated publication, not a successful Actions publish
job. The Actions workflow does not inherit the owner's workstation login; its
additional Administration-read requirement remains a separate automation setup.
The default `--publish` command also waits for verified installer delivery.
`--product-only` is the Actions first stage, not a completed release: the workflow
must run the following completion step with its own built-in dispatch access.

Tags/releases/assets are never replaced. GitHub's separate tag/draft/upload/publish
requests are not atomic: after a partial failure inspect the exact existing
objects and recover deliberately; do not blindly rerun or delete/recreate a tag.
The older [draft export](../../.github/workflows/release-draft.yml) remains a
legacy notes-only tool, not a selectable product publication path.

## Installer delivery is part of release completion

The product tag is visible before its installer because the installer verifies
the already published product identity. This is an intentional two-stage process,
not an atomic publication. The release workflow/owner command reports delivery
complete only after the automatic [installer pipeline](installer-images.md)
finishes successfully and all four permanent public downloads pass size/SHA-256
checks, including a full streamed image download. Product/tag/source/run and
original license identities must match. Missing, failed, cancelled, timed-out,
action-required or unexpectedly skipped jobs prevent completion; an older green
attempt cannot replace them. Verified identical media can be reused without a
new build. An observation timeout does not cancel or restart the original build.

The installer publishes a separate immutable `installer-v…-…` component release.
Completion appends verified download links to the product's editable release
body, preserving existing notes and locked tag/assets. It never replaces the
original `release-notes.md` asset, repins runtime images or changes license dates.
The USB guide deliberately pins a verified baseline; it does not guess the next
image URL. No automated build proves VM, USB, Wi-Fi or GPU installation acceptance.

If delivery fails after product publication, leave the product intact and inspect
the exact installer run. After an authorized correction/recovery, resume from a
clean checkout of the same product commit, rather than republishing the product:

```sh
python tools/release_delivery.py complete --version v1.2.3 --revision "$RELEASE_REVISION"
```

The read-only `verify` operation checks existing public media without dispatching
or changing release notes. Legacy versions without tag-dispatch support require
the reviewed manual main workflow with `product_version`; they are not blindly
redispatched through an incompatible old tag. The v1.0.0 baseline was published
and publicly byte-verified on 9 November 2026; its original product source and
six locked release/license assets remain unchanged.

## Weekly runtime image proposals

[Review runtime image updates](../../.github/workflows/runtime-image-updates.yml)
discovers public Odysseus/Chroma/ntfy supplier versions, verifies immutable digests,
runs focused tests/renders and refreshes generated references. Its optional normal
PR targets main. Without parent-policy permission/`RUNTIME_IMAGE_PR_ENABLED=true`,
it retains the validated patch for human review instead. It never merges itself,
deploys a device, changes legal approvals or silently installs supplier `latest`.
Revalidate an older proposal against the current trunk; do not overwrite newer work.

Always report source publication, CI, artifact publication, pin promotion and
actual host/Flux/image/browser/hardware acceptance separately. Offline devices and
blocked prerequisites remain unverified, not successful releases or rollouts.
