#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/QualityMinds/AIppliance-Magic-Stick.git"
REQUESTED_REF="main"
INSTALL_DIRECTORY="/opt/ai-appliance/magicstick"
METADATA_FILE="/etc/default/ai-appliance-repo"
PUBLIC_SYNC_PATH="magic-cluster/flux/entrypoints/single-node"
APPLIANCE_DOMAIN="magicstick.example.com"
MDNS_DOMAIN="magicstick.local"
ASSUME_YES=false
PREFLIGHT_ONLY=false

usage() {
  cat <<'EOF'
Install Magic Stick on a dedicated Ubuntu 24.04 host or VM.

Usage:
  sudo bash install-from-linux.sh [options]

Options:
  --ref REF             Git branch, tag, or commit to install (default: main)
  --repository URL      Public Git repository URL
  --domain DOMAIN       Initial public domain placeholder
  --mdns-domain DOMAIN  Initial local domain (default: magicstick.local)
  --install-dir PATH    Repository checkout path
  --preflight-only      Run checks without changing the host
  --yes                 Skip the interactive confirmation
  -h, --help            Show this help

This installer is only for a new, dedicated Ubuntu 24.04 system. It installs
K3s, Flux, Magic Stick, and the one-time First-Run Setup. It does not create a
default administrator password.
EOF
}

log() {
  printf '[magicstick] %s\n' "$*"
}

fail() {
  printf '[magicstick] ERROR: %s\n' "$*" >&2
  exit 1
}

git_with_http11_fallback() {
  if GIT_TERMINAL_PROMPT=0 git "$@"; then
    return 0
  fi

  log "Git transport failed; retrying with HTTP/1.1."
  GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 "$@"
}

on_error() {
  local exit_code=$?
  printf '[magicstick] Installation stopped near line %s (exit %s).\n' "${BASH_LINENO[0]:-unknown}" "$exit_code" >&2
  printf '[magicstick] Existing files and setup state were left intact.\n' >&2
  exit "$exit_code"
}
trap on_error ERR

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value."
}

while (($#)); do
  case "$1" in
    --ref)
      require_value "$1" "${2:-}"
      REQUESTED_REF="$2"
      shift 2
      ;;
    --repository)
      require_value "$1" "${2:-}"
      REPOSITORY_URL="$2"
      shift 2
      ;;
    --domain)
      require_value "$1" "${2:-}"
      APPLIANCE_DOMAIN="$2"
      shift 2
      ;;
    --mdns-domain)
      require_value "$1" "${2:-}"
      MDNS_DOMAIN="$2"
      shift 2
      ;;
    --install-dir)
      require_value "$1" "${2:-}"
      INSTALL_DIRECTORY="$2"
      shift 2
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=true
      shift
      ;;
    --yes)
      ASSUME_YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

validate_domain() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "$label is not a valid DNS name: $value"
  [[ "$value" != *..* ]] || fail "$label contains an empty DNS label: $value"
}

port_is_listening() {
  local port="$1"
  ss -H -ltn 2>/dev/null | awk -v suffix=":${port}" '
    index($4, suffix) == length($4) - length(suffix) + 1 { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

run_preflight() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Run this installer as root, for example with sudo."
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer supports Linux only."
  [[ -r /etc/os-release ]] || fail "Cannot identify the Linux distribution."

  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || \
    fail "Ubuntu Server 24.04 LTS is required (found ${PRETTY_NAME:-unknown})."
  [[ "$(uname -m)" =~ ^(x86_64|aarch64|arm64)$ ]] || fail "Unsupported architecture: $(uname -m)"
  command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
  command -v ss >/dev/null 2>&1 || fail "The ss utility is required (package: iproute2)."

  validate_domain "$APPLIANCE_DOMAIN" "--domain"
  validate_domain "$MDNS_DOMAIN" "--mdns-domain"
  [[ "$MDNS_DOMAIN" == *.local ]] || fail "--mdns-domain must end in .local."
  [[ "$INSTALL_DIRECTORY" == /* ]] || fail "--install-dir must be an absolute path."

  if systemctl list-unit-files k3s.service --no-legend 2>/dev/null | grep -q '^k3s\.service'; then
    fail "K3s is already installed. Use deploy-on-k8s.sh for an existing cluster."
  fi
  [[ ! -e /etc/rancher/k3s/k3s.yaml && ! -d /var/lib/rancher/k3s ]] || \
    fail "Existing K3s state was found. This installer will not overwrite it."
  [[ ! -e "$METADATA_FILE" ]] || \
    fail "Magic Stick host metadata already exists at $METADATA_FILE. Use /usr/local/sbin/ai-appliance-converge to update it."
  [[ ! -e "$INSTALL_DIRECTORY" ]] || \
    fail "The install directory already exists: $INSTALL_DIRECTORY"
  [[ ! -e /var/lib/magicstick/setup/installation-id ]] || \
    fail "Existing Magic Stick setup state was found. A completed appliance cannot be reinitialized."

  port_is_listening 443 && fail "TCP port 443 is already in use."
  port_is_listening 9443 && fail "TCP port 9443 is already in use."

  local available_kib
  available_kib="$(df -Pk / | awk 'NR == 2 { print $4 }')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || fail "Could not determine available disk space."
  (( available_kib >= 40 * 1024 * 1024 )) || \
    fail "At least 40 GiB of free root filesystem space is required."

  log "Preflight passed for ${PRETTY_NAME} on $(uname -m)."
  log "No existing K3s or Magic Stick installation was found."
}

confirm_installation() {
  $ASSUME_YES && return 0
  [[ -r /dev/tty ]] || fail "No interactive terminal is available. Re-run with --yes after reviewing the command."

  cat >/dev/tty <<EOF

Magic Stick will take over this dedicated host:
  repository:  $REPOSITORY_URL
  ref:         $REQUESTED_REF
  install dir: $INSTALL_DIRECTORY
  local name:  $MDNS_DOMAIN

Continue? [y/N]
EOF
  local answer=""
  IFS= read -r answer </dev/tty
  [[ "$answer" =~ ^[Yy]$ ]] || fail "Installation cancelled."
}

install_dependencies() {
  log "Installing host prerequisites."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ansible ca-certificates curl git iproute2 python3 uuid-runtime
}

checkout_repository() {
  log "Resolving and checking out $REQUESTED_REF."
  install -d -m 0755 "$(dirname "$INSTALL_DIRECTORY")"
  git init --quiet "$INSTALL_DIRECTORY"
  git -C "$INSTALL_DIRECTORY" remote add origin "$REPOSITORY_URL"
  if ! git_with_http11_fallback -C "$INSTALL_DIRECTORY" fetch --depth=1 origin "$REQUESTED_REF"; then
    fail "Could not fetch ref '$REQUESTED_REF' from $REPOSITORY_URL."
  fi
  git -C "$INSTALL_DIRECTORY" checkout --quiet --detach FETCH_HEAD
  RESOLVED_COMMIT="$(git -C "$INSTALL_DIRECTORY" rev-parse HEAD)"
  [[ "$RESOLVED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "Could not resolve the installation commit."
  log "Pinned this installation to commit $RESOLVED_COMMIT."
}

write_metadata() {
  local mdns_name="${MDNS_DOMAIN%.local}"
  local temporary_file
  temporary_file="$(mktemp)"
  chmod 0600 "$temporary_file"
  {
    printf 'FLUX_BOOTSTRAP_MODE=%q\n' "readonly-public"
    printf 'MAGICSTICK_PUBLIC_REPO=%q\n' "$REPOSITORY_URL"
    printf 'MAGICSTICK_PUBLIC_REF=%q\n' "$RESOLVED_COMMIT"
    printf 'MAGICSTICK_PUBLIC_REF_KIND=%q\n' "commit"
    printf 'MAGICSTICK_PUBLIC_CHECKOUT=%q\n' "$INSTALL_DIRECTORY"
    printf 'FLUX_PUBLIC_SYNC_PATH=%q\n' "$PUBLIC_SYNC_PATH"
    printf 'AI_APPLIANCE_DOMAIN=%q\n' "$APPLIANCE_DOMAIN"
    printf 'AI_APPLIANCE_DASHBOARD_HOST=%q\n' "$APPLIANCE_DOMAIN"
    printf 'AI_APPLIANCE_MDNS_DOMAIN=%q\n' "$MDNS_DOMAIN"
    printf 'AI_APPLIANCE_MDNS_NAME=%q\n' "$mdns_name"
    printf 'AI_APPLIANCE_DASHBOARD_MDNS_NAME=%q\n' "$mdns_name"
  } >"$temporary_file"
  install -o root -g root -m 0600 "$temporary_file" "$METADATA_FILE"
  rm -f "$temporary_file"
}

start_installation() {
  local converge_runner="$INSTALL_DIRECTORY/magic-host/roles/ansible-pull-timer/files/ai-appliance-converge"
  [[ -f "$converge_runner" ]] || fail "The selected ref does not contain the host converge runner."

  install -d -o root -g root -m 0700 /var/lib/magicstick/setup
  install -o root -g root -m 0600 /dev/null /var/lib/magicstick/setup/new-install

  log "Starting the Ansible host and cluster installation."
  bash "$converge_runner"
}

run_preflight
if $PREFLIGHT_ONLY; then
  log "Preflight-only mode completed; no changes were made."
  exit 0
fi

confirm_installation
install_dependencies
checkout_repository
write_metadata
start_installation

log "Installation completed."
if command -v magicstick >/dev/null 2>&1; then
  magicstick setup show || true
else
  log "Run 'sudo magicstick setup show' to display the First-Run Setup address and code."
fi
