# Public website

The German marketing website is a buildless static site published from `main` / `docs`
by GitHub Pages. It requires no application server, framework, package install, or
external font service. The appliance dashboard is a separate application and is
not changed by website updates.

## Sources and structure

- [index.html](index.html): product story, model/resource/access features, application
  use cases, operation, Community/Enterprise boundaries, installation routes, FAQ.
- [site.css](site.css): responsive dashboard-aligned navy/cyan/violet design, system fonts, focus
  indicators, reduced-motion support, and print-independent browser layout.
- [site.js](site.js): mobile navigation and keyboard-accessible application tabs.
  Without JavaScript, navigation and all application panels remain visible.
- [legal-notice.html](legal-notice.html) and [privacy.html](privacy.html): existing
  legal content with matching presentation. Styling updates are not legal review.
- [assets/dashboard-overview.webp](assets/dashboard-overview.webp): current React
  dashboard overview, with neutral synthetic example data.
- [assets/dashboard-models.webp](assets/dashboard-models.webp): current model
  management UI, with neutral synthetic CPU/GPU resource and model examples.

Only implemented functionality is presented as available. The two Enterprise
features are targeted instance sharing and dashboard-managed federated SSO. Other
Enterprise candidates are explicitly marked as not implemented. The MIT boundary
and commercial notice are defined in [LICENSING.md](../LICENSING.md).

The former dashboard screenshots and the September 1 sales deck are not used as
current product visuals. The two new screenshots were captured on 2026-09-09 from
the unmodified React dashboard at commit `28222ea`, rendered against a loopback-only,
GET-only fixture API with no upstream appliance access. They are not live server
measurements, sizing promises, or benchmarks; captions identify the example data.
No screenshot pixels were generated or retouched. Both were encoded as WebP at
quality 92, with full-size links retained for inspection.

For refreshes, use the current dashboard with neutral read-only fixtures based on
`dashboard/apps/web/src/FeatureParity.test.tsx`, explicitly point
`MAGICSTICK_API_PROXY` to that isolated local fixture server, reject writes and
unknown endpoints, and inspect every image for private data. Do not use the Vite
proxy's default live-appliance target for marketing captures. Use `demo-admin`,
`example.local`, synthetic resource values, and no credentials. Capture Overview
and Models through the browser, without changing the dashboard's UI or rendering.

## Preview and checks

From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs
node --check docs/site.js
git diff --check
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
```

Open `http://127.0.0.1:8765/`. Check desktop and mobile widths, missing images,
horizontal overflow, all relative files and fragment links, the mobile menu,
Escape to close it, and the application tabs with arrow/Home/End keys. Keep the
site fully readable without JavaScript. Follow the
[public release checklist](public-release-checklist.md) before publishing.

After a push, confirm that the latest Pages build succeeded for the exact commit
and that the published HTML and assets match it. No dashboard/container rollout is
required for a website-only change.

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
