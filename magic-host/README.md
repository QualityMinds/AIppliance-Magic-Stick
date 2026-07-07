# magic-host

Reusable Ansible host automation for the AI Appliance.

The playbook is intentionally generic. By default, deployments use the reusable local inventory in this repository and provide deployment-specific bootstrap values through `/etc/default/ai-appliance-repo`.

See [../docs/architecture.md](../docs/architecture.md) for the bootstrap flow,
[../docs/configuration.md](../docs/configuration.md) for host metadata, and
[../docs/operations.md](../docs/operations.md) for runtime checks.

## Entry Point

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

`magic-host/playbooks/local.yml` reads `/etc/default/ai-appliance-repo` when
present and maps these values into Ansible variables. The default
`readonly-public` installer writes only the public Flux source and
appliance-wide runtime settings; GitHub/private values are optional and only used
when `FLUX_BOOTSTRAP_MODE=github`.

| Environment value | Ansible variable |
|---|---|
| `FLUX_BOOTSTRAP_MODE` | `flux_bootstrap_mode` |
| `FLUX_PUBLIC_SYNC_PATH` | `flux_public_sync_path` |
| `MAGICSTICK_PUBLIC_REPO` | public template Git URL used by the converge runner |
| `MAGICSTICK_PUBLIC_REF` | public template tag or commit used by the converge runner |
| `MAGICSTICK_PUBLIC_REF_KIND` | public template ref field, e.g. `branch` |
| `AI_APPLIANCE_DOMAIN` | public read-only domain setting |
| `AI_APPLIANCE_DASHBOARD_HOST` | dashboard ingress hostname |
| `AI_APPLIANCE_MDNS_DOMAIN` | local mDNS domain, e.g. `magicstick.local` |
| `AI_APPLIANCE_MDNS_NAME` | local mDNS annotation suffix, e.g. `magicstick` |
| `AI_APPLIANCE_DASHBOARD_MDNS_NAME` | legacy dashboard mDNS name |

Optional overrides and GitHub bootstrap values:

| Environment value | Ansible variable |
|---|---|
| `MAGICSTICK_PUBLIC_CHECKOUT` | public template checkout path |
| `ANSIBLE_INVENTORY_PATH` | `ansible_inventory_path` |
| `ANSIBLE_PLAYBOOK_PATH` | `ansible_playbook_path` |
| `GIT_HOST` | `git_host` |
| `GIT_OWNER` | `flux_github_owner` |
| `GIT_REPO` | `flux_github_repo` |
| `GIT_BRANCH` | `flux_github_branch` |
| `FLUX_CLUSTER_PATH` | `flux_cluster_path` |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | external deployment checkout path |
| `FLUX_GITHUB_TOKEN` | `flux_github_token` |

## Converge Runner

The `ansible-pull-timer` role installs `/usr/local/sbin/ai-appliance-converge`. The runner:

- updates the pinned public template checkout
- updates the external deployment checkout in `github` mode
- runs the public playbook with the configured inventory, defaulting to the public local inventory
- uses `FLUX_GITHUB_TOKEN` through a temporary `GIT_ASKPASS` helper when a token is present

In `readonly-public` mode the runner skips the external deployment checkout and
Flux reads only the public Magicstick repository.

```bash
/usr/local/sbin/ai-appliance-converge
```

`FLUX_GITHUB_TOKEN` is a secret. Provide it at runtime or through an approved secret management mechanism. Do not commit it.
