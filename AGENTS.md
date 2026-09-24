# Magic Stick project instructions

## Product and architecture

- Build for users and administrators without Kubernetes experience. Keep the
  normal path simple and technical detail available separately.
- `readonly-public` plus dashboard/runtime configuration is the default.
  External GitOps repositories and overlays are optional advanced integrations.
- Installation defaults follow `main`; development versions follow explicit
  `develop` opt-in. A main merge is deployment-eligible, not gated by creating a
  GitHub Release. Keep development image aliases and promotions separate.
- Keep `Appliance/local.spec` Git-owned. Clients use the shared API and runtime
  intent (`ModuleActivation`, `ModelActivation`, `AppInstance`, settings and
  existing host-operation APIs); controllers create the resulting workloads.
- Use existing module, application and compute-target catalogs and typed API
  contracts. Do not create parallel lists, orchestration paths or capability rules.
- Preserve `<instance-name>.<instance-type>.<domain>` for instance hostnames and
  compatibility of saved settings and existing engine/model lifecycles.
- Verify new runtime flags and hardware claims against the selected upstream
  version. A detected device or green operator is not proof of working inference.
- Treat [LICENSE](LICENSE), [LICENSING.md](LICENSING.md) and
  [third-party notices](THIRD_PARTY_NOTICES.md) as authoritative. Do not invent
  editions, entitlements or distribution approval in UI or documentation.

## Scope and public safety

- Check the working tree first; preserve unrelated changes and keep commits scoped.
- Analysis means inspect and explain. Implementation permits scoped local edits
  and checks, not an unrequested commit, push or live deployment.
- Commit/push, Pages publication, container publication and appliance rollout are
  separate outcomes. Follow the requested scope; a skill never grants authority.
  Normal CI side effects of an authorized push are not manual rollout verification.
- Live inspection is read-only unless the task authorizes remediation. Reboots,
  network/firmware changes, deleting workloads or clearing caches need authority
  covering that disruption. Do not clear operation state to force a retry.
- Never publish credentials, private keys, kubeconfigs, decoded Secrets, personal
  data or private deployment values in files, screenshots, logs or test output.
  Use `example.local`, `example.com`, `CHANGEME`, synthetic fixtures, generated
  Secrets or documented variables. Public upstream/project URLs are not secrets.
- Keep deployment-specific storage sizes, model selections and runtime seeds out
  of reusable bases. Keep `examples/demo` render-only and public-safe.
- Do not commit generated installer media, caches, build output or local access
  files. Versioned documentation images/diagrams follow their provenance rules.

## Area guidance and documentation

Read [dashboard/AGENTS.md](dashboard/AGENTS.md) for clients or shared API changes
(including API code under `magic-cluster/apps/dashboard`). Read
[docs/AGENTS.md](docs/AGENTS.md) for README, handbook, website or public collateral.
Use the smallest relevant set of skills below; detailed procedures stay in docs.

Update the matching contract when behavior changes:

| Change | Canonical sources |
|---|---|
| Dashboard, API, authorization | [Development](docs/development/dashboard.md), [API](docs/reference/dashboard-api.md), [user guide](docs/user-guide/dashboard.md) |
| Model configuration/lifecycle/routing | [Model integration](docs/development/model-integration.md), [controls](docs/reference/model-controls.md), [catalog](docs/reference/model-catalog.md), `docs/user-guide/models/` |
| Catalogs, controllers, CRDs, modules | [Modules](docs/reference/module-catalog.md), [resources](docs/reference/kubernetes-resources.md), [controllers](docs/concepts/controllers.md), [application controls](docs/reference/application-controls.md) |
| Host, installer, network, GPU | [Host management](docs/administration/host-management.md), [configuration](docs/reference/configuration.md), `docs/installation/`, `magic-host/README.md`, `magic-installer/README.md` |
| Flux, overlays, images | [Architecture](docs/concepts/architecture.md), [overlays](docs/development/gitops-overlays.md), [image promotion](docs/development/image-promotion.md), [notices](THIRD_PARTY_NOTICES.md) |
| Website, handbook, public project process | [Documentation](docs/development/documentation.md), [website](docs/development/website.md), root README/legal/support/governance files as affected |

Legacy root documentation pages are compatibility links, not editing targets.
Preserve old paths/anchors through `docs/migration.json`; do not duplicate guides.

## Validation and completion

Run checks proportionate to touched behavior and broaden for shared contracts.
Commands below run from the repository root unless noted. Use the documented
environment/locked dependencies; a missing tool is a reported gap, not a pass.

| Area | Checks to select |
|---|---|
| Instructions/skills | `python tools/check_agent_guidance.py`; `python -m unittest tests.test_agent_guidance` |
| Docs/website | With `requirements-docs.txt`: `python -m unittest tests.test_docs tests.test_website`; `python tools/docs.py build`; changed site JS: `node --check docs/site.js` |
| Dashboard clients | In `dashboard/`: `pnpm typecheck`, `pnpm test`, `pnpm build`; inspect changed UI at desktop/mobile sizes |
| Dashboard API | Relevant tests in `magic-cluster/apps/dashboard` and `dashboard/apps/api`; render `magic-cluster/apps/dashboard` if deployment/RBAC changes |
| Operator/catalog/CRDs | Relevant tests in `magic-cluster/platform/magicstick-operator/controller`; render that base and affected modules |
| Flux graph/profile | Render `magic-cluster/flux/entrypoints/base`, `magic-cluster/flux/entrypoints/single-node` and affected bases; demo composition if affected |
| Host automation | Affected role tests; `ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook --syntax-check magic-host/playbooks/local.yml` for Ansible changes |
| Installer | Shell syntax/CLI checks and relevant `tests/test_install_entrypoints.py`, `tests/test_installer_network.py`, `tests/test_installer_boot.py`, `tests/test_git_http_fallback.py` |

- Use `kubectl kustomize <base>` for a local render; it does not validate a live cluster.
- Run `git diff --check`; scan public changes with
  `gitleaks detect --source . --config .gitleaks.toml --no-git --redact` before publishing.
- Select applicable sections of the [release checklist](docs/development/release-checklist.md).
  Full distribution acceptance is not required for an unrelated documentation edit.
  Keep normal license review advisory; strict distribution review is explicit.
  Secret, source-consistency and relevant runtime failures remain errors.
- Report local checks, skipped/unavailable checks, source publication, image build,
  digest promotion and live acceptance separately. CI started is not CI passed.
  A source push is not a rollout; an offline appliance is not verified deployed.

## Repository skills

Skills live in `.agents/skills/`, without duplicate copies in `.codex/skills/`:

- [Dashboard/runtime](.agents/skills/magicstick-dashboard-runtime/SKILL.md)
- [GitOps/modules](.agents/skills/magicstick-gitops-module/SKILL.md)
- [Host/hardware](.agents/skills/magicstick-host-hardware/SKILL.md)
- [Documentation/website](.agents/skills/magicstick-docs-website/SKILL.md)
- [Publication/rollout](.agents/skills/magicstick-publish-rollout/SKILL.md)
- [Versioned releases](.agents/skills/magicstick-release/SKILL.md)

General safety and ownership rules belong here, not in a catch-all maintenance
skill. Keep each skill concise, link canonical procedures, and validate its
metadata/references plus realistic task boundaries after changing it.
