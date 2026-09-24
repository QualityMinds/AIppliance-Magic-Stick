<a id="installation-auf-echter-hardware"></a>

# USB installation

<a id="voraussetzungen"></a>

## Before you start

Use a dedicated x86-64 computer, an empty USB drive of at least 8 GB, a second
computer with Git and Docker or Podman, and a browser on the same private network.
Check [requirements](../get-started/requirements.md).

> The image writer erases the selected USB drive. Ubuntu installation can erase
> the selected target disk. Back up data and verify each device before confirming.

<a id="1-repository-herunterladen"></a>
<a id="2-installationsabbild-erzeugen"></a>

## 1. Build the installer

On the preparation computer:

```bash
git clone https://github.com/QualityMinds/AIppliance-Magic-Stick.git
cd AIppliance-Magic-Stick
magic-installer/build-installer-image.sh \
  --hostname magicstick-01 \
  --output dist/magicstick-installer.img
```

The builder downloads the verified Ubuntu media and adds a `CIDATA` partition.
The public default contains no access token. Consult [installer options](../../magic-installer/README.md)
for a release pin, mirror and kernel details. The present USB baseline uses Ubuntu
26.04.1's native Generic kernel, not an Ubuntu 24.04 HWE package.

Optional `--offline-pool reduced` builds remove the additional offline driver
archive; `--offline-pool online` removes the entire offline package pool. Both
preserve the installed-system files, live kernel and firmware and require a
working online mirror. `full` remains the default. Read the
[reduced-pool limitations and build reports](../../magic-installer/README.md#experimental-reduced-offline-pool)
before choosing either experimental variant. Builds never overwrite an existing
image; use a new output filename when rebuilding.

The [online installer pipeline](../development/installer-images.md) can also
provide a prebuilt test image and checksum. Its workflow summary links the
matching `main` or `develop` download. These are online-only candidates, not
physical-installation acceptance; check the evidence and channel before use.

<a id="3-usb-stick-beschreiben"></a>

## 2. Write the USB drive

```bash
magic-installer/write-usb.sh --list-devices
magic-installer/write-usb.sh \
  --image dist/magicstick-installer.img \
  --device /dev/diskN
```

Replace `/dev/diskN` with the verified whole removable disk. On Linux this might
be `/dev/sdX`; do not select a partition such as `/dev/sdX1`.

Windows PowerShell equivalents:

```powershell
.\magic-installer\build-installer-image.ps1 -Hostname magicstick-01 -Output dist\magicstick-installer.img
.\magic-installer\write-usb.ps1 -ListDevices
.\magic-installer\write-usb.ps1 -Image .\dist\magicstick-installer.img -DiskNumber <disk-number>
```

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
terminal 9; boot logs remain on terminal 1.

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
