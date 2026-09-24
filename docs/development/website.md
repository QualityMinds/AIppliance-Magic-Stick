# Marketing website maintenance

The public marketing site uses plain HTML, CSS and a small progressive-enhancement
script. English is the default; German is an explicit language choice. The combined
Pages build places these pages at the site root and the canonical English Markdown
handbook under `handbook/`. There is no application server, remote font service,
build-time frontend framework or analytics dependency. The appliance dashboard is
a separate application and is not changed by website updates.

Follow [documentation maintenance](documentation.md) for the combined build, CI
and the one-time switch of the Pages source to GitHub Actions.

## Sources and structure

| Source | Purpose |
|---|---|
| [index.html](../index.html) | English product homepage |
| [de.html](../de.html) | Equivalent German homepage; handbook links are marked English |
| [editions.html](../editions.html), [editionen.html](../editionen.html) | Licensing overview, eligibility and the actual request/activation workflow |
| [site.css](../site.css) | Responsive dashboard-aligned navy/cyan/violet design, system fonts, visible focus and reduced motion |
| [site.js](../site.js) | Mobile navigation and keyboard-accessible product tabs |
| [assets/favicon.svg](../assets/favicon.svg) | Small self-contained site mark |
| [legal-notice.html](../legal-notice.html), [privacy.html](../privacy.html) | Existing English legal content, unchanged by this redesign |

The homepage moves from the product definition through a three-step workflow,
dashboard examples, use cases, hardware compatibility and day-to-day operations to
installation, a short license summary and FAQ. The workflow is an ordinary ordered
HTML list styled as a diagram, not a remote renderer or bitmap. The main starting
point is the USB guide for a new dedicated physical server; VM, existing Ubuntu and
existing Kubernetes routes remain directly available.

Keep both languages in sync when changing claims, links or sections. Language
switches are ordinary links, with no geolocation, language auto-redirect, cookie or
stored preference. Each page has a canonical URL, reciprocal English/German
`hreflang` links, an English `x-default`, descriptive metadata and an existing
screenshot as the social preview. Existing homepage fragment IDs remain available
in both languages.

The source HTML links to canonical handbook Markdown. `tools/docs.py` converts
these to `handbook/.../` links in the published artifact. Root repository files
such as LICENSE and SUPPORT.md use explicit public GitHub links; they are not
handbook pages. New marketing HTML must be included in `MARKETING_PAGES` and
excluded from MkDocs in `mkdocs.yml`. Do not collide with legacy redirect routes
from `docs/migration.json` (in particular `licensing.html`).

## Product and license claims

Only implemented functionality is presented as available. Use the current
[compatibility reference](../reference/compatibility.md) and canonical user guides
to verify claims. A listed engine path is not universal device/model support.
Sharing does not increase physical VRAM or imply hard per-model memory isolation.
Realtime remains a separate experimental path; chat compatibility does not imply
Realtime support.

Core functions include Resource Sharing and Private Mesh without a license file.
Only Federated SSO requires Free Registered or Commercial activation. The technical
edition does not decide legal eligibility. BSL production-use eligibility,
third-party-service exclusions and the per-version MIT Change License remain
defined by [LICENSE](../../LICENSE) and [LICENSING.md](../../LICENSING.md).

The edition pages explain the existing unsigned request → private issuer review →
signed upload → explicit activation workflow. They link to the published provider
contact and [license-management guide](../administration/licenses.md), not an
invented checkout, price, trial, automatic activation service or support guarantee.
The site overview does not change the license or replace legal review.

## Product screenshots

The redesign reuses five unchanged, privacy-reviewed WebP captures from the
owner-approved test appliance on 24 September 2026:

| Image | Website placement |
|---|---|
| [model-ready.webp](../assets/screenshots/model-ready.webp) | Hero: model lifecycle actions |
| [model-edit.webp](../assets/screenshots/model-edit.webp) | Models tab: unchanged edit form |
| [models-memory.webp](../assets/screenshots/models-memory.webp) | Hardware tab: memory and slots |
| [application-create.webp](../assets/screenshots/application-create.webp) | Apps & access tab: unsubmitted application draft |
| [model-cache.webp](../assets/screenshots/model-cache.webp) | Operations: disk and cache visibility |

The [capture manifest](../assets/screenshots/captures.json) is the provenance and
integrity source. Captions identify the date and example nature of values; these
are not sizing recommendations or benchmarks. The hero shows a clipped detail on
narrow layouts and links to the full unchanged image. Other images scale to the
layout and also retain full-size links. Dimensions are declared to reserve space.
Only the hero image loads eagerly; secondary images load lazily.

No new live-appliance access, workload changes, image generation or pixel
retouching is needed to rebuild this site. For refreshes, follow the
[handbook screenshot rules](documentation.md#handbook-screenshots): default to
read-only navigation and unsubmitted drafts, get specific approval before starting
test workloads, review final pixels for private data, and update the manifest.
Do not expose personal model names, credentials, internal addresses or browser
chrome.

The older `assets/dashboard-overview.webp` and `assets/dashboard-models.webp`
remain for historical references but are not current landing-page visuals. They
were captured on 2026-09-09 from the unmodified dashboard at commit `28222ea`
against a loopback-only, GET-only synthetic fixture API. They must not be described
as live measurements. The older sales deck also remains a dated artifact.

## Preview and checks

From the repository root, after installing the
[documentation build dependencies](documentation.md#build-and-preview):

```sh
.build/docs-venv/bin/python -m unittest tests.test_docs tests.test_website
.build/docs-venv/bin/python tools/docs.py build
node --check docs/site.js
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/docs-site
```

Open `http://127.0.0.1:8765/`. To preview only the unbuilt marketing layout, serve
`docs/`; Markdown links remain source links until the combined build resolves them.

Before publishing:

1. Check all four new pages at desktop, tablet and mobile widths, including 320px.
   Check actual document width as well as visual layout; a deliberately clipped hero
   image must not make the page scroll horizontally.
2. Exercise every product tab by mouse and ArrowLeft/ArrowRight/Home/End. Confirm
   selected state, visible panel and focus agree. Check the mobile menu, link-close
   behavior and Escape-to-close with focus returned to its button.
3. Check language switching, installation routes, licensing/contact, FAQ and
   full-size screenshots. Confirm the built page links into the handbook correctly.
4. Disable JavaScript and reload: navigation and all three product panels must
   remain readable; FAQ uses native details/summary. Restore browser settings.
5. Check missing images, browser errors, visible focus and reduced-motion behavior.
6. Run `git diff --check` and the public release scan below. A text scan does not
   replace screenshot privacy review.

```sh
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
```

The documentation CI runs both test modules and the complete static build. The
website tests cover language/metadata, source links, existing anchors, progressive
markup, reviewed image dimensions, authoritative license links and build routing.
They do not prove visual fit or interaction behavior: those need a browser.

Follow the [public release checklist](release-checklist.md). After a push, confirm
that Pages succeeded for the exact commit and that published HTML/assets match it.
No dashboard/container rollout is required for a website-only change.

## Previous artwork provenance

The original abstract artwork remains in the repository but is no longer shown on
the website; the product screenshots now take its place.

`ai-infrastructure.webp` was generated with the built-in image-generation tool on
2026-09-09 and encoded as WebP (`cwebp -q 85`). Original dimensions: 1536 × 1024.
The generated image is an editorial illustration, not a product screenshot or
photograph. There are no third-party marks in the artwork.

Generation prompt:

> Use case: stylized-concept. Asset type: original premium software website hero
> artwork, one image, landscape 3:2, crop-safe. Scene/backdrop: very light cool
> neutral grey studio cyclorama, close to #f2f5f0, almost white; continuous matte
> floor with subtle natural studio shadows. Primary request: abstract sculptural
> arrangement of exactly three small modular cubes suggesting coordinated local
> computing and open AI infrastructure. A balanced architectural composition
> combining brushed-silver aluminum and translucent dark forest-green glass, with
> one luminous acid-lime core visible within the glass cube. Two very restrained
> fine dark connector cables link the modules on the studio surface. Style/medium:
> sophisticated premium industrial editorial, photorealistic physically plausible
> 3D studio still life, tactile brushed metal grain, clean glass refraction, crisp
> forms with fine bevels. Composition/framing: medium-wide, slightly elevated
> three-quarter viewpoint, all three cubes centered in an elegant compact
> composition with generous breathing space around them, entire silhouettes
> visible, suitable as a contained artwork on the right half of a white marketing
> hero. Calm, confident, minimal. Lighting/mood: soft directional daylight with
> lovely grounded architectural shadows, delicate controlled highlights, gentle
> acid-lime light inside one core; restrained saturation otherwise. Constraints:
> this is an abstract software infrastructure metaphor, NOT a branded hardware
> product; no text, no labels, no logos, no UI, no watermark, no USB stick, no laptop,
> no robots, no brains, no grid pattern, no busy circuit board, no extra objects.
> Create exactly one original image.
