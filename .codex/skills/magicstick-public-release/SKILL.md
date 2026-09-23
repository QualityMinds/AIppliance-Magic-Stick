---
name: magicstick-public-release
description: Use when preparing or reviewing AIppliance-Magic-Stick for public release, GitHub Pages, legal/privacy content, OSS community files, third-party notices, secret scans, or release checklist updates.
---

# MagicStick Public Release Work

## Read First

- `AGENTS.md`
- `docs/public-release-checklist.md`
- `README.md`
- `docs/README.md`
- `THIRD_PARTY_NOTICES.md`
- `SECURITY.md`

## Workflow

1. Confirm the public path is documented as `readonly-public` plus runtime
   settings/CRs.
2. Keep legal and privacy pages in English and linked from the landing page and
   docs index.
3. Update community/process files when support, security, governance, or release
   expectations change.
4. Update `THIRD_PARTY_NOTICES.md` when image, chart, repository, or version
   references change.
5. Remove stale docs or examples that imply private overlays are the default
   product path.

## Checks

- Local Markdown/HTML link check.
- `git diff --check`.
- Public value scan from `docs/public-release-checklist.md`.
- `gitleaks detect --source . --config .gitleaks.toml --no-git --redact`.
- Render `magic-cluster/flux/entrypoints/single-node` and
  `examples/demo/infra-cluster/flux-bootstrap`.
