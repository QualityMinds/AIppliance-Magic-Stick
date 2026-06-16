#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  installer/write-usb.sh --image dist/magicstick-installer.img --device /dev/diskN
  installer/write-usb.sh --list-devices

Options:
  --image PATH       Installer image to write.
  --device DEVICE   Target whole-disk device, for example /dev/disk4 or /dev/sdb.
  --list-devices    List likely removable disks.
  --dry-run         Print the actions without writing.
  --yes             Skip the typed confirmation prompt.
  -h, --help        Show this help.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

list_devices() {
  case "$(uname -s)" in
    Darwin)
      diskutil list external physical
      ;;
    Linux)
      lsblk -dpno NAME,SIZE,MODEL,TRAN,TYPE | awk '$5 == "disk" { print }'
      ;;
    *)
      die "Unsupported OS for device listing: $(uname -s)"
      ;;
  esac
}

confirm_erase() {
  local device="$1"
  local expected="ERASE $device"
  local answer

  printf 'This will erase all data on %s.\n' "$device" >&2
  printf 'Type "%s" to continue: ' "$expected" >&2
  IFS= read -r answer
  [[ "$answer" == "$expected" ]] || die "Confirmation did not match; aborting"
}

IMAGE=""
DEVICE=""
LIST_DEVICES="false"
DRY_RUN="false"
YES="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --device) DEVICE="${2:-}"; shift 2 ;;
    --list-devices) LIST_DEVICES="true"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --yes) YES="true"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

if [[ "$LIST_DEVICES" == "true" ]]; then
  list_devices
  exit 0
fi

[[ -n "$IMAGE" ]] || die "Missing --image"
[[ -n "$DEVICE" ]] || die "Missing --device"
[[ -f "$IMAGE" ]] || die "Image not found: $IMAGE"

case "$(uname -s)" in
  Darwin)
    [[ "$DEVICE" =~ ^/dev/disk[0-9]+$ ]] || die "Use a whole disk like /dev/disk4 on macOS"
    RAW_DEVICE="/dev/r${DEVICE#/dev/}"
    DD_BS="4m"
    ;;
  Linux)
    [[ -b "$DEVICE" ]] || die "Block device not found: $DEVICE"
    if [[ "$(lsblk -dn -o TYPE "$DEVICE")" != "disk" ]]; then
      die "Use a whole disk device, not a partition: $DEVICE"
    fi
    RAW_DEVICE="$DEVICE"
    DD_BS="4M"
    ;;
  *)
    die "Unsupported OS: $(uname -s)"
    ;;
esac

if [[ "$YES" != "true" ]]; then
  confirm_erase "$DEVICE"
fi

printf 'Image:  %s\n' "$IMAGE"
printf 'Target: %s\n' "$DEVICE"

if [[ "$DRY_RUN" == "true" ]]; then
  printf 'Dry run only; no data was written.\n'
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    diskutil unmountDisk "$DEVICE"
    sudo dd if="$IMAGE" of="$RAW_DEVICE" bs="$DD_BS" conv=sync
    sync
    diskutil eject "$DEVICE"
    ;;
  Linux)
    while IFS= read -r partition; do
      [[ -n "$partition" ]] || continue
      sudo umount "$partition" 2>/dev/null || true
    done < <(lsblk -lnpo NAME "$DEVICE" | tail -n +2)

    sudo dd if="$IMAGE" of="$RAW_DEVICE" bs="$DD_BS" conv=fsync status=progress
    sync
    ;;
esac

printf 'Done. The USB stick now contains the Magic-Stick installer image.\n'
