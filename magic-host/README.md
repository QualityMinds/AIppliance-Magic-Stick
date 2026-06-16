# magic-host

Reusable Ansible host automation for the AI Appliance.

The playbook is intentionally generic. By default, deployments use the reusable local inventory in this repository and provide deployment-specific bootstrap values through `/etc/default/ai-appliance-repo`.

## Entry Point

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml
```

`magic-host/playbooks/local.yml` reads `/etc/default/ai-appliance-repo` when present and maps these values into Ansible variables:

| Environment value | Ansible variable |
|---|---|
| `GIT_HOST` | `git_host` |
| `GIT_OWNER` | `flux_github_owner` |
| `GIT_REPO` | `flux_github_repo` |
| `GIT_BRANCH` | `flux_github_branch` |
| `FLUX_BOOTSTRAP_MODE` | `flux_bootstrap_mode` |
| `FLUX_CLUSTER_PATH` | `flux_cluster_path` |
| `FLUX_PUBLIC_SYNC_PATH` | `flux_public_sync_path` |
| `ANSIBLE_INVENTORY_PATH` | `ansible_inventory_path` |
| `ANSIBLE_PLAYBOOK_PATH` | `ansible_playbook_path` |
| `MAGICSTICK_PUBLIC_REPO` | public template Git URL used by the converge runner |
| `MAGICSTICK_PUBLIC_REF` | public template tag or commit used by the converge runner |
| `MAGICSTICK_PUBLIC_REF_KIND` | public template ref field, e.g. `branch` |
| `MAGICSTICK_PUBLIC_CHECKOUT` | public template checkout path |
| `AI_APPLIANCE_PRIVATE_CHECKOUT` | private deployment checkout path |
| `AI_APPLIANCE_*` | public read-only domain and storage settings |
| `FLUX_GITHUB_TOKEN` | `flux_github_token` |

## Converge Runner

The `ansible-pull-timer` role installs `/usr/local/sbin/ai-appliance-converge`. The runner:

- updates the pinned public template checkout
- updates the private deployment checkout in `github` mode
- runs the public playbook with the configured inventory, defaulting to the public local inventory
- uses `FLUX_GITHUB_TOKEN` through a temporary `GIT_ASKPASS` helper when a token is present

In `readonly-public` mode the runner skips the private deployment checkout and
Flux reads only the public Magicstick repository.

```bash
/usr/local/sbin/ai-appliance-converge
```

`FLUX_GITHUB_TOKEN` is a secret. Provide it at runtime or through an approved secret management mechanism. Do not commit it.
