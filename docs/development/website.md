# Marketing website maintenance

The public marketing site uses plain HTML, CSS and a small progressive-enhancement
script. English is the default; German is an explicit language choice. The combined
Pages build places these pages at the site root and the canonical English Markdown
handbook under `handbook/`. There is no application server, remote font service,
build-time frontend framework. Visitor statistics use one cookie-free Umami tag
that the build adds; see [Visitor statistics](#visitor-statistics). The appliance
dashboard is a separate application and is not changed by website updates.

Follow [documentation maintenance](documentation.md) for the combined build, CI
and the one-time switch of the Pages source to GitHub Actions. The Azure Static
Web App that hosts the site is defined in
[infrastructure/landingpage](../../infrastructure/landingpage/README.md);
GitHub Pages only redirects to it.

## Sources and structure

| Source | Purpose |
|---|---|
| [index.html](../index.html) | English product homepage |
| [de.html](../de.html) | Equivalent German homepage; handbook links are marked English |
| [editions.html](../editions.html), [editionen.html](../editionen.html) | Licensing overview, eligibility and the actual request/activation workflow |
| [site.css](../site.css) | Responsive navy/violet/cyan design from the October 2026 pitch mockup, system fonts for text, the local heading font, visible focus and reduced motion |
| `assets/fonts/` ([tracedsans_700.woff2](../assets/fonts/tracedsans_700.woff2)) | Traced Sans Bold (weight 700) for headings on the landing pages, the legal pages and the handbook; see [Heading font](#heading-font) |
| [site.js](../site.js) | Mobile navigation and keyboard-accessible dashboard screenshot tabs |
| `assets/brand/` ([logo.svg](../assets/brand/logo.svg), [brandmark.svg](../assets/brand/brandmark.svg), [core.svg](../assets/brand/core.svg)) | Magic Stick logo, brandmark and core symbol (SVG) from the pitch mockup |
| `assets/artwork/` ([command-centre.jpg](../assets/artwork/command-centre.jpg) and two WebP backgrounds) | Hero illustration and two blurred section backgrounds; see [Artwork provenance](#artwork-provenance) |
| [assets/favicon.svg](../assets/favicon.svg) | Brandmark on a dark rounded tile |
| [legal-notice.html](../legal-notice.html), [impressum.html](../impressum.html) | Legal notice in English and German (Impressum), one text in two languages; see [Legal pages](#legal-pages) |
| [privacy.html](../privacy.html), [datenschutz.html](../datenschutz.html) | Privacy policy in English and German (Datenschutzerklärung), one text in two languages; see [Legal pages](#legal-pages) |

The homepage follows the October 2026 pitch mockup. It moves from a full-width
hero illustration through the product section (intro, dashboard screenshot
switcher, application catalog cards), a "where would you like to start" choice
for individuals and teams, the four deployment environments with a GPU note, a
three-step first-use section, a team-pilot section with the licensing note, the
FAQ and a closing call to action. Readers without Kubernetes experience are the
audience: technical components (Kubernetes, Flux, Magic Stick Operator, LiteLLM,
KubeAI, engines, Keycloak/Envoy) are named in the FAQ and linked to the
architecture and compatibility references instead of being drawn on the page.
Every deployment environment links its installation guide; there are no
"documentation pending" placeholders from the mockup. The mockup's Typekit fonts
are not used; body text keeps the system font stack and only headings use the
local heading font.

The screenshot switcher is the progressively enhanced tab pattern: three
`figure` panels with reviewed captures are all readable without JavaScript, and
`site.js` turns the toolbar buttons into a keyboard-accessible tablist. "Enlarge
screenshot" is a plain link to the full image.

Keep both languages in sync when changing claims, links or sections. English pages
link the English legal pages, German pages the German ones. Language
switches are ordinary links, with no geolocation, language auto-redirect, cookie or
stored preference. Each page has a canonical URL, reciprocal English/German
`hreflang` links, an English `x-default`, descriptive metadata and an existing
hero illustration as the social preview. Homepage fragment IDs that other pages
link (`#produkt`, `#requirements`, `#hardware`, `#starten`, `#teams`,
`#lizenzen`, `#faq`) remain available in both languages.

The source HTML links to canonical handbook Markdown. `tools/docs.py` converts
these to `handbook/.../` links in the published artifact. Root repository files
such as LICENSE and SUPPORT.md use explicit public GitHub links; they are not
handbook pages. New marketing HTML must be included in `MARKETING_PAGES` and
excluded from MkDocs in `mkdocs.yml`. Do not collide with legacy redirect routes
from `docs/migration.json` (in particular `licensing.html`).

## Heading font

Headings (`h1`–`h3`) use Traced Sans Bold from
`docs/assets/fonts/tracedsans_700.woff2`, served from the site itself; no remote
font service is involved. Each stylesheet declares the single `@font-face` with
weight 700 and `font-display: swap`: [site.css](../site.css) and the inline
styles of the legal pages reference `assets/fonts/` relative to the site root,
[handbook.css](../stylesheets/handbook.css) references `../assets/fonts/`
because MkDocs copies `docs/assets/` under `handbook/`. Body text, buttons and
navigation stay on the system font stack. Heading rules set `font-weight: 700`
explicitly because the file contains only that weight and `site.css` disables
font synthesis.

The committed file is a subset. Characters that it does not contain fall back
to the next font in the stack glyph by glyph, which is visible in a heading.
When replacing the file, check that it covers the characters that actual
headings use (at least Latin-1 letters including German umlauts, typographic
quotes and dashes) and keep the same file name or update all four references.
Record the font's source and license terms with the other collateral assets in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Legal pages

The legal notice and the privacy policy each exist as one legal text in two
languages: [legal-notice.html](../legal-notice.html) with
[impressum.html](../impressum.html), and [privacy.html](../privacy.html) with
[datenschutz.html](../datenschutz.html). Every landing page links the pair of its
own language, and the footer override in `docs/overrides/partials/copyright.html`
links all four from every handbook page. The pages are self-contained HTML with
inline styles, reciprocal `hreflang` links, an English `x-default` and an EN/DE
switch; the German pages keep the English section IDs so that deep links such as
`#provider` or `#opt-out` work in both languages.

Always change both languages of a pair together, in the same commit, and set the
same date in the `<time datetime="…">` element of both footers.
`tests/test_website.py` (`test_legal_pages_stay_in_sync_across_languages`) fails
when the two versions drift apart: it compares the element structure, section
IDs, link targets (language-specific targets such as `de.html`/`index.html` are
treated as equal), every number in the text (legal references, addresses,
retention periods), the inline opt-out script and the update date. Translate
legal references with the same numbers (`Article 6(1)(f) GDPR` ↔
`Art. 6 Abs. 1 lit. f DSGVO`, `Section 5 DDG` ↔ `§ 5 DDG`) and keep paragraph
boundaries equal. The check is structural; it does not replace a legal review of
the translation.

## Visitor statistics

`mkdocs.yml` holds an `extra.umami` block with the Umami `script` URL, the
`website_id` of this site and an optional `domains` list. When both values are
set, `python tools/docs.py build` adds one `<script defer …>` tag at the end of
`<head>` on every landing page and handbook page. The committed HTML sources,
`docs/` previews, legacy redirect stubs and the tests stay free of remote scripts,
and an empty block builds the site without analytics. The build rejects a script
URL that is not public HTTPS and a `website_id` that is not a UUID.

The tag sets `data-do-not-track`, so browsers with Do Not Track enabled send
nothing, and `data-exclude-search` and `data-exclude-hash`, so query strings and
URL fragments are not recorded. Umami
itself sets no cookies and stores no identifier in the browser. The opt-out
button on [privacy.html](../privacy.html#opt-out) and
[datenschutz.html](../datenschutz.html#opt-out) sets `umami.disabled` in the
local storage of the current address, which the Umami script checks before
sending. `domains` restricts counting to the listed public hostnames so that
pull-request preview deployments do not appear in the statistics.

The privacy policy names the hosting providers, the Azure regions of the Umami
app and database in [infrastructure/landingpage](../../infrastructure/landingpage/README.md),
the collected fields, the monthly session identifier and the retention periods.
Umami has no retention setting of its own: the scheduled retention job in
`umami.bicep` deletes visitor records after `retentionMonths`, the period the
policy states. The Umami image is pinned by digest because the policy describes
what that version collects; review the policy before upgrading it.
Change those, the `extra.umami` block or the Umami tag attributes together with
[privacy.html](../privacy.html) and [datenschutz.html](../datenschutz.html),
including the update date in both footers (see [Legal pages](#legal-pages)).

The privacy policy also describes the project's social media profiles
(`#social-media`: Instagram, LinkedIn, YouTube). Adding, removing or moving a
profile to another platform changes that section in both languages: provider
address, transfer safeguards, the joint-controller agreement for profile
statistics and the provider's privacy policy link.

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

The landing page reuses three unchanged, privacy-reviewed WebP captures from the
owner-approved test appliance on 24 September 2026. The pitch mockup shipped a
synthetic "Models" dashboard rendering; it is not used, because the website only
shows actual, reviewed captures. The mockup's overview and application images are
byte-identical to the reviewed captures below.

| Image | Website placement |
|---|---|
| [dashboard-overview.webp](../assets/screenshots/dashboard-overview.webp) | Overview tab: summary cards |
| [models-memory.webp](../assets/screenshots/models-memory.webp) | Models tab (default): memory and slots |
| [application-create.webp](../assets/screenshots/application-create.webp) | Applications tab: unsubmitted application draft |

The [capture manifest](../assets/screenshots/captures.json) is the provenance and
integrity source. Captions identify the date and example nature of values; these
are not sizing recommendations or benchmarks. Images scale to the layout and keep
full-size links. Dimensions are declared to reserve space. Only the hero artwork
loads eagerly; screenshots load lazily. The remaining handbook captures stay under
`assets/screenshots/` with their manifest.

No new live-appliance access, workload changes, image generation or pixel
retouching is needed to rebuild this site. For refreshes, follow the
[handbook screenshot rules](documentation.md#handbook-screenshots): default to
read-only navigation and unsubmitted drafts, get specific approval before starting
test workloads, review final pixels for private data, and update the manifest.
Do not expose personal model names, credentials, internal addresses or browser
chrome.

Sales decks, onepagers and infographic collateral live under
[AIMS-000 in Team-Innovation](https://github.com/QualityMinds/Team-Innovation/tree/main/missions/AIMS-000-ai-launch-system/assets/product-collateral).
They are not copied into the public Pages artifact.

## Artwork provenance

The brand files under `assets/brand/` and the artwork under `assets/artwork/`
were supplied with the Magic Stick pitch mockup (QualityMinds, October 2026).
They are illustrations and brand assets, not product evidence.

| File | Origin and handling |
|---|---|
| `brand/logo.svg`, `brand/brandmark.svg`, `brand/core.svg` | Illustrator exports from the mockup; editor IDs removed, `<title>` added. The favicon reuses the brandmark. |
| `artwork/command-centre.jpg` | Hero background and social preview, 1670 × 942. Unchanged mockup file (Adobe Photoshop 27.10 export of 2 October 2026 with an Adobe Content Credentials/C2PA manifest, which a re-encode would strip). Decorative (`alt=""`). The screen in the scene shows third-party service marks (among them OpenAI and Kubernetes); review this before a wider campaign use and replace the file if brand clearance is not available. |
| `artwork/side-workstation.webp`, `artwork/entrance.webp` | Blurred backgrounds of the first-use and closing sections, converted from the mockup PNGs (1672 × 941) with Pillow at WebP quality 78. Used as CSS backgrounds only. |

The generation prompts of the artwork are not part of this repository; the
mockup owner holds them. The previous generated artwork remains below for the
record.

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

1. Check all four pages at desktop, tablet and mobile widths, including 320px.
   Check actual document width as well as visual layout; the full-width hero
   illustration must not make the page scroll horizontally.
2. Exercise every screenshot tab by mouse and ArrowLeft/ArrowRight/Home/End. Confirm
   selected state, visible panel and focus agree. Check the mobile menu, link-close
   behavior and Escape-to-close with focus returned to its button.
3. Check language switching, installation routes, licensing/contact, FAQ and
   full-size screenshots. Confirm the built page links into the handbook correctly.
4. Disable JavaScript and reload: navigation and all three screenshot panels must
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
that the Azure Static Web Apps deployment succeeded for the exact commit and that
published HTML/assets match it. GitHub Pages only needs the manual redirect
workflow when the website address or its set of pages changes.
No dashboard/container rollout is required for a website-only change.

## Previous artwork provenance

The original abstract artwork `ai-infrastructure.webp` remains in the repository
but is no longer shown on the website.

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
