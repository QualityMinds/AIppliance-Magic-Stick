# AGENTS.md

Repository instructions for AI agents and contributors working on
AIppliance-Magic-Stick.

## Working Model

- Treat `readonly-public` as the default product path.
- Treat external GitOps repositories and overlays as optional advanced
  integrations, not as the normal installation path.
- Keep the public repository reusable, deployment-neutral, and safe to publish.
- Prefer dashboard/runtime CR flows over static example descriptors for modules,
  models, and app instances.
- Do not leave product behavior documented in only one layer when code, manifests,
  or UI changed elsewhere.

## Public Safety

Never add real deployment values to this repository:

- tokens, passwords, API keys, kubeconfigs, private keys, Ansible Vault data
- real domains, private IPs, admin emails, customer names, personal data
- private repository URLs, private Flux paths, filled installer metadata
- deployment-specific storage sizes, model selections, or runtime CR seeds
- decoded Kubernetes Secret values in docs, logs, issues, comments, or tests

Use only `example.local`, `example.com`, `CHANGEME`, generated-secret
annotations, public-safe defaults, or documented variables.

## Change-To-Documentation Matrix

When behavior changes, update the matching public contract in the same change:

| Change area | Documentation to check |
|---|---|
| Dashboard UI/API/RBAC/status | `docs/dashboard.md`, `docs/operations.md` |
| Module catalog, generated Flux, module lifecycle | `docs/modules.md`, `docs/operator-orchestration.md` |
| Runtime CRDs, status fields, finalizers | `docs/appliance-crd.md`, `docs/operator-orchestration.md` |
| AppInstance hostnames, instance defaults, app operators | `docs/dashboard.md`, `docs/appliance-crd.md`, `docs/operations.md` |
| ModelActivation, model presets, LiteLLM/KubeAI catalog flow | `docs/model-catalog.md`, `docs/dashboard.md`, `docs/operations.md` |
| Installer, host automation, runtime settings | `docs/getting-started.md`, `docs/configuration.md`, `magic-installer/README.md`, `magic-host/README.md` |
| Flux entrypoints, overlays, profiles | `docs/architecture.md`, `docs/gitops-overlays.md`, `magic-cluster/README.md` |
| Images, Helm charts, third-party components | `THIRD_PARTY_NOTICES.md`, `docs/public-release-checklist.md` |
| Public process, support, security, legal or Pages content | `README.md`, `docs/README.md`, `SUPPORT.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `CHANGELOG.md`, `ROADMAP.md`, `docs/index.html`, `docs/legal-notice.html`, `docs/privacy.html` |

If a doc seems redundant, prefer deleting or consolidating stale content over
duplicating another source of truth.

## Validation Matrix

Run the smallest useful checks for the files touched, then broaden when the
change crosses subsystem boundaries.

| Touched area | Minimum checks |
|---|---|
| Markdown/HTML docs | local link check, `git diff --check` |
| Public safety/security/legal | value scan, `gitleaks detect --source . --config .gitleaks.toml --no-git --redact` |
| Dashboard | `kubectl kustomize magic-cluster/apps/dashboard`; JS/API syntax checks when embedded scripts change |
| Operator/catalog/CRDs | `kubectl kustomize magic-cluster/platform/magicstick-operator` |
| Flux graph/profile | `kubectl kustomize magic-cluster/flux/entrypoints/base` and `magic-cluster/flux/entrypoints/single-node` |
| AI app or platform module | render the touched base plus `magic-cluster/platform/magicstick-operator` if catalog or dependencies changed |
| Host automation | `ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook --syntax-check magic-host/playbooks/local.yml` |
| Installer scripts | `magic-installer/build-installer-image.sh --help` and `magic-installer/write-usb.sh --help` |

The render-only demo overlay is kept as a public composition smoke test:
`kubectl kustomize examples/demo/infra-cluster/flux-bootstrap`.

## Implementation Rules

- Read the nearby manifests/docs before changing behavior.
- Use the module catalog as the source of truth for modules and instance
  mappings; do not reintroduce hardcoded dashboard module lists.
- Preserve the derived instance hostname scheme:
  `<instance-name>.<instance-type>.<domain>`.
- Keep `Appliance/local.spec` Git-owned. Runtime changes should use
  `ModuleActivation`, `ModelActivation`, `AppInstance`, or dashboard settings.
- Keep `examples/demo` render-only. Do not add static runtime seeds there unless
  they are purely public-safe smoke-test material.
- Do not commit generated installer media, caches, rendered manifests, or local
  kubeconfigs.

## Git Hygiene

- Start by checking `git status --short`.
- Never revert user changes unless explicitly asked.
- If unrelated changes exist, leave them alone.
- Keep commits scoped and mention the checks actually run.
- Before publishing, run the public release checklist in
  `docs/public-release-checklist.md`.

## Optional Repo Skills

Repo-local Codex skill sources live under `.codex/skills/`. They are onboarding
and workflow aids for agents. Keep them concise and point back to this file and
the public docs instead of duplicating large policy blocks.
