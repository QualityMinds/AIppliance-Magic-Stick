# AGENTS.md

Review guidelines for this repository.

## Public Template Boundary

- Keep this repository reusable and deployment-neutral.
- Keep real deployment configuration in private repositories.
- Do not add real domains, hostnames, emails, private IPs, personal usernames, repository URLs, Flux paths, model selections, or storage sizing directly to this repository.
- Use `example.local`, `example.com`, `CHANGEME`, or documented variables in public files.

## Kustomize Review

- Public Kubernetes manifests should be reusable bases.
- Deployment-specific changes should stay in private overlays.
- Private deployment overlays should import these bases from `vendor/magicstick`, which Flux provides through `GitRepository.spec.include`.
- `magic-cluster/apps/ai/kustomization.yaml` should remain model-neutral; deployment overlays select model resources and patch LiteLLM, AnythingLLM, and KubeOpenCode.
- Verify public examples with `kubectl kustomize`.

## Secret Review

- Never commit generated secrets, PATs, kubeconfigs, private keys, Ansible Vault files, or filled installer tokens.
- Kubernetes `Secret` manifests in public may contain only generated-secret annotations and non-sensitive placeholders.
- `FLUX_GITHUB_TOKEN`, API keys, admin passwords, and cloud credentials must be supplied at runtime or through approved secret management.
- Run Gitleaks before public release.

## Documentation Review

- Update `README.md` when layout or entry points change.
- Update `docs/public-release-checklist.md` when adding new classes of deployment-specific values.
- New examples must use safe placeholder values.
