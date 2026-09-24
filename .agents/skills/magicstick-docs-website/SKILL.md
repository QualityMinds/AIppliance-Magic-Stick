---
name: magicstick-docs-website
description: "Create or revise Magic Stick README, handbook, static landing pages, screenshots and diagrams. Use for public documentation and product content, not appliance dashboard UI or deployment by itself."
---

# Documentation and website work

Read [project instructions](../../../AGENTS.md) and
[documentation instructions](../../../docs/AGENTS.md). Choose the relevant guide:

- Handbook structure, redirects, captures or diagrams:
  [documentation maintenance](../../../docs/development/documentation.md).
- Landing page, translations or marketing assets:
  [website maintenance](../../../docs/development/website.md).
- Product/hardware claims: the affected user/reference guide and current code or
  catalog, not historical reports alone.

## Work

Identify the reader and canonical source before editing. Keep the root README as
an entry point, marketing as a concise product explanation, and task procedures
in the English handbook. Link technical contracts rather than copying them.

Update navigation and migration anchors when reorganizing pages. Preserve dated
reports as evidence. For marketing changes, keep English and German claims,
installation paths, licensing summaries and links equivalent without silently
changing legal meaning or promising unimplemented behavior.

Reuse suitable reviewed images. Capture new UI views only within the requested
access/workload scope and follow the capture manifest/privacy rules. Do not start
models to fill a screenshot without authorization. Do not retouch actual statuses
or measurements. Use generated illustrations only when they clarify a non-UI
concept; identify them as illustrations, not product evidence. Prefer the existing
editable SVG generator for technical diagrams.

## Verify and hand off

Run documentation/website tests, the strict static build and affected script or
diagram checks from the documentation instructions. Review changed layouts and
assets in the built site at desktop and narrow widths, with keyboard navigation,
working links and no unintended horizontal scrolling. Review screenshot pixels
for private data separately from the text secret scan.

Report changed sources, checks and unverified visual/live acceptance. Do not run
appliance tests for a prose-only edit. GitHub Pages publication is separate from
local build and from appliance rollout; perform it only within the requested
publication scope and verify the published revision/content before claiming it.
