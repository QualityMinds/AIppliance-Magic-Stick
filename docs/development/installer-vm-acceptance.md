# Test the USB installer in a virtual machine

This acceptance test boots the **published reduced USB `.img`**, installs Ubuntu
onto a separate blank virtual disk, boots that disk without the installer, and
checks that Magic Stick reaches its private first-run setup state. It is more
than the [media-integrity build check](installer-images.md), and it is different
from installing a cloud VM with [cloud-init](../installation/cloud-init-vm.md).

## What the test does

1. Resolve an immutable `installer-main-*` or `installer-develop-*` candidate
   using its build-input fingerprint and verified build manifest. Download the
   image and check its SHA-256 before use.
2. Create a short-lived Spot host in the approved `qm-dev-vibecoding` Azure
   subscription. Only the CI runner's current IPv4 address may reach SSH.
3. Copy the image and edit **only the copy's `CIDATA` partition** with disposable
   autoinstall answers: DHCP, the official Ubuntu archive, a generated Linux
   identity and SSH key, and the explicitly named empty target disk. Pin the
   first-boot source to the exact test commit. The published `.img`, Ubuntu
   installer payload, target package list and Magic Stick converge command
   are not changed.
4. Boot the image as a virtual USB device under UEFI/KVM. The installer must
   power off after installation. Boot again from the 100 GiB target disk with
   the USB image detached.
5. Check Ubuntu 26.04, successful cloud-init, active K3s, a Ready Node, Ready
   `first-run-bootstrap` Flux Kustomization, `ApplianceSetup/local` in `Pending`,
   and the private setup page on the VM's forwarded test port.
6. Save a short JSON result with stage names only and delete the entire
   disposable Azure resource group. The test's SSH key, generated password,
   edited `CIDATA`, claim and raw guest logs are **not** CI artifacts.

The test stops **before** claiming the setup code or creating the first human
administrator. A pass therefore means “installed and ready for first-run
setup”, not “all product features work”. Manual installer-screen behavior,
physical USB boot, Wi-Fi, Ethernet hardware, Secure Boot and GPU inference
still require separate acceptance. A Spot eviction is an infrastructure
interruption, not proof of an installer defect.

## CI configuration

The [Installer VM acceptance workflow](../../.github/workflows/installer-vm-acceptance.yml)
runs after a successful `main` installer-image workflow, weekly on `main`, or
on manual dispatch from `main` or `develop`. Manual dispatch can be used for the
first acceptance run. The automatic test and the daily expired-resource cleanup
stay disabled until the repository variable `AZURE_INSTALLER_VM_ENABLED` is set
to `true`.

Configure the protected GitHub Actions environment `installer-vm-acceptance`
with Azure workload-identity federation and these environment secrets:

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | Application or user-assigned identity client ID |
| `AZURE_TENANT_ID` | Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | The ID of **qm-dev-vibecoding**, never a production subscription |

Grant the CI identity only the rights required to create and remove the test
resources in that dedicated development subscription. The test script refuses
any subscription whose resolved name is not `qm-dev-vibecoding`. Protect the
environment with required reviewers if CI resource creation needs an approval
gate. The workflow uses OIDC rather than storing a client secret. First run the
workflow manually; enable its recurring triggers only after this has passed.

The host is `Standard_D8s_v5` in Germany West Central, with nested
virtualization, a 160 GiB Standard SSD OS disk, and a Spot bid ceiling of
USD 0.20/hour. The test VM inside it gets 4 vCPUs and 16 GiB RAM. Spot
capacity and price are variable; provisioning can fail without implicating
Magic Stick. The resource group is tagged `purpose=magicstick-installer-vm-test`
and with an expiration time four hours after creation. The script requests and
waits for deletion on exit. A daily cleanup job removes only expired groups
whose name, location and purpose tag all match this test. If a runner is killed
before cleanup and that job is not enabled, inspect the tagged
`ms-installer-ci-*` groups in `qm-dev-vibecoding` and remove only groups that
this workflow created; the tag alone is not permission to delete another
project's resources.

The script defaults to Spot. A single explicitly approved diagnostic run may
set both `INSTALLER_VM_PRIORITY=Regular` and `ALLOW_ON_DEMAND=YES`; the scheduled
workflow never makes that cost-changing switch automatically. The current
`qm-dev-vibecoding` Germany West Central Spot quota is only three vCPUs, while
this host needs eight. Raise the Spot quota before enabling scheduled acceptance,
or keep using explicitly approved one-off regular VMs. Check current Azure
prices and quotas again before a long run; the test's disk and public IP also
incur charges.

## Local and failure checks

The VM harness is [installer_vm_acceptance.py](../../tools/installer_vm_acceptance.py).
It requires a Linux host with `/dev/kvm`, QEMU, OVMF, `mtools`, `python3-yaml`,
OpenSSH and network access to Ubuntu's mirror, GitHub and container registries.
The [Azure wrapper](../../tools/azure_installer_vm_acceptance.sh) provisions that
host and supplies an image whose checksum came from the build manifest. The
published media is not rebuilt merely to test it.

Before invoking Azure, check the local contract and shell syntax:

```bash
python3 -m unittest tests.test_installer_vm_acceptance
bash -n tools/azure_installer_vm_acceptance.sh
```

A failed run keeps only `report.json` as a CI artifact. Its stages distinguish
media preparation, installer shutdown, first boot, host convergence, Kubernetes
readiness and setup-page readiness. Raw logs and test-only credentials remain on
the VM until its resource group is deleted; they are not published. If Azure
cleanup is not confirmed, treat that as an operational failure and inspect the
named test resource group immediately. Do not rerun a failed test against the
same target disk: each run must start from an empty disk.
