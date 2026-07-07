# Security Policy

AIppliance-Magic-Stick is a public template for building AI appliance deployments.
Security-sensitive deployment values must live outside this repository.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities or leaked
credentials. Report security concerns privately through the repository owner's
preferred private contact channel.

If no private channel is configured yet, contact the maintainers in the owning
GitHub organization and include:

- a short description of the issue
- affected files, components, or deployment paths
- reproduction steps or proof of impact, if available
- whether any secret, token, key, kubeconfig, or private endpoint may be exposed

## Public Repository Rules

Never commit:

- API keys, access tokens, passwords, private keys, kubeconfigs, or Ansible Vault files
- generated Kubernetes Secrets or Flux bootstrap token secrets
- real domains, private IPs, private repository paths, customer names, or personal data
- filled installer metadata for a real deployment

Use runtime secrets, private overlays, or an approved secret manager integration
for real credentials.

## Supported Scope

Security review covers the reusable template files in this repository. Private
deployment repositories, local overlays, runtime credentials, and infrastructure
settings are owned by their deployment maintainers.
