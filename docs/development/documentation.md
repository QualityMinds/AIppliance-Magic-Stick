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
   read-only fixtures and record capture/source provenance; they are not measurements.
5. Distinguish implemented behavior, experimental scope, local checks and live acceptance.
6. Keep root legal/project files authoritative. Do not rewrite their meaning in a guide.

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
Historical FreeToken evidence lives under reports; active audits and JSON evidence
retain their current maintenance responsibilities.
Historical report bodies are excluded from full-text search so dated evidence does
not outrank current instructions. They remain available through the report index
and preserved links.
