# License and distribution audit

This is an engineering inventory and release-review record for the current source
tree. It is **not a legal opinion or permission to publish**. In particular, the
existence of a license name, separate container or SBOM does not by itself clear
a distribution. The unresolved items below are tracked in
[`licenses/release-review.json`](../../licenses/release-review.json). They are
**advisory in normal CI and image publication**, not a global release veto.
Source consistency, mandatory notices, secret checks and artifact-specific
build requirements remain enforced. The optional strict full-distribution
review is available separately; no open item is automatically marked approved.

## Scope and evidence

The source scan covers tracked files and non-ignored new files, owned package
metadata, runtime entitlements, build paths and release-date metadata. The
[`dependency-inventory.json`](../../licenses/dependency-inventory.json) records all
157 packages in the frozen pnpm lockfile, installed license metadata where
available, the audit Python environment and deployment/build references.
Platform-specific npm packages that are not installed locally are explicitly
`lock-only`, not cleared. The inventory checksums both the pnpm lockfile and the
deployment/build references; dependency changes invalidate the saved inventory.
It is not a complete container, Helm or installer SBOM. The recurring workflow
below extends it with actual artifact scans and retains unresolved coverage.

Primary BSL references are the [MariaDB license text](https://mariadb.com/bsl11/),
[licensor FAQ](https://mariadb.com/bsl-faq-adopting/) and
[SPDX BUSL-1.1 record](https://spdx.org/licenses/BUSL-1.1.html). The unmodified
Terms/Covenants/Notice are in `LICENSE`, after the project parameters. BSL permits
redistribution and resale. The Additional Use Grant therefore limits specified
**production uses**, not mere redistribution. The MIT conversion applies to
each version three years after its actual first public distribution. An absent
or incorrect metadata record cannot reset that clock.

## Component assessment

“Redistributed” below describes repository-built outputs and appliance delivery,
not merely the presence of an image URL in a manifest. When an operator pulls an
image directly from upstream, Magic Stick's source repository only references it.
Mirroring, preloading or distributing a USB/appliance changes that assessment.

| Component/version | License evidence | Use / redistributed | Obligations and assessment |
|---|---|---|---|
| Magic Stick-owned source | BUSL-1.1, parameters in `LICENSE` | Source, web/CLI/API, adapters and automation / yes | Retain license and per-version date record. Additional Use Grant, commercial agreement and contributor ownership **require legal review**. |
| React/react-dom 19.2.8, scheduler 0.27.0, TanStack Query 5.102.8, zod 4.5.4 | Original installed MIT texts in `licenses/third-party/npm.txt` | Browser/CLI dependency closure / yes | Preserve copyright and license in distributed bundles. Collector checks the installed frozen dependency closure. No copyleft requirement identified in these six texts. |
| PyJWT 2.13.0 | [MIT](https://pypi.org/project/PyJWT/2.13.0/) and installed text | API/Mesh/companion / yes | Include original MIT notice. No production signing key is shipped. |
| cryptography 50.0.1 | [Apache-2.0 OR BSD-3-Clause](https://pypi.org/project/cryptography/50.0.1/), installed license texts | API/Mesh/companion / yes | Preserve upstream notices. Wheels/native OpenSSL dependencies have separate terms and require final-artifact inspection. |
| cffi 2.1.1, pycparser 3.0 | Installed MIT-0 / BSD-3-Clause texts | Resolved Python dependencies / yes where installed | Preserve notices. Do not assume one platform's wheel inventory describes every target. |
| MeshLLM v0.76.2, openai-endpoint v0.2.0 | Upstream Apache-2.0 license retained by recipes | Patched native transport and endpoint process / yes | Preserve LICENSE/NOTICE and modification notices. Audit exact Cargo lock resolution, linked native libraries and the combined distribution. OpenAI endpoint plugin is not part of the companion. |
| PyInstaller 6.22.3 | [GPL-2.0-or-later with exception](https://pyinstaller.org/en/stable/license.html) | Packaging tool and bootloader / bootloader yes | Exception permits application licensing under different terms when its conditions hold. Retain exception and notices. Changes to PyInstaller itself and each bundled dependency must be reviewed independently. |
| Python 3.13, Node 24, nginx 1.27.5, Alpine/Debian base packages | PSF, MIT, BSD-like nginx and package-specific licenses | Base runtimes / yes | Full base-image SBOM and retained package copyright/license/source records required. Project OCI labels are not a complete combined image license. |
| LiteLLM v1.101.0 | [Root LICENSE](https://github.com/BerriAI/litellm/blob/v1.101.0/LICENSE) excludes its `enterprise/` tree from MIT | Separate proxy/UI image / referenced, yes if mirrored/preinstalled | **Do not classify the entire image as MIT.** Keep to authorized code/features. The direct upstream image reference is not bundled into the Dashboard and does not block its publication. Review the actual image and redistribution terms if mirroring, preloading or shipping an appliance. |
| Ollama 0.33.2 | [MIT](https://github.com/ollama/ollama/blob/v0.33.2/LICENSE) | Separate model runtime / referenced | Keep project notices and audit GPU/native dependencies and each model's terms. MIT engine terms do not license model weights or drivers. |
| vLLM 0.23.0 / 0.26.0 / 0.29.0 | [Apache-2.0 project license](https://github.com/vllm-project/vllm/blob/v0.23.0/LICENSE); exact tags in manifests | Separate model runtimes / referenced | Inspect each CUDA/ROCm/XPU image, license/NOTICE, source modifications and model licenses. No blanket approval of all image contents. |
| vLLM-Omni pinned `f3f8ebfc…` | Apache-2.0 project license, pinned source/hash-guarded repair | CUDA image referenced; ROCm recipe and runtime source repair | Preserve upstream notices and identify modifications. FFmpeg, espeak-ng, TorchCodec, Pycairo and native libraries require exact build/codec/linkage review. Pycairo 1.28.0 is LGPL-2.1-only OR MPL-1.1. |
| FreeToken 0.1.3 | [Apache-2.0](https://github.com/FlashML-org/FreeToken/blob/v0.1.3/LICENSE) | Custom GPU runtime image / yes | Include upstream license and BSL adapter notice. Review resolved Python/native/CUDA dependencies, EULA redistribution list and final SBOM before publishing. |
| Keycloak 26.6.3 | [Apache-2.0](https://github.com/keycloak/keycloak/blob/26.6.3/LICENSE.txt) | Separate identity service / referenced | Retain notices. Magic Stick's Federation entitlement does not change Keycloak's license. Audit image dependencies. |
| Kubernetes/K3s/containerd/Flux/Envoy and charts | Project Apache-2.0, package-specific transitive terms | Separate infrastructure / referenced and installed | Preserve exact chart/source/license versions and notices. Audit shipped binaries/images, not only project headings. |
| NVIDIA/AMD/Intel operators | Operator project terms, exact versions in `THIRD_PARTY_NOTICES.md` | Separate controllers and drivers / referenced | An open-source operator does not grant redistribution rights for proprietary drivers, firmware or CUDA. Inspect vendor EULAs and each installed package. |
| AMD DRA v1.0.1 and Paperclip operator 0.18.0 patches | Apache-2.0 upstream source; explicit Apache headers in contributed test/patch files | Rebuilt third-party controllers / yes | Retain upstream licensing and changes. Do not blanket-relabel adapted patches as BSL. Exact Go/native dependencies and patched-image notices remain a release review. |
| kdns `f956ab5…` plus Gateway patch | Pinned README explicitly declares MIT; linked LICENSE is empty | Rebuilt Go binary / yes | **MIT declaration confirmed; notice evidence incomplete.** The build accepts the verified README declaration and retains the evidence with a warning. Complete copyright/license text remains an open follow-up, not an automatic build veto. Do not invent attribution or classify the project as having no declared license. |
| Odysseus `latest` | [MIT plus adapted-code acknowledgments](https://github.com/pewdiepie-archdaemon/odysseus/blob/main/ACKNOWLEDGMENTS.md) | Separate application / referenced | Mutable version and copied-source/asset dependencies require pinning and review. Retain opencode, llmfit, DeepResearch and asset notices. |
| SearXNG `2026.5.31-7159b8aed` | [AGPL-3.0](https://github.com/searxng/searxng/blob/master/LICENSE) | Odysseus HTTP service / referenced | Preserve license and corresponding source. Modified network service requires source access for remote users. Review whether any integration creates a combined work. Separate process is relevant evidence, not automatic clearance. |
| Chroma/ntfy `latest` | [Chroma Apache-2.0](https://github.com/chroma-core/chroma/blob/main/LICENSE), [ntfy Apache-2.0](https://github.com/binwiederhier/ntfy/blob/main/LICENSE) | Odysseus HTTP/notification services / referenced | Pin resolved images and preserve licenses/NOTICE. Upstream branch evidence does not identify immutable deployed contents. |
| Paperclip/Hermes/OpenClaw/KubeOpenCode/AnythingLLM/Qdrant and additional charts | Inventory and exact references in `THIRD_PARTY_NOTICES.md` | Optional applications / referenced, yes if preloaded | Full source/image/dependency and commercial carve-out review pending. Do not infer licenses from a related project or controller. |
| Ubuntu 26.04, Linux, GNU utilities, BusyBox, Ansible and community.general 13.2.0 | Package-specific GPL, LGPL, permissive and other terms | Installer/host software / yes on USB or appliance | Preserve notices and provide exact corresponding sources as applicable. Record package versions/source URLs and build scripts. These components remain under upstream terms. |
| Marketing images, screenshots, SVGs, PPTX/PDF and fonts | Local assets, source references in deck notes | Website/documents / yes | Verify creator/source/brand and embedding rights. Updating marketing text is not proof of asset ownership. Unclear provenance concerns the affected collateral, not unrelated runtime images. |
| Model weights/tokenizers/configs | Repository-specific model terms | Downloaded at runtime / not bundled in standard source | Review before preloading model caches or distributing weights. Do not infer rights from Hugging Face availability or the serving engine license. |

## Special license families

| Family | Finding and treatment |
|---|---|
| AGPL | Present through SearXNG. Source, modification and network-access obligations need artifact-specific review. A service boundary is not a blanket exception. Do not copy AGPL source into BSL files. |
| GPL | Present in installer/host/build components, including PyInstaller. Separate executables may be aggregates, but derived/linked combinations and bundled source offers need review. Retain the PyInstaller exception. See [GNU FAQ](https://www.gnu.org/licenses/gpl-faq.en.html). |
| LGPL | Relevant to native/base-image and media dependencies. Determine static/dynamic linkage, modifications, relinking/replacement rights and corresponding source for each binary. A generic source URL is not a complete compliance package. |
| MPL | `lightningcss` 1.33.0 is MPL-2.0 build tooling. Pycairo offers MPL-1.1 as one option. If MPL-covered code/files are distributed, preserve notices and source access for those files. Keep them separate from BSL-owned files. See [Mozilla FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). |
| SSPL | Not identified in the inspected installed npm/Python closure. Unresolved images are **not cleared**. Any hit requires service-source scope review or replacement before distribution. |
| Elastic License | Not identified in the inspected closure. If a resolved artifact contains it, inspect managed-service and license-key restrictions independently; no default approval. |
| Commons Clause | Not identified in the inspected closure. Any hit changes commercial distribution analysis despite a permissive base license. Requires legal review or replacement. |
| PolyForm | Not identified in the inspected closure. Different variants impose different purpose/use restrictions. Any hit requires exact-variant review; no inference from the family name. |
| BSL | Magic Stick uses BUSL-1.1. Any third-party BSL work has its own grant/change date/license and cannot inherit Magic Stick's grant. |
| MIT/BSD/ISC/MIT-0/Apache | Original notices and license texts must survive bundling. Apache also requires applicable NOTICE retention and change marking. Permissive project terms do not clear trademarks, proprietary assets or separately licensed subtrees. |
| BlueOak/CC0 | `lru-cache` 11.5.2 / `mdn-data` 2.27.1 in the build tree. Preserve declared license evidence and any applicable notices. Track whether their contents enter shipped output. |

## kdns evidence, checked 2026-09-23

The user's README screenshot is confirmed by the actual
[pinned README](https://github.com/lab42/kdns/blob/f956ab5d35564ee84e58ba155e78a17423cc835b/README.md):
kdns explicitly declares **MIT**. The corresponding
[LICENSE](https://github.com/lab42/kdns/blob/f956ab5d35564ee84e58ba155e78a17423cc835b/LICENSE)
is zero bytes. The current main file is also empty; its history has only the
initial empty-file commit. These facts are compatible: the declaration exists,
but the linked full notice was not supplied. The outstanding question is notice
completion/attribution for redistribution, not whether the README names MIT.

[`upstream-evidence.json`](../../licenses/upstream-evidence.json) retains the exact
revision, file sizes, SHA-256 hashes, declaration and build binding. CI verifies
those immutable sources and detects a changed build pin, missing declaration,
different content or network failure. A separate watch of the main-branch
LICENSE flags a newly supplied notice for manual review; it does not change
the pinned build or approve a release. The check never generates copyright text
or silently promotes this finding to an approved release gate.

The image recipe accepts a nonempty upstream `LICENSE` or the exact verified
MIT declaration in `README.md`. An empty or missing `LICENSE` alone no longer
stops the build. That fallback emits a warning and retains it as
`MAGICSTICK-NOTICE.txt` beside the supplied README/LICENSE and source revision
under `/usr/share/licenses/kdns/`. It does not synthesize an upstream notice or
copyright holder. If neither evidence source is present, the build fails.
`tests/test_license_kdns.py` exercises the actual shell block from the recipe,
including both successful paths and missing/irrelevant declaration failures;
the image, release-check and weekly audit workflows run these tests.

The pinned source's dependency scan is retained in
[`kdns-dependency-evidence.json`](../../licenses/kdns-dependency-evidence.json):
58 Go module records have license metadata (56 ordinary notice reviews and
two compound-expression reviews). The other 14 records are upstream CI action
references without scanner-provided license metadata, not unknown Go runtime
packages. This narrows the outstanding kdns issue to the project's complete
notice and final-binary/source-distribution review; it does not approve either.

## Recurring CI and artifact evidence

[`license-audit.yml`](../../.github/workflows/license-audit.yml) runs on relevant pull
requests, every push to main, manual dispatch and **Mondays at 04:23 UTC**.
It uses read-only repository permissions, no publishing credentials, and
checksum-verified **Syft 1.52.0** for both supported runner architectures.
The dependency install starts inside `dashboard/` so Corepack uses the pinned
`packageManager`, not its global default. Release checks do not persist checkout
credentials; secret-scan diagnostics show only file, line and detector names.
The sole kdns token false-positive exception matches its exact public commit
identity line in the evidence file, and only the Sourcegraph detector.

The jobs perform:

1. Source/SPDX/entitlement/release-record checks, frozen dependency inventory,
   original npm notice comparison, and immutable kdns evidence verification.
2. SPDX, CycloneDX and Syft JSON inventories of the source tree and the pinned
   kdns, AMD DRA, Paperclip operator, MeshLLM, openai-endpoint and FreeToken
   upstream trees. Upstream code is scanned, not executed. Registry enrichment
   uses the resolved package versions; it does not supply distribution approval.
3. Fresh API, Web and CLI container builds and final-image inventories on
   **linux/amd64 and linux/arm64**. These images are not published by this job.
4. A review summary that reports open approvals and incomplete publication-date
   records as warnings. Failed scans and source errors still fail the job.
   Manual dispatch can enable `strict_release_review` (default **false**) to
   require the complete approval/date checklist for an explicit distribution
   review. Scheduled and push runs do not enable it.

Artifacts are retained for 30 days, including on failures. Release owners must
archive the exact release evidence longer-term; a CI retention period is not a
source-offer period. The reports preserve exact license expressions, including
`OR`, `AND` and `WITH`; the triage does not choose a convenient branch or remove
an exception. Missing evidence, custom/restricted licenses and copyleft are
reported separately from ordinary notice review. The scanner never edits
`release-review.json` or grants approval.

Local pre-publication image scans on 2026-09-23 found:

| Artifact | Platform | Packages | Copyleft review | Missing license metadata |
|---|---|---:|---:|---:|
| Dashboard API | linux/arm64 | 41 | 14 | 8 |
| Dashboard Web | linux/arm64 | 68 | 20 | 0 |
| Dashboard CLI | linux/arm64 | 165 | 12 | 1 |

Exact scanned image identities and package findings are in
[`artifact-evidence.json`](../../licenses/artifact-evidence.json). These are local
test images, not approved or published release digests. Examples requiring
review are Alpine/BusyBox GPL notices and sources, gdbm/readline GPL, and mixed
MPL/GPL/LGPL expressions. The missing records include a virtual APK dependency
group and packaged Python/Node/launcher binaries; missing scanner metadata is
not evidence that those programs have no license. Their retained upstream
notices and exact corresponding sources still need artifact-specific review.

**Remaining coverage:** this automation does not yet prove every native GPU
image, Helm chart's transitive images, downloaded driver/firmware, installer ISO,
OS package source offer, packaged companion on every platform, model cache or
marketing asset. Source lock scans are not final Rust/Go binary linkage audits.
The six browser/CLI production libraries remain covered by the separate exact
npm-notice collector because a minified bundle scan can miss them. Unscanned
items remain visible review work, not automatic blockers for unrelated images;
there is no blanket full-distribution clearance.

The enriched source scan identified 213 package records. Its 52 records without
license metadata were GitHub Actions references (including the repository's
local action), not 52 unexplained runtime dependencies. Build-tool usage and
redistribution scope must be assessed separately. CI action tags are not a
substitute for immutable release artifact identities.

## Ownership and SPDX strategy

Owned source uses `BUSL-1.1` in package metadata and existing SPDX headers. Files
without a per-file header are covered by the root LICENSE unless a specific
third-party notice applies. JSON/YAML are not given invalid comment headers.
Original third-party license texts, copied/adapted patch context and explicit
upstream contribution licenses are not replaced. The root scope explicitly
excludes third parties. Contributor rights and ambiguous source provenance need
owner/legal sign-off; a search cannot establish them.

The remaining word `Community` in contribution governance, Ansible collection
names or Hugging Face publishers is not an edition. `Enterprise Wi-Fi` denotes
802.1X authentication. `enterprise/` in the LiteLLM audit identifies its upstream
license exception, not a Magic Stick source package. MIT references concern the
future Change License or retained third-party licenses.

## Open reviews and artifact-specific constraints

1. **requires legal review:** approve the Additional Use Grant, commercial
   contract, group threshold/forecast and per-version date mechanism. Obtain
   contributor/asset ownership evidence. Pure redistribution cannot be made a
   forbidden BSL use by adding a contradictory grant.
2. **kdns notice follow-up:** the verified README MIT declaration is accepted
   as build evidence. Obtain the complete upstream copyright/license notice
   for the exact source; its absence remains a visible warning rather than an
   automatic build veto. DNS is not disabled and no legal approval is inferred.
3. **Final artifact audit pending:** produce and review per-platform image,
   installer and companion SBOMs, license texts, source packages/offers and
   proprietary EULAs. Pin mutable optional-service artifacts. Resolve LiteLLM's
   excluded subtree and AGPL/media/native-library obligations. Possible
   alternatives are clean authorized builds or separately operated services,
   subject to their own review.
4. **Asset provenance pending:** textual collateral matches the BSL model, but
   asset/font/trademark rights still need evidence. Replace unclear assets with
   verified-owned or properly licensed material if evidence cannot be obtained.
5. **Appliance acceptance pending:** local login/recovery, broker-route denial on
   license expiry/API outage, external provider disablement, and license-free Sharing/Mesh need testing against
   the final approved images. Unit and browser fixture tests do not prove this.

`python tools/license_audit.py --check` validates source consistency.
`python tools/license_audit.py --review` is the normal image/client CI path:
source errors fail; open review/date records are printed and retained in the
Actions summary without blocking publication. Referenced-only upstream images
do not become bundled dependencies just because the installer deploys them.
Mirroring, preloading or shipping a configured appliance must be assessed as
its own distribution scope. The kdns recipe accepts its verified README MIT
declaration when the upstream LICENSE is empty or missing, retains the evidence
and warns about the open notice follow-up. It fails only when neither a nonempty
LICENSE nor the verified declaration is available.

`python tools/license_audit.py --release` is an **explicit, optional strict
review** that also fails on missing approval/evidence/date records. No normal
publication workflow invokes it. Neither mode invents approval, changes dates
or waives upstream terms. A green technical workflow is not legal clearance.
See the
[release checklist](release-checklist.md) for the complete procedure.
