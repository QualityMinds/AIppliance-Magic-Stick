## Summary

-

## Documentation

- [ ] For new user-facing features: updated `docs/get-started/features.md` and `CHANGELOG.md` under **Unreleased**.
- [ ] Updated the relevant user guide and technical references for changed behavior.
- [ ] Listed updated documentation in this PR and explained any documentation item that does not apply.

## Public Safety

- [ ] Contains no real domains, private IPs, customer names, personal usernames, private repository paths, or deployment-specific values.
- [ ] Contains no tokens, API keys, kubeconfigs, private keys, generated Kubernetes Secrets, or Ansible Vault files.
- [ ] Keeps deployment-specific behavior in private overlays or runtime settings.

## Validation

- [ ] `gitleaks detect --source . --config .gitleaks.toml --no-git --redact`
- [ ] `gitleaks detect --source . --config .gitleaks.toml --redact`
- [ ] `ANSIBLE_ROLES_PATH=magic-host/roles ansible-playbook --syntax-check magic-host/playbooks/local.yml`
- [ ] Relevant `kubectl kustomize ...` targets
