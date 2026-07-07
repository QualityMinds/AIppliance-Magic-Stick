---
name: magicstick-repo-maintenance
description: Use when working on AIppliance-Magic-Stick repo changes that require public-safety review, documentation synchronization, validation selection, or release-readiness hygiene.
---

# MagicStick Repo Maintenance

## Read First

- `AGENTS.md`
- `docs/development.md`
- `docs/public-release-checklist.md` for release-sensitive changes

## Workflow

1. Check `git status --short` and identify unrelated user changes.
2. Inspect nearby code/manifests/docs before editing.
3. Map touched files to the documentation matrix in `AGENTS.md`.
4. Keep public files deployment-neutral and public-safe.
5. Prefer consolidating stale docs over adding duplicate descriptions.
6. Run the validation matrix entries that match the touched areas.
7. Report what changed, what checks ran, and any checks not run.

## Guardrails

- Do not commit real deployment values, secrets, kubeconfigs, customer data, or
  private repository paths.
- Do not add generated installer media, caches, rendered manifests, or local
  kubeconfigs.
- Keep `examples/demo` render-only unless the user explicitly asks for a public
  smoke-test runtime seed.
