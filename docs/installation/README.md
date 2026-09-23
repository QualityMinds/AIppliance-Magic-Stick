<a id="magic-stick-installieren"></a>
<a id="welche-variante-soll-ich-wählen"></a>
<a id="direkte-installationsbefehle"></a>

# Choose your installation path

| Starting point | Guide | What it installs |
|---|---|---|
| Dedicated physical computer | [USB installation](bare-metal.md) | Ubuntu, host automation, Kubernetes and Magic Stick |
| New virtual machine | [New VM with cloud-init](cloud-init-vm.md) | Host automation, Kubernetes and Magic Stick on an Ubuntu image |
| Existing dedicated Ubuntu host or VM | [Existing Ubuntu](existing-vm.md) | Host automation, Kubernetes and Magic Stick; no OS release upgrade |
| Existing Kubernetes cluster | [Existing cluster](existing-kubernetes.md) | Cluster components only; host administration remains yours |

All routes lead to [first administrator setup](first-run-setup.md),
[installation verification](verify.md) and [your first model](../get-started/first-model.md).

<a id="was-bei-allen-varianten-gleich-ist"></a>
<a id="nach-der-installation"></a>

## Shared prerequisites

Read [hardware and network requirements](../get-started/requirements.md).
Back up existing data and choose an installation target you are authorized to change.
The normal `readonly-public` workflow needs no GitHub token or private Git repository.

The current new-installation baseline is Ubuntu 26.04. Existing dedicated Ubuntu
24.04 hosts remain a legacy path. The scripts and later Flux updates do not perform
an Ubuntu release upgrade. Hardware support is a separate check, not implied by
the operating-system version.

There is no default human dashboard password. Setup creates the first administrator.
Keep its temporary `9443` endpoint private and compare the TLS fingerprint shown
on the local console or bootstrap terminal before entering the one-time claim.
