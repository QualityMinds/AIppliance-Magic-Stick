# infra-host

Reusable Ansible host automation for the AI Appliance.

The playbook is intentionally generic. Deployment-specific inventory and bootstrap values belong under `deployments/<name>/infra-host`.

## Entry Point

```bash
ANSIBLE_ROLES_PATH=infra-host/roles \
  ansible-playbook --syntax-check infra-host/playbooks/local.yml
```

`infra-host/playbooks/local.yml` reads `/etc/default/ai-appliance-repo` when present and maps these values into Ansible variables:

| Environment value | Ansible variable |
|---|---|
| `GIT_HOST` | `git_host` |
| `GIT_OWNER` | `flux_github_owner` |
| `GIT_REPO` | `flux_github_repo` |
| `GIT_BRANCH` | `flux_github_branch` |
| `FLUX_CLUSTER_PATH` | `flux_cluster_path` |
| `ANSIBLE_INVENTORY_PATH` | `ansible_inventory_path` |
| `ANSIBLE_PLAYBOOK_PATH` | `ansible_playbook_path` |
| `FLUX_GITHUB_TOKEN` | `flux_github_token` |

## ansible-pull

A deployment should call the public playbook with its own inventory:

```bash
ansible-pull \
  -U "$REPO_URL" \
  -C "$GIT_BRANCH" \
  -i "deployments/<name>/infra-host/inventory/localhost.yml" \
  -e "monorepo_url=$REPO_URL" \
  -e "flux_github_owner=$GIT_OWNER" \
  -e "flux_github_repo=$GIT_REPO" \
  -e "flux_github_branch=$GIT_BRANCH" \
  -e "flux_cluster_path=$FLUX_CLUSTER_PATH" \
  -e "flux_github_token=$FLUX_GITHUB_TOKEN" \
  infra-host/playbooks/local.yml
```

`FLUX_GITHUB_TOKEN` is a secret. Provide it at runtime or through an approved secret management mechanism. Do not commit it.
