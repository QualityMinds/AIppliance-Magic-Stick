<a id="installation-auf-echter-hardware"></a>

# USB installation

<a id="voraussetzungen"></a>

## Before you start

Use a dedicated x86-64 computer, an empty USB drive of at least 8 GB, a second
computer that can download and write a disk image, and a browser on the same
private network. **Use the prebuilt reduced installer. You do not need Git,
Docker or a local image build.** Check [requirements](../get-started/requirements.md).

> The image writer erases the selected USB drive. Ubuntu installation can erase
> the selected target disk. Back up data and verify each device before confirming.

<a id="1-repository-herunterladen"></a>
<a id="2-installationsabbild-erzeugen"></a>
<a id="1-build-the-installer"></a>

## 1. Download the installer

The download below installs **Magic Stick v1.0.0**, not a moving development
branch. Its embedded product tag, approved source commit, manifest and original
license dates are verified again at first boot. Later versions require an
explicit administrator selection; this image does not silently adopt them.

Download these two files into the same folder:

- [Reduced installer image · AMD64 / v1.0.0](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/download/installer-v1.0.0-237a730d907b84d0eaa7cf3155a4950ca2e7c1a4506c247e7accba6d36fb27f7/magicstick-installer-v1.0.0-amd64-reduced-237a730d907b84d0.img)
- [SHA-256 checksum](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/download/installer-v1.0.0-237a730d907b84d0eaa7cf3155a4950ca2e7c1a4506c247e7accba6d36fb27f7/magicstick-installer-v1.0.0-amd64-reduced-237a730d907b84d0.img.sha256)

The [download details and build evidence](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-v1.0.0-237a730d907b84d0eaa7cf3155a4950ca2e7c1a4506c247e7accba6d36fb27f7)
identify the exact source and checks. Choose the `.img` asset, **not** GitHub's
automatically generated “Source code” archives. This image uses Ubuntu Server
26.04.1 AMD64 and binds both Ansible and Flux to product commit
`8e244d1c3d99350fa5b8f96a9ac7b254924072d6`.

**Internet access is required during installation.** The image keeps Ubuntu's
signed `main` package pool so the live installer can configure supported Wi-Fi
before it has Internet access. The large optional `restricted` driver archive
is omitted; remaining packages come from your selected Ubuntu mirror. The live
kernel, firmware and installer remain included. No GitHub token, wireless
credentials or default user password are embedded.

> The [earlier online-only candidate](../development/reports/installer-installation-2026-09-24.md)
> passed an Ethernet installation on 24 September 2026, but could not bootstrap
> Wi-Fi support because it removed all local package archives. The reduced image
> corrects that packaging defect. Its automated media checks do not replace a
> physical Wi-Fi installation test; GPU and inference compatibility are checked
> separately.

Verify the checksum **before** writing the drive. On Linux, in the download folder:

```bash
sha256sum -c magicstick-installer-v1.0.0-amd64-reduced-237a730d907b84d0.img.sha256
```

On macOS, use `shasum -a 256 -c` with the same checksum filename. The result must
be `OK`. On Windows, use `Get-FileHash` in PowerShell and compare its SHA256 value
with the first value in the downloaded `.sha256` file:

```powershell
Get-FileHash .\magicstick-installer-v1.0.0-amd64-reduced-237a730d907b84d0.img -Algorithm SHA256
```

Stop if the checksum does not match. Local build scripts are
[development tools](../development/installer-images.md#local-development-builds),
not an installation prerequisite. Old develop/main images remain unchanged
development distributions, not implicit stable fallbacks.

<a id="3-usb-stick-beschreiben"></a>

## 2. Write the USB drive

1. Open a USB image-writing application that supports raw `.img` disk images.
    Examples for the computer you use to prepare the stick:

    - **Windows:** [balenaEtcher](https://etcher.balena.io/) or
      [Rufus](https://rufus.ie/en/). In Rufus, choose **DD Image mode** if asked,
      not ISO mode, so the complete disk layout including `CIDATA` is preserved.
    - **macOS:** [balenaEtcher](https://etcher.balena.io/); select the download
      for your Intel or Apple Silicon Mac.
    - **Linux:** [balenaEtcher](https://etcher.balena.io/) or
      [GNOME Disks](https://apps.gnome.org/DiskUtility/), using **Restore Disk Image**.

    Download the writer from its official site above or your distribution's
    software manager. Select the downloaded Magic Stick `.img`, not an Ubuntu ISO.

2. Select the downloaded image and the **whole USB drive**, checking its model
   and capacity. Writing erases that drive; do not select your computer's disk.
3. Write the image and allow the application's verification to finish. Copying
   the `.img` into an ordinary USB folder does not make it bootable.
4. Reconnect the USB drive if necessary. Open the small partition labelled
   `CIDATA`; do not format another partition if your operating system prompts.
5. In `meta-data`, set both values to a unique name for your appliance:

```yaml
instance-id: magicstick-01
local-hostname: magicstick-01
```

Leave `user-data` unchanged for the normal public installation. Network, mirror,
administrator account and target disk are chosen during installation. Save the
file as plain text without changing its name, then safely eject the drive.
Optional command-line writers are documented with the
[developer media tools](../../magic-installer/README.md#creating-installation-media).

<a id="4-zielrechner-installieren"></a>

## 3. Install the computer

1. Boot the target computer from USB and choose **Try or Install Ubuntu Server**.
2. In network configuration, configure an Ethernet or supported Wi-Fi interface.
   Enter the SSID/password locally; they are not embedded in the public image.
3. Verify an IP address and Internet access. Unsupported live-system drivers or
   captive portals require another connection; a plugged cable alone is not proof of connectivity.
4. Review the package mirror. A country mirror suggested by GeoIP is not a speed
   measurement. Use a reachable mirror containing the selected Ubuntu release.
5. Create the Linux administration user and optionally enable SSH. This is not
   the later dashboard account. Review the target disk and confirm installation.
6. Wait for the installer to power off, remove the stick, then power on again.

Provisioning continues after the first Ubuntu boot. Package and image downloads
can take several minutes. Cloud-init hands off to the setup console on virtual
terminal 9; boot logs remain on terminal 1. On a computer whose monitor is
connected to an NVIDIA GPU, the fetched host playbook may schedule one additional
restart after it installs the display driver. Leave the USB stick removed and
wait for the setup console to return. Fixed-version media retains its approved
host playbook; only explicitly selected development media follows `main`.

<a id="5-first-run-setup-öffnen"></a>
<a id="6-installation-prüfen"></a>

## 4. Complete setup

Use the private setup URL, one-time code and certificate fingerprint on the console.
If needed, sign in locally or over SSH and run:

```bash
sudo magicstick setup show
```

Follow [first administrator setup](first-run-setup.md), then [verify installation](verify.md).

<a id="fehlerdiagnose"></a>

## If installation stops

```bash
sudo cloud-init status --long
sudo journalctl -u cloud-final -b --no-pager
sudo journalctl -u k3s -b --no-pager
```

Keep private values out of support logs. See [platform diagnostics](../administration/troubleshooting/platform.md).
Do not reinstall or recreate the first-run marker merely to retry a failed download.
