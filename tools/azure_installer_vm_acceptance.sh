#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Run the *published USB installer* inside QEMU on a disposable Azure Spot VM.
set -euo pipefail

usage() {
  echo 'Usage: AZURE_SUBSCRIPTION=<id> SOURCE_REVISION=<40-hex> INSTALLER_TAG=<tag> INSTALLER_IMAGE=<name> INSTALLER_SHA256=<64-hex> tools/azure_installer_vm_acceptance.sh' >&2
  exit 2
}

: "${AZURE_SUBSCRIPTION:?Set the approved Azure subscription ID or name}"
: "${SOURCE_REVISION:?Set the exact Git source revision}"
: "${INSTALLER_TAG:?Set the verified immutable installer tag}"
: "${INSTALLER_IMAGE:?Set the verified installer image name}"
: "${INSTALLER_SHA256:?Set the verified image checksum}"
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$INSTALLER_SHA256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$INSTALLER_TAG" =~ ^installer-(main|develop)-[0-9a-f]{64}$ ]] || usage
[[ "$INSTALLER_IMAGE" =~ ^magicstick-installer-(main|develop)-amd64-reduced-[0-9a-f]{16}\.img$ ]] || usage

readonly REGION=germanywestcentral
readonly SIZE=Standard_D8s_v5
readonly PRICE_CAP_USD=0.20
readonly VM_PRIORITY="${INSTALLER_VM_PRIORITY:-Spot}"
spot_options=(--priority Spot --eviction-policy Delete --max-price "$PRICE_CAP_USD")
if [[ "$VM_PRIORITY" == Regular ]]; then
  if [[ "${ALLOW_ON_DEMAND:-}" != YES ]]; then
    echo 'Regular VM use requires explicit ALLOW_ON_DEMAND=YES approval' >&2
    exit 2
  fi
  spot_options=()
elif [[ "$VM_PRIORITY" != Spot ]]; then
  echo 'INSTALLER_VM_PRIORITY must be Spot or Regular' >&2
  exit 2
fi
readonly RUN_ID="${GITHUB_RUN_ID:-$(date +%s)}"
readonly RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
[[ "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || usage
readonly GROUP="ms-installer-ci-${RUN_ID}-${RUN_ATTEMPT}"
readonly VM=installer-host
readonly NSG=installer-ci-nsg
readonly DOWNLOAD="https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/download/${INSTALLER_TAG}/${INSTALLER_IMAGE}"
readonly TEMP_DIR="$(mktemp -d)"
readonly SSH_KEY="$TEMP_DIR/ssh_key"
readonly KNOWN_HOSTS="$TEMP_DIR/known_hosts"

created=false
cleanup() {
  local prior=$?
  trap - EXIT HUP INT TERM
  if [[ "$created" == true ]]; then
    echo '[cleanup] deleting the disposable Azure resource group' >&2
    if ! az group delete --subscription "$AZURE_SUBSCRIPTION" --name "$GROUP" --yes --no-wait --output none; then
      echo "[cleanup] deletion request FAILED for $GROUP; remove this test-only group immediately" >&2
      prior=1
    elif ! az group wait --subscription "$AZURE_SUBSCRIPTION" --name "$GROUP" --deleted --interval 15 --timeout 600 --output none; then
      echo "[cleanup] deletion not confirmed for $GROUP; inspect Azure before another run" >&2
      prior=1
    fi
  fi
  rm -rf -- "$TEMP_DIR"
  exit "$prior"
}
trap cleanup EXIT HUP INT TERM

account_name="$(az account show --subscription "$AZURE_SUBSCRIPTION" --query name --output tsv)"
if [[ "$account_name" != qm-dev-vibecoding ]]; then
  echo "Refusing Azure subscription '$account_name': only qm-dev-vibecoding is approved" >&2
  exit 1
fi
source_ip="$(curl --fail --silent --show-error --max-time 15 https://api.ipify.org)"
python3 - "$source_ip" <<'PY'
import ipaddress
import sys
value = ipaddress.ip_address(sys.argv[1])
if value.version != 4 or not value.is_global:
    raise SystemExit('The runner needs one routable IPv4 address for a locked SSH rule')
PY
ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY"
expires_at="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(hours=4)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)"

echo "[azure] creating disposable $VM_PRIORITY test group in $account_name / $REGION"
az group create --subscription "$AZURE_SUBSCRIPTION" --name "$GROUP" --location "$REGION" \
  --tags purpose=magicstick-installer-vm-test "expiresAt=$expires_at" --output none
created=true
az network nsg create --subscription "$AZURE_SUBSCRIPTION" --resource-group "$GROUP" \
  --name "$NSG" --location "$REGION" --output none
az network nsg rule create --subscription "$AZURE_SUBSCRIPTION" --resource-group "$GROUP" \
  --nsg-name "$NSG" --name ci-ssh --priority 100 --access Allow --direction Inbound \
  --protocol Tcp --source-address-prefixes "$source_ip/32" --source-port-ranges '*' \
  --destination-address-prefixes '*' --destination-port-ranges 22 --output none

public_ip="$(az vm create --subscription "$AZURE_SUBSCRIPTION" --resource-group "$GROUP" \
  --name "$VM" --location "$REGION" --image Ubuntu2404 --size "$SIZE" \
  "${spot_options[@]}" \
  --admin-username azureci --authentication-type ssh --ssh-key-values "$SSH_KEY.pub" \
  --os-disk-size-gb 160 --storage-sku StandardSSD_LRS --public-ip-sku Standard \
  --nsg "$NSG" --nsg-rule NONE --query publicIpAddress --output tsv)"
if [[ -z "$public_ip" ]]; then
  echo '[azure] VM has no public IP; refusing to weaken the network rule' >&2
  exit 1
fi

ssh_options=(-i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
remote="azureci@$public_ip"
echo '[azure] waiting for restricted SSH access'
ready=false
for _ in $(seq 1 60); do
  if ssh "${ssh_options[@]}" "$remote" true 2>/dev/null; then
    ready=true
    break
  fi
  sleep 10
done
if [[ "$ready" != true ]]; then
  echo '[azure] SSH unavailable; check Spot capacity and VM provisioning' >&2
  exit 1
fi

echo '[host] installing QEMU, OVMF and CIDATA tools'
ssh "${ssh_options[@]}" "$remote" \
  'sudo cloud-init status --wait >/dev/null && sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y qemu-system-x86 ovmf mtools python3-yaml curl openssl openssh-client && sudo usermod -aG kvm azureci'
if ! ssh "${ssh_options[@]}" "$remote" 'test -r /dev/kvm && test -w /dev/kvm'; then
  echo '[host] nested KVM is unavailable to the test user' >&2
  exit 1
fi

echo '[host] copying this test harness and fetching the published installer'
scp "${ssh_options[@]}" tools/installer_vm_acceptance.py "$remote:installer_vm_acceptance.py"
ssh "${ssh_options[@]}" "$remote" \
  "curl --fail --location --retry 5 --retry-all-errors --output '$INSTALLER_IMAGE' '$DOWNLOAD' && echo '$INSTALLER_SHA256  $INSTALLER_IMAGE' | sha256sum --check --status"

echo '[test] booting USB media, installing the target, then checking first-run readiness'
test_status=0
ssh "${ssh_options[@]}" "$remote" \
  "python3 installer_vm_acceptance.py --image '$INSTALLER_IMAGE' --expected-sha256 '$INSTALLER_SHA256' --source-revision '$SOURCE_REVISION' --work installer-vm-work --memory-mib 16384 --cpus 4 --disk-gb 100 --install-timeout 4500 --boot-timeout 900 --bootstrap-timeout 4500 --platform-timeout 900" || test_status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  if [[ "$test_status" -eq 0 ]]; then
    printf '### Installer VM acceptance passed\n\nPublished USB image `%s` installed Ubuntu 26.04 and reached first-run setup in an isolated UEFI VM. This is not physical USB/Wi-Fi/GPU acceptance.\n' "$INSTALLER_IMAGE" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '### Installer VM acceptance failed or was interrupted\n\nInspect the sanitized report. Spot eviction is infrastructure interruption, not evidence of a product regression.\n' >> "$GITHUB_STEP_SUMMARY"
  fi
fi

if [[ -n "${INSTALLER_VM_REPORT:-}" ]]; then
  scp "${ssh_options[@]}" "$remote:installer-vm-work/report.json" "$INSTALLER_VM_REPORT" || true
fi
if [[ "$test_status" -ne 0 ]]; then
  if ! az vm show --subscription "$AZURE_SUBSCRIPTION" --resource-group "$GROUP" --name "$VM" --output none 2>/dev/null; then
    echo '[test] Spot VM disappeared during the test; classify as infrastructure interruption' >&2
  fi
  exit "$test_status"
fi
