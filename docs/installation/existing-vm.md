<a id="installation-auf-einem-bestehenden-linux-system"></a>

# Install on an existing Ubuntu host

<a id="voraussetzungen"></a>

## Before you start

Use a dedicated Ubuntu 26.04 host/VM, or the supported legacy Ubuntu 24.04 path.
You need sudo, Internet access and private administrative access. Take a full
backup or VM snapshot first. Do not use this route on a shared application server
or a computer already running Kubernetes; use the [existing-cluster route](existing-kubernetes.md) instead.

The installer checks architecture, available space (at least 40 GiB), existing
Magic Stick/K3s state and required ports, including `443` and `9443`. Passing
preflight is not a guarantee that your chosen AI model fits.

<a id="empfohlener-weg-ein-installationsskript"></a>
<a id="manueller-fallback"></a>
<a id="1-basispakete-installieren"></a>
<a id="2-runtime-einstellungen-anlegen"></a>
<a id="3-repository-installieren"></a>
<a id="4-neuinstallation-markieren"></a>
<a id="5-installation-starten"></a>

## Install

Download and inspect the script instead of piping a remote download into a root shell:

```bash
curl -fsSL https://raw.githubusercontent.com/QualityMinds/AIppliance-Magic-Stick/main/install-from-linux.sh \
  -o /tmp/install-from-linux.sh
less /tmp/install-from-linux.sh
sudo bash /tmp/install-from-linux.sh --preflight-only
sudo bash /tmp/install-from-linux.sh
```

The wrapper shows the source and target directory, checks out the requested source,
creates the new-install marker once, and invokes host convergence. By default the
host and Flux continue following **main**, the release channel, just like USB,
cloud-init and existing-cluster installations. `--ref develop` explicitly selects
development builds. A supplied release tag or full commit SHA stays pinned;
use `--help` for the supported options. See [release channels](../administration/updates-rollback.md#release-channels).
The host's Ubuntu release and existing kernel flavor are not silently replaced.

<a id="first-run-setup-abschließen"></a>
<a id="installation-prüfen"></a>

## Verify and continue

```bash
sudo systemctl status k3s --no-pager
sudo k3s kubectl get nodes
sudo magicstick setup show
```

Complete [first administrator setup](first-run-setup.md), then
[verify the appliance](verify.md). If a download or package step fails, inspect
[host logs](../administration/troubleshooting/platform.md) before retrying.

<a id="bestehende-magic-stick-installation-aktualisieren"></a>

## Existing Magic Stick installations

This wrapper is a new-installation tool, not an update or reset command. Never
recreate `/var/lib/magicstick/setup/new-install` on an established appliance.
Use [updates and rollback](../administration/updates-rollback.md) instead.
An Ubuntu 24.04 installation stays on 24.04 until a separately planned OS migration.

For platform maintainers, the canonical manual sequence is implemented in
[install-from-linux.sh](../../install-from-linux.sh) and the
[host playbook](../../magic-host/playbooks/local.yml); do not maintain a second
hand-copied bootstrap procedure with different safety checks.
