# Documentation and website instructions

Read the [project instructions](../AGENTS.md). These rules also cover the root
README and public product collateral.

## Sources and audience

- Write the canonical handbook in English for users/administrators without
  Kubernetes experience. Keep technical contracts and development detail separate.
- Use the seven existing sections and `navigation.json`. GitHub Markdown and the
  generated handbook share one source; do not maintain separate website manuals.
- The root README is the repository entry point. The landing page explains product
  value and installation choices; task guides explain operation. Link rather than
  copying full procedures between them.
- Update English and German marketing pages together when claims, sections or
  links change. Keep actual UI labels and commands in their original form.
- Preserve legal meaning from root license/legal sources. Distinguish shipped
  functions, experimental paths, roadmap ideas and dated acceptance evidence.
- Keep compatibility redirects/anchors through `migration.json`. Update canonical
  pages, not the legacy root stubs. Do not rewrite historical reports as current
  evidence; add a clearly dated follow-up when needed.

## Images, diagrams and layout

- Follow [documentation maintenance](development/documentation.md) for capture
  authorization, privacy review, dated captions and `assets/screenshots/captures.json`.
  A screenshot task does not by itself authorize model starts or system changes.
- Use actual, reviewed UI captures or clearly identified fixtures. Do not retouch
  displayed measurements/statuses, expose credentials or present example values
  as benchmarks. Inspect final pixels; text scans cannot prove image privacy.
- Reuse maintained assets. Edit generated diagram sources in
  [tools/docs_diagrams.py](../tools/docs_diagrams.py), regenerate their SVGs and
  visually check text fit. Do not hand-edit generated output alone.
- Follow [website maintenance](development/website.md) for the static-only build,
  dashboard-aligned palette, translations, accessible controls and responsive checks.
- Avoid adding remote tracking, fonts, rendering services or client frameworks
  merely to publish documentation. Preserve readable content without JavaScript.

## Checks and publication

With `requirements-docs.txt` installed, from the repository root:

```sh
python -m unittest tests.test_docs tests.test_website
python tools/docs.py build
git diff --check
```

For changed diagrams also run `python tools/docs_diagrams.py --check`; for changed
marketing JavaScript run `node --check docs/site.js`. For instruction/skill changes
run `python tools/check_agent_guidance.py` and the guidance tests. Review changed
visuals in the built site at desktop/mobile sizes; check actual horizontal overflow,
keyboard access and links, not screenshots alone.

Do not run appliance/GPU acceptance for a documentation-only edit. A successful
static build is not Pages deployment. Follow the requested publication scope and
verify the published revision/content before reporting a live website update.
Never change repository Pages settings implicitly. Keep external-link outages
advisory as in the existing CI; internal broken links remain errors.
