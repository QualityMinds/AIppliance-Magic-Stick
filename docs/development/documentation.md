# Maintain the documentation

## One source, two presentations

The canonical content is English, GitHub-readable Markdown under `docs/`.
MkDocs 1.6.1 and Material 9.7.7 produce the same content under `handbook/` in the
static website. The marketing HTML at the site root remains separate. No application
server, account, analytics service or remote font service is needed for reading.

The seven sections are Get started, Installation, User guide, Administration,
Concepts, Reference and Development. `docs/navigation.json` defines the website
navigation. Each section's README is the GitHub entry point.

## Authoring rules

1. Start task guides with prerequisites, then actions, expected results and failures.
2. Keep explanations in Concepts, exact fields in Reference, and build/release work
   in Development. Link instead of copying the same contract into several pages.
3. Use ordinary Markdown headings, tables, code fences and relative file links.
   Do not require theme-specific tab/admonition syntax to understand a page on GitHub.
4. Use exact English UI labels and public-safe example values. Screenshots use neutral
   read-only fixtures or explicitly approved, privacy-reviewed test-appliance views.
   Record capture/source provenance; screenshots are not benchmarks or sizing advice.
5. Distinguish implemented behavior, experimental scope, local checks and live acceptance.
6. Keep root legal/project files authoritative. Do not rewrite their meaning in a guide.

## Handbook screenshots

The current handbook images in `docs/assets/screenshots/` were captured from an
authenticated test appliance on 24 September 2026, at the owner's request. The
[capture manifest](../assets/screenshots/captures.json) records each view and its
integrity hash. An image's optional `source` object, or its `sourceSession` key
under `sourceSessions`, replaces the top-level source for that capture session;
older images retain their original provenance. The
visible Services page reported the applied control-plane
revision recorded there; this is not an independent attestation of the running
dashboard image. The [marketing website](website.md) reuses selected, unchanged
images from this same collection, with dated captions. Its older fixture-based
captures remain in the repository but are no longer displayed.

- Default to read-only navigation and unsubmitted forms. Start test models only
  with explicit owner authorization, recorded in the capture session. Use a small,
  neutral-named model and the least resource-intensive adequate target; leave
  unrelated workloads and system settings alone. Stop the test runtime afterwards
  and record whether its saved definition and download cache remain.
- Capture only the relevant panel. Exclude browser chrome, signed-in identities,
  personal instance names, internal addresses, identifiers and credentials.
  Do not open credential, API-key or kubeconfig views for public captures.
- A log screenshot needs its own `privacyReview`. Use only inspected output from
  the authorized test model, crop away host details and internal addresses, and
  exclude prompts, responses and secrets. Do not present a healthy startup excerpt
  as failure evidence or a benchmark. Per-image privacy reviews override the
  manifest's default review; text scanners cannot inspect the pixels.
- Review every final image visually before publishing. Cropping and WebP encoding
  are allowed; do not retouch values, replace statuses or describe a live capture
  as a synthetic fixture. The recorded numeric values are dated illustrations.
- Store the approved crops as metadata-free WebP images. Keep temporary originals
  outside the repository. Use ordinary Markdown image links with descriptive alt
  text, a dated caption, and a link to the same full-size image.
- Re-capture after relevant UI changes. Update the manifest, run the documentation
  checks, and verify both GitHub-readable links and the rendered desktop/mobile
  handbook. A text-only secret scan does not replace visual privacy review.

## Generated explanatory diagrams

The editable content and layout live in
[`tools/docs_diagrams.py`](../../tools/docs_diagrams.py). It uses only Python's
standard library to generate the versioned static SVGs under
`docs/assets/diagrams/`. Both GitHub and the
handbook display the same images; no remote renderer, fonts, JavaScript or extra
build dependency is required. The dark background and cyan/purple accents match
the dashboard, including when a reader uses the light handbook theme.

| Diagram | Canonical explanation |
|---|---|
| System architecture | [Architecture](../concepts/architecture.md#at-a-glance) |
| Model lifecycle | [Manage deployed models](../user-guide/models/manage.md#understand-the-lifecycle) |
| Memory and GPU sharing | [Memory accounting](../concepts/memory.md) |

After changing a diagram source, regenerate and verify it:

```bash
python3 tools/docs_diagrams.py
python3 tools/docs_diagrams.py --check
```

The normal documentation check/build and CI reject stale or missing outputs.
Tests also check static-only SVG content, accessible titles/descriptions, internal
marker references and Markdown embedding. These checks do not prove semantic
correctness or text fit: visually review every changed diagram at full size and
in the desktop/mobile handbook before publishing.

Keep diagrams small and task-focused. Use English labels, generous spacing and
the linked full-size view for narrow screens. Preserve the prose explanation and
descriptive alt text; color must not be the only way to distinguish paths or
states. Mark simplified workflows and illustrative quantities explicitly. Review
relationships against the canonical docs and relevant runtime contracts when
behavior changes; generation checks detect source/output drift, not behavior drift.

## Build and preview

From the repository root, with Python 3.9 or newer:

```bash
python3 -m venv .build/docs-venv
.build/docs-venv/bin/pip install -r requirements-docs.txt
.build/docs-venv/bin/python tools/docs.py check
.build/docs-venv/bin/python tools/docs.py build
.build/docs-venv/bin/python -m http.server 8765 --bind 127.0.0.1 --directory dist/docs-site
```

Open `http://127.0.0.1:8765/handbook/`. Verify navigation, search, desktop/mobile
layout, both color modes and source links. The output is disposable and ignored
by Git. Do not edit generated HTML or commit virtual environments.

## Catalog-derived reference

`tools/docs.py inventory` regenerates the compatibility page from
`magicstick-compute-target-catalog`. The check command fails if the committed
reference is stale. Review that generated change with the catalog change. This
declares configured capabilities; it is not a new hardware test result.

## Old links

`docs/migration.json` records old paths and heading anchors. Compatibility Markdown
pages preserve GitHub bookmarks. The combined build supplies legacy HTML redirects
at the website root, including fragment mappings. For in-place translated guides,
explicit aliases preserve old heading IDs. Never remove an old route without
reviewing inbound links and updating this mapping.

## CI and publication

The documentation workflow runs unit checks, internal links/anchors, catalog
consistency and a strict static build on pull requests. It uploads a preview artifact.
Main/manual runs can deploy the combined landing page and handbook through GitHub
Pages. The repository's Pages source must be **GitHub Actions**; switching that
remote setting is a separate publication step, not a side effect of editing docs.

A weekly/manual external-link check reports failures as an advisory artifact;
temporary Internet failures do not become release gates. Internal broken links
remain errors. Review external redirects and changed vendor advice before updating
hardware claims. Documentation publication does not roll out appliance containers.

## Migration decisions

The previous monolithic dashboard, operations and model-catalog documents were
split by task/contract. Manual installer fallback instructions now link to their
reviewed implementation instead of maintaining a second divergent bootstrap.
The old German feature overview is replaced with an English summary; the German
sales deck is separate marketing material, not part of the English handbook.
The 2026-09-24 collateral import is maintained under AIMS-000 in Team-Innovation;
presentation/PDF/raster packages are no longer copied into Pages. Current
handbook screenshots keep their independent capture manifest and stay here.
Historical FreeToken evidence lives under reports; active audits and JSON evidence
retain their current maintenance responsibilities.
Historical report bodies are excluded from full-text search so dated evidence does
not outrank current instructions. They remain available through the report index
and preserved links.
