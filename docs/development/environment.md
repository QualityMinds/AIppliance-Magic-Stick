# Development environment

This repository is a public template. Development work should preserve the
boundary between reusable public bases and runtime or deployment-specific
values.

## Local Workflow

Start by checking the worktree:

```bash
git status --short --branch
```

Render the areas you touch. For broad cluster changes, run:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/platform/ai/agent-sandbox
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

For host automation changes:

```bash
ansible-galaxy collection install -r magic-host/requirements.yml
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

For installer CLI changes:

```bash
magic-installer/build-installer-image.sh --help
magic-installer/write-usb.sh --help
```

## Public Template Rules

- Keep real deployment values out of the public repository.
- Use `example.local`, `example.com`, `CHANGEME`, or documented variables.
- Put real domains, storage sizes, model selections, runtime CR seeds, and
  secret integrations in runtime settings, runtime CRs, Secrets, or optional
  external overlays.
- Public Kubernetes manifests should be reusable bases, not one-off deployment
  manifests.
- Public Secret manifests may only use generated-secret annotations,
  non-sensitive placeholders, or references to runtime Secrets.
- Update documentation when adding variables, entrypoints, apps, profiles, or
  operator dependencies.

## Agent Instructions And Skills

Read [AGENTS.md](../../AGENTS.md) for product boundaries, source ownership,
public safety, task scope and proportionate checks. Area instructions in
[dashboard/AGENTS.md](../../dashboard/AGENTS.md) and `docs/AGENTS.md` add client/UI
and public-content conventions. The root instructions explicitly route to them,
including for API code outside the client workspace and the root README.

Open the actual `AIppliance-Magic-Stick` repository as the working directory, not
only its parent checkout folder. Codex discovers repository skills under
`.agents/skills/`; start a fresh task/session to verify the loaded instructions and
available skills after reorganizing them. See the official
[instruction discovery](https://developers.openai.com/codex/guides/agents-md) and
[skill discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)
documentation. These are repository files, not a required global plugin install.

| Skill | When to use |
|---|---|
| [magicstick-dashboard-runtime](../../.agents/skills/magicstick-dashboard-runtime/SKILL.md) | Dashboard, API, client contracts, model controls and runtime behavior |
| [magicstick-gitops-module](../../.agents/skills/magicstick-gitops-module/SKILL.md) | Catalogs, controllers, CRDs, module lifecycle and Flux composition |
| [magicstick-host-hardware](../../.agents/skills/magicstick-host-hardware/SKILL.md) | Installer, networking, updates, kernels, GPU drivers and memory/sharing |
| [magicstick-docs-website](../../.agents/skills/magicstick-docs-website/SKILL.md) | README, handbook, landing pages, screenshots and diagrams |
| [magicstick-publish-rollout](../../.agents/skills/magicstick-publish-rollout/SKILL.md) | Requested source publication, Pages, image promotion and appliance rollout |
| [magicstick-release](../../.agents/skills/magicstick-release/SKILL.md) | Versioned release preparation, immutable date records, evidence and optional release draft |

Choose only the relevant skill(s) and references. Skills are automatically
selectable and may also be invoked by their `$skill-name`. Their instructions do
not authorize extra operations. General maintenance rules now live in `AGENTS.md`;
duplicate `.codex/skills/` copies are removed. The focused release skill uses the
[release procedure](releases.md) and does not replace publication authorization.
Keep detailed procedures in canonical docs, not copied into each skill.

With the documentation dependencies installed, run:

```sh
python tools/check_agent_guidance.py
python -m unittest tests.test_agent_guidance tests.test_docs tests.test_website
python tools/docs.py build
```

The existing documentation CI checks skill metadata, naming, duplicate legacy
entries and local instruction/reference links on relevant changes and its weekly
run. It does not execute skill commands, access an appliance or prove agent decisions.
After substantive workflow edits, use these manual acceptance scenarios in a fresh
session without granting unrelated external writes:

| Example request | Expected routing and boundary |
|---|---|
| Change landing-page text | Docs/website; update equivalent languages and run static checks; no appliance work |
| Add an editable model parameter | Dashboard/runtime; trace saved config, API and controller; add GitOps skill only if orchestration changes |
| Analyze GPU startup delay | Host/hardware; read-only evidence across boot/driver/registration/runtime; no implicit restart or reinstall |
| Commit and push only | Publish/rollout source path; verify remote revision; no manual image promotion or cluster mutation |
| Roll out a dashboard fix | Publish/rollout; source build, coordinated immutable digests, Flux and changed live behavior checked separately |
| Target appliance is offline | Stop at the last verified stage; report pending live acceptance, not a completed rollout |

Inspect skill selection and observable scope/results, not exact response wording.
Avoid duplicating broad instructions or adding a new skill for every one-off fix.
