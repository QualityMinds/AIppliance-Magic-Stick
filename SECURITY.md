# Security Policy

AIppliance-Magic-Stick is a public template for building AI appliance deployments.
Security-sensitive deployment values must live outside this repository.

## Supported Versions

| Version | Security support |
|---|---|
| `main` | Best-effort security fixes before the next release. |
| Latest release tag | Best-effort security fixes for reusable template code. |
| Older release tags | Not actively supported unless a maintainer announces an exception. |

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities or leaked
credentials.

Preferred reporting path:

1. Use GitHub Private Vulnerability Reporting for this repository when available:
   `https://github.com/QualityMinds/AIppliance-Magic-Stick/security/advisories/new`.
2. If that flow is unavailable, email `hello@qualityminds.de` with the subject
   `Security report: AIppliance-Magic-Stick`.

Please include:

- a short description of the issue
- affected files, components, or deployment paths
- reproduction steps or proof of impact, if available
- whether any secret, token, key, kubeconfig, or private endpoint may be exposed

Maintainers aim to acknowledge valid reports within five business days. Public
discussion should wait until a fix, mitigation, or disclosure plan exists.

## Public Repository Rules

Never commit:

- API keys, access tokens, passwords, private keys, kubeconfigs, or Ansible Vault files
- generated Kubernetes Secrets or Flux bootstrap token secrets
- real domains, private IPs, private repository paths, customer names, or personal data
- filled installer metadata for a real deployment

Use runtime secrets, optional external overlays, or an approved secret manager
integration for real credentials.

## Supported Scope

Security review covers the reusable template files in this repository. Private
deployment repositories, local overlays, runtime credentials, and infrastructure
settings are owned by their deployment maintainers.

Out of scope for this repository:

- external deployment overlays and customer-specific values
- credentials entered into a running dashboard or cluster
- vulnerabilities in upstream third-party projects unless this repository pins,
  configures, or documents them in an unsafe way
