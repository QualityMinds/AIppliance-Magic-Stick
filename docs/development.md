# Development

This repository is a public template. Development work should preserve the
boundary between reusable public bases and private deployment overlays.

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
kubectl kustomize magic-cluster/platform/ai
kubectl kustomize magic-cluster/platform/observability
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/apps/ai
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

For host automation changes:

```bash
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
- Put real domains, storage sizes, model selections, and secret integrations in
  private overlays.
- Public Kubernetes manifests should be reusable bases, not one-off deployment
  manifests.
- Public Secret manifests may only use generated-secret annotations,
  non-sensitive placeholders, or references to runtime Secrets.
- Update documentation when adding variables, entrypoints, apps, profiles, or
  operator dependencies.

## Adding A Cluster Base

1. Add the base under the narrowest existing ownership path.
2. Reuse existing Kustomize and HelmRelease patterns.
3. Add Flux health checks only when later waves require the resource to be
   ready.
4. Keep values generic and safe by default.
5. Render both the standalone base and any aggregate base that imports it.
6. Update [architecture.md](architecture.md), [configuration.md](configuration.md),
   or [gitops-overlays.md](gitops-overlays.md) when the public contract changes.

## Adding A Module

1. Add or reuse a public-safe Kustomize base.
2. Add a catalog entry in
   `magic-cluster/platform/magicstick-operator/module-catalog.yaml`.
3. Choose a stable generated Flux `kustomizationName`.
4. Document required CRDs and dependencies.
5. Add or update `Appliance` examples when the module is user-selectable.
6. Render `magic-cluster/platform/magicstick-operator` and any touched base.

## Adding An App Variable

1. Use a documented `AI_APPLIANCE_*` name.
2. Provide a safe default with Flux substitution.
3. Quote YAML strings when values may contain special characters.
4. Add the variable to [configuration.md](configuration.md).
5. Add release-review coverage to [public-release-checklist.md](public-release-checklist.md).

## Adding A Secret

Prefer one of these patterns:

- generated Secret with secret-generator annotations
- `valueFrom.secretKeyRef` pointing to a Secret supplied by a private overlay
- external secret manager integration in a private deployment repository

Never commit real secret data. When debugging, avoid copying decoded Secret
values into logs, issues, commits, or docs.

## Adding An Operator-Backed App

Use two layers:

- `magic-cluster/platform/ai/<name>-operator` for the operator, HelmRepository,
  HelmRelease, namespace, CRDs, and operator RBAC patches.
- `magic-cluster/apps/ai/<name>` for reusable app instances or CRs.

This keeps CRD availability in the infrastructure wave and app lifecycle in the
app wave.

## Release Validation

Run the public release checklist before tagging a public version:

```bash
kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
gitleaks detect --source . --config .gitleaks.toml --no-git
```

Also run the value scans from
[public-release-checklist.md](public-release-checklist.md). Expected findings
must be documented and safe.
