#!/usr/bin/env bash
set -euo pipefail

DEFAULT_UBUNTU_ISO_URL="https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-live-server-amd64.iso"
DEFAULT_UBUNTU_ISO_SHA256="e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433"

usage() {
  cat <<'USAGE'
Usage:
  magicstick-build-installer-image --output /output/magicstick-installer.img

This command is intended to run inside the Magic-Stick installer builder
container. Build inputs are passed via MAGICSTICK_* environment variables.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    die "Missing required environment variable: $name"
  fi
}

sed_escape_replacement() {
  printf '%s' "$1" | sed -e 's/[\/&|\\]/\\&/g'
}

replace_literal() {
  local file="$1"
  local search="$2"
  local replacement="$3"
  local escaped

  escaped="$(sed_escape_replacement "$replacement")"
  sed -i "s|${search}|${escaped}|g" "$file"
}

set_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped

  escaped="$(sed_escape_replacement "$value")"
  if grep -q "^[[:space:]]*${key}=" "$file"; then
    sed -i -E "s|^([[:space:]]*)${key}=.*$|\1${key}=${escaped}|" "$file"
  else
    die "Template is missing expected metadata variable: $key"
  fi
}

patch_boot_config() {
  local file="$1"
  local tmp="${file}.tmp"

  awk '
    (
      ($0 ~ /^[[:space:]]*linux(efi)?[[:space:]]/ && $0 ~ /\/casper\/vmlinuz/) ||
      ($0 ~ /^[[:space:]]*append[[:space:]]/ && $0 ~ /casper/)
    ) {
      if ($0 !~ /(^|[[:space:]])autoinstall([[:space:]]|$)/) {
        if ($0 ~ /[[:space:]]---/) {
          sub(/[[:space:]]---/, " autoinstall ds=nocloud ---")
        } else {
          $0 = $0 " autoinstall ds=nocloud"
        }
      }
    }
    { print }
  ' "$file" >"$tmp"

  mv "$tmp" "$file"
}

OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$OUTPUT" ]] || die "Missing --output"

require_env MAGICSTICK_DEPLOYMENT_NAME
require_env MAGICSTICK_HOSTNAME
require_env MAGICSTICK_GIT_OWNER
require_env MAGICSTICK_GIT_REPO
require_env MAGICSTICK_GIT_BRANCH

DEPLOYMENT_NAME="${MAGICSTICK_DEPLOYMENT_NAME}"
HOSTNAME="${MAGICSTICK_HOSTNAME}"
GIT_HOST="${MAGICSTICK_GIT_HOST:-github.com}"
GIT_OWNER="${MAGICSTICK_GIT_OWNER}"
GIT_REPO="${MAGICSTICK_GIT_REPO}"
GIT_BRANCH="${MAGICSTICK_GIT_BRANCH}"
FLUX_BOOTSTRAP_MODE="${MAGICSTICK_FLUX_BOOTSTRAP_MODE:-github}"
FLUX_CLUSTER_PATH="${MAGICSTICK_FLUX_CLUSTER_PATH:-deployments/${DEPLOYMENT_NAME}/infra-cluster/flux-bootstrap}"
FLUX_PUBLIC_SYNC_PATH="${MAGICSTICK_FLUX_PUBLIC_SYNC_PATH:-infra-cluster/profiles/single-node/flux-bootstrap}"
FLUX_GITHUB_TOKEN="${MAGICSTICK_FLUX_GITHUB_TOKEN:-<github-pat>}"
MAGICSTICK_PUBLIC_REPO="${MAGICSTICK_PUBLIC_REPO:-https://github.com/QualityMinds/AIppliance-Magic-Stick.git}"
MAGICSTICK_PUBLIC_REF="${MAGICSTICK_PUBLIC_REF:-main}"
MAGICSTICK_PUBLIC_REF_KIND="${MAGICSTICK_PUBLIC_REF_KIND:-branch}"
MAGICSTICK_PUBLIC_CHECKOUT="${MAGICSTICK_PUBLIC_CHECKOUT:-/opt/ai-appliance/magicstick}"
AI_APPLIANCE_PRIVATE_CHECKOUT="${AI_APPLIANCE_PRIVATE_CHECKOUT:-/opt/ai-appliance/deployment}"
ANSIBLE_INVENTORY_PATH="${MAGICSTICK_ANSIBLE_INVENTORY_PATH:-infra-host/inventory/localhost.yml}"
ANSIBLE_PLAYBOOK_PATH="${MAGICSTICK_ANSIBLE_PLAYBOOK_PATH:-infra-host/playbooks/local.yml}"
AI_APPLIANCE_DOMAIN="${MAGICSTICK_AI_APPLIANCE_DOMAIN:-example.local}"
AI_APPLIANCE_DASHBOARD_HOST="${MAGICSTICK_AI_APPLIANCE_DASHBOARD_HOST:-dashboard.example.local}"
AI_APPLIANCE_DASHBOARD_MDNS_NAME="${MAGICSTICK_AI_APPLIANCE_DASHBOARD_MDNS_NAME:-ai-appliance}"
AI_APPLIANCE_ANYTHING_LLM_STORAGE="${MAGICSTICK_AI_APPLIANCE_ANYTHING_LLM_STORAGE:-1Gi}"
AI_APPLIANCE_QDRANT_STORAGE="${MAGICSTICK_AI_APPLIANCE_QDRANT_STORAGE:-1Gi}"
AI_APPLIANCE_LITELLM_POSTGRES_STORAGE="${MAGICSTICK_AI_APPLIANCE_LITELLM_POSTGRES_STORAGE:-1Gi}"
AI_APPLIANCE_LOKI_STORAGE="${MAGICSTICK_AI_APPLIANCE_LOKI_STORAGE:-1Gi}"
AI_APPLIANCE_ALERTMANAGER_STORAGE="${MAGICSTICK_AI_APPLIANCE_ALERTMANAGER_STORAGE:-1Gi}"
AI_APPLIANCE_PROMETHEUS_STORAGE="${MAGICSTICK_AI_APPLIANCE_PROMETHEUS_STORAGE:-1Gi}"
UBUNTU_ISO_URL="${MAGICSTICK_UBUNTU_ISO_URL:-$DEFAULT_UBUNTU_ISO_URL}"
UBUNTU_ISO_SHA256="${MAGICSTICK_UBUNTU_ISO_SHA256:-$DEFAULT_UBUNTU_ISO_SHA256}"
TEMPLATE_DIR="${MAGICSTICK_TEMPLATE_DIR:-/workspace/installer}"
CACHE_DIR="${MAGICSTICK_CACHE_DIR:-/cache}"
WORK_DIR="${MAGICSTICK_WORK_DIR:-/tmp/magicstick-installer-build}"
CIDATA_SIZE="${MAGICSTICK_CIDATA_SIZE:-64M}"
CIDATA_PARTITION_NUMBER="${MAGICSTICK_CIDATA_PARTITION_NUMBER:-3}"
VOLUME_ID="${MAGICSTICK_ISO_VOLUME_ID:-MAGICSTICK_INSTALL}"

case "$FLUX_BOOTSTRAP_MODE" in
  github | readonly-public) ;;
  *) die "Unsupported MAGICSTICK_FLUX_BOOTSTRAP_MODE: $FLUX_BOOTSTRAP_MODE" ;;
esac

case "$MAGICSTICK_PUBLIC_REF_KIND" in
  branch | tag | semver | commit) ;;
  *) die "Unsupported MAGICSTICK_PUBLIC_REF_KIND: $MAGICSTICK_PUBLIC_REF_KIND" ;;
esac

if [[ ! "$HOSTNAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$ ]]; then
  die "MAGICSTICK_HOSTNAME must be a simple DNS hostname"
fi

if [[ "$FLUX_BOOTSTRAP_MODE" == "github" && ( -z "$FLUX_GITHUB_TOKEN" || "$FLUX_GITHUB_TOKEN" == "<github-pat>" ) ]]; then
  die "MAGICSTICK_FLUX_GITHUB_TOKEN is required when MAGICSTICK_FLUX_BOOTSTRAP_MODE=github"
fi

[[ -f "$TEMPLATE_DIR/user-data" ]] || die "Missing template: $TEMPLATE_DIR/user-data"
[[ -f "$TEMPLATE_DIR/meta-data" ]] || die "Missing template: $TEMPLATE_DIR/meta-data"

mkdir -p "$CACHE_DIR" "$(dirname "$OUTPUT")"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/cidata" "$WORK_DIR/bootfiles"

ISO_NAME="${UBUNTU_ISO_URL##*/}"
ISO_PATH="$CACHE_DIR/$ISO_NAME"

if [[ ! -f "$ISO_PATH" ]]; then
  printf 'Downloading %s\n' "$UBUNTU_ISO_URL"
  curl -fL --retry 3 --retry-delay 5 -o "$ISO_PATH.part" "$UBUNTU_ISO_URL"
  mv "$ISO_PATH.part" "$ISO_PATH"
fi

printf '%s  %s\n' "$UBUNTU_ISO_SHA256" "$ISO_PATH" | sha256sum -c -

USER_DATA="$WORK_DIR/cidata/user-data"
META_DATA="$WORK_DIR/cidata/meta-data"
CIDATA_README="$WORK_DIR/cidata/README.txt"

cp "$TEMPLATE_DIR/user-data" "$USER_DATA"

replace_literal "$USER_DATA" "REPLACE_WITH_GIT_OWNER" "$GIT_OWNER"
replace_literal "$USER_DATA" "REPLACE_WITH_GIT_REPO" "$GIT_REPO"
replace_literal "$USER_DATA" "REPLACE_WITH_GIT_BRANCH" "$GIT_BRANCH"
replace_literal "$USER_DATA" "CHANGEME_DEPLOYMENT" "$DEPLOYMENT_NAME"
replace_literal "$USER_DATA" "REPLACE_WITH_FLUX_GITHUB_TOKEN" "$FLUX_GITHUB_TOKEN"

set_env_line "$USER_DATA" GIT_HOST "$GIT_HOST"
set_env_line "$USER_DATA" GIT_OWNER "$GIT_OWNER"
set_env_line "$USER_DATA" GIT_REPO "$GIT_REPO"
set_env_line "$USER_DATA" GIT_BRANCH "$GIT_BRANCH"
set_env_line "$USER_DATA" FLUX_BOOTSTRAP_MODE "$FLUX_BOOTSTRAP_MODE"
set_env_line "$USER_DATA" MAGICSTICK_PUBLIC_REPO "$MAGICSTICK_PUBLIC_REPO"
set_env_line "$USER_DATA" MAGICSTICK_PUBLIC_REF "$MAGICSTICK_PUBLIC_REF"
set_env_line "$USER_DATA" MAGICSTICK_PUBLIC_REF_KIND "$MAGICSTICK_PUBLIC_REF_KIND"
set_env_line "$USER_DATA" MAGICSTICK_PUBLIC_CHECKOUT "$MAGICSTICK_PUBLIC_CHECKOUT"
set_env_line "$USER_DATA" AI_APPLIANCE_PRIVATE_CHECKOUT "$AI_APPLIANCE_PRIVATE_CHECKOUT"
set_env_line "$USER_DATA" FLUX_CLUSTER_PATH "$FLUX_CLUSTER_PATH"
set_env_line "$USER_DATA" FLUX_PUBLIC_SYNC_PATH "$FLUX_PUBLIC_SYNC_PATH"
set_env_line "$USER_DATA" ANSIBLE_INVENTORY_PATH "$ANSIBLE_INVENTORY_PATH"
set_env_line "$USER_DATA" ANSIBLE_PLAYBOOK_PATH "$ANSIBLE_PLAYBOOK_PATH"
set_env_line "$USER_DATA" AI_APPLIANCE_DOMAIN "$AI_APPLIANCE_DOMAIN"
set_env_line "$USER_DATA" AI_APPLIANCE_DASHBOARD_HOST "$AI_APPLIANCE_DASHBOARD_HOST"
set_env_line "$USER_DATA" AI_APPLIANCE_DASHBOARD_MDNS_NAME "$AI_APPLIANCE_DASHBOARD_MDNS_NAME"
set_env_line "$USER_DATA" AI_APPLIANCE_ANYTHING_LLM_STORAGE "$AI_APPLIANCE_ANYTHING_LLM_STORAGE"
set_env_line "$USER_DATA" AI_APPLIANCE_QDRANT_STORAGE "$AI_APPLIANCE_QDRANT_STORAGE"
set_env_line "$USER_DATA" AI_APPLIANCE_LITELLM_POSTGRES_STORAGE "$AI_APPLIANCE_LITELLM_POSTGRES_STORAGE"
set_env_line "$USER_DATA" AI_APPLIANCE_LOKI_STORAGE "$AI_APPLIANCE_LOKI_STORAGE"
set_env_line "$USER_DATA" AI_APPLIANCE_ALERTMANAGER_STORAGE "$AI_APPLIANCE_ALERTMANAGER_STORAGE"
set_env_line "$USER_DATA" AI_APPLIANCE_PROMETHEUS_STORAGE "$AI_APPLIANCE_PROMETHEUS_STORAGE"
set_env_line "$USER_DATA" FLUX_GITHUB_TOKEN "$FLUX_GITHUB_TOKEN"

cat >"$META_DATA" <<EOF
instance-id: $HOSTNAME
local-hostname: $HOSTNAME
EOF

cat >"$CIDATA_README" <<EOF
Magic-Stick CIDATA partition

Edit user-data and meta-data in this FAT partition before booting the target
machine if deployment values need to change.

This partition may contain a GitHub/Flux token. Treat the USB stick and any
image made from it as sensitive.
EOF

CIDATA_IMAGE="$WORK_DIR/cidata.img"
truncate -s "$CIDATA_SIZE" "$CIDATA_IMAGE"
mkfs.vfat -n CIDATA "$CIDATA_IMAGE" >/dev/null
mcopy -i "$CIDATA_IMAGE" "$USER_DATA" ::user-data
mcopy -i "$CIDATA_IMAGE" "$META_DATA" ::meta-data
mcopy -i "$CIDATA_IMAGE" "$CIDATA_README" ::README.txt

CONFIG_LIST="$WORK_DIR/boot-configs.txt"
xorriso -report_about SORRY -indev "$ISO_PATH" -find / -type f -name "*.cfg" -print >"$CONFIG_LIST"

map_args=()
patched_count=0

while IFS= read -r iso_config_path; do
  [[ -n "$iso_config_path" ]] || continue

  local_config_path="$WORK_DIR/bootfiles${iso_config_path}"
  mkdir -p "$(dirname "$local_config_path")"

  if ! xorriso -report_about SORRY -osirrox on -indev "$ISO_PATH" -extract "$iso_config_path" "$local_config_path" >/dev/null 2>&1; then
    continue
  fi

  if grep -qE '(/casper/vmlinuz|initrd=.*casper)' "$local_config_path"; then
    patch_boot_config "$local_config_path"
    map_args+=(-map "$local_config_path" "$iso_config_path")
    patched_count=$((patched_count + 1))
  fi
done <"$CONFIG_LIST"

if [[ "$patched_count" -eq 0 ]]; then
  die "No Ubuntu boot configuration containing /casper/vmlinuz was found"
fi

TMP_OUTPUT="${OUTPUT}.tmp"
rm -f "$TMP_OUTPUT"

xorriso -report_about UPDATE \
  -indev "$ISO_PATH" \
  -outdev "$TMP_OUTPUT" \
  -boot_image any replay \
  -volid "$VOLUME_ID" \
  -append_partition "$CIDATA_PARTITION_NUMBER" 0x0c "$CIDATA_IMAGE" \
  "${map_args[@]}"

mv "$TMP_OUTPUT" "$OUTPUT"

printf 'Created installer image: %s\n' "$OUTPUT"
printf 'CIDATA partition: FAT32 label CIDATA, partition number %s\n' "$CIDATA_PARTITION_NUMBER"
