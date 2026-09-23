<a id="neue-virtuelle-maschine-mit-cloud-init"></a>

# Install a new VM with cloud-init

<a id="sicherheits--und-netzwerkhinweise"></a>

## Before you start

Choose a fresh Ubuntu 26.04 VM with cloud-init support, private administrative
access and enough resources for the platform and selected models. Ubuntu 24.04
remains a legacy host option. The provider's kernel is not replaced by this example.
Check [requirements](../get-started/requirements.md) and GPU support independently.

Limit SSH to your administration network. Keep setup port `9443` private; never
open it to the Internet. Plan access through a VPN, private network or bastion
where necessary. Use the private IP for setup because cloud networks rarely route mDNS.

<a id="1-cloud-init-vorbereiten"></a>

## 1. Prepare cloud-init

Download the repository's [cloud-init example](../assets/examples/magicstick-cloud-init.yaml).
Review its entire contents before use. Adjust the example domain and, if needed,
the public source revision. Do not insert passwords, access tokens or private keys.

The example installs bootstrap dependencies, writes root-only runtime metadata,
creates the first-install marker and invokes the existing host-convergence runner.
It is for a **new VM only**. Never replay it on a completed appliance or reuse the
first-install marker as a recovery mechanism.

The example starts from the public `main` branch. For a repeatable release,
select a published tag and set `MAGICSTICK_PUBLIC_REF_KIND=tag` alongside that ref.
Use the same revision for installation and subsequent maintenance.

<a id="2-vm-bei-hetzner-cloud-erstellen"></a>
<a id="3-vm-bei-microsoft-azure-erstellen"></a>

## 2. Create the VM

1. Create a private network and an appropriately sized Ubuntu VM.
2. Add your SSH public key and configure restrictive network rules.
3. Supply the complete YAML as cloud-init user data (for example **Cloud config**
   or **Custom Data**), not as an ordinary shell startup script.
4. Create the VM. Keep its serial/recovery console available.

Provider images and labels vary; use the provider's Ubuntu image, not a guessed
image ID. A GPU VM also needs supported device passthrough and host drivers.

<a id="4-bereitstellung-beobachten"></a>

## 3. Observe provisioning

```bash
sudo cloud-init status --wait
sudo cloud-init status --long
sudo systemctl status k3s --no-pager
sudo magicstick setup show
```

Platform reconciliation can continue after cloud-init finishes. Use the setup URL,
claim and TLS fingerprint from the last command to complete
[first administrator setup](first-run-setup.md). Then [verify the appliance](verify.md).

<a id="fehlerdiagnose"></a>

## If provisioning fails

Inspect `sudo journalctl -u cloud-final -b --no-pager` and the
[platform diagnostics](../administration/troubleshooting/platform.md). Confirm the
provider actually delivered cloud-init data, that outbound downloads work and that
your private administration route is reachable. Do not rebuild a VM containing
data without a recovery plan.
