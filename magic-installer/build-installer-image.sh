#!/usr/bin/env bash
set -euo pipefail

DEFAULT_UBUNTU_ISO_URL="https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-live-server-amd64.iso"
DEFAULT_UBUNTU_ISO_SHA256="e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

usage() {
  cat <<'USAGE'
Usage:
  magic-installer/build-installer-image.sh \
    --hostname example-host-01 \
    --output dist/magicstick-installer.img

Options:
  --deployment-name NAME       Deployment name used in private GitHub Flux paths. Default: public.
  --hostname NAME              Hostname written to CIDATA/meta-data.
  --git-owner OWNER            GitHub owner or organization for --flux-bootstrap-mode github.
  --git-repo REPO              Deployment repository name for --flux-bootstrap-mode github.
  --git-branch BRANCH          Deployment branch for --flux-bootstrap-mode github.
  --flux-cluster-path PATH     Flux bootstrap path. Defaults to deployments/NAME/infra-cluster/flux-bootstrap.
  --flux-bootstrap-mode MODE   github or readonly-public. Default: readonly-public.
  --flux-public-sync-path PATH Public profile for readonly-public mode.
  --public-repo URL            Public Magic-Stick repository URL.
  --public-ref REF             Public Magic-Stick ref. Default: main.
  --public-ref-kind KIND       branch, tag, semver, or commit. Default: branch.
  --output PATH                Output image path. Default: dist/magicstick-installer.img.
  --container-runtime NAME     docker or podman. Auto-detected by default.
  --builder-image NAME         Container image tag for the local builder.
  --no-build                   Reuse an already-built builder image.
  --ubuntu-iso-url URL         Ubuntu Server ISO URL.
  --ubuntu-iso-sha256 SHA      Expected Ubuntu Server ISO SHA256.
  -h, --help                   Show this help.

The default readonly-public mode uses only the public Magic-Stick repository and
does not need a GitHub token. If --flux-bootstrap-mode github is used, the
Flux/GitHub token is read from FLUX_GITHUB_TOKEN or prompted without echo.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local name="$1"
  local value="$2"

  [[ -n "$value" ]] || die "Missing required option: $name"
}

absolute_path() {
  local path="$1"
  local dir
  local base

  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *)
      dir="$(dirname "$path")"
      base="$(basename "$path")"
      mkdir -p "$REPO_ROOT/$dir"
      printf '%s/%s\n' "$(cd "$REPO_ROOT/$dir" && pwd -P)" "$base"
      ;;
  esac
}

detect_runtime() {
  if command -v docker >/dev/null 2>&1; then
    printf 'docker\n'
    return
  fi

  if command -v podman >/dev/null 2>&1; then
    printf 'podman\n'
    return
  fi

  die "Neither docker nor podman was found"
}

DEPLOYMENT_NAME="public"
HOSTNAME_VALUE=""
GIT_OWNER="example-org"
GIT_REPO="example-deployment"
GIT_BRANCH="main"
FLUX_CLUSTER_PATH=""
FLUX_BOOTSTRAP_MODE="readonly-public"
FLUX_PUBLIC_SYNC_PATH="magic-cluster/flux/entrypoints/single-node"
PUBLIC_REPO="https://github.com/QualityMinds/AIppliance-Magic-Stick.git"
PUBLIC_REF="main"
PUBLIC_REF_KIND="branch"
OUTPUT="dist/magicstick-installer.img"
CONTAINER_RUNTIME=""
BUILDER_IMAGE="magicstick-installer-builder:local"
NO_BUILD="false"
UBUNTU_ISO_URL="$DEFAULT_UBUNTU_ISO_URL"
UBUNTU_ISO_SHA256="$DEFAULT_UBUNTU_ISO_SHA256"
AI_APPLIANCE_DOMAIN="example.local"
AI_APPLIANCE_DASHBOARD_HOST="dashboard.example.local"
AI_APPLIANCE_DASHBOARD_MDNS_NAME="ai-appliance"
AI_APPLIANCE_ANYTHING_LLM_STORAGE="1Gi"
AI_APPLIANCE_QDRANT_STORAGE="1Gi"
AI_APPLIANCE_LITELLM_POSTGRES_STORAGE="1Gi"
AI_APPLIANCE_LOKI_STORAGE="1Gi"
AI_APPLIANCE_ALERTMANAGER_STORAGE="1Gi"
AI_APPLIANCE_PROMETHEUS_STORAGE="1Gi"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployment-name) DEPLOYMENT_NAME="${2:-}"; shift 2 ;;
    --hostname) HOSTNAME_VALUE="${2:-}"; shift 2 ;;
    --git-owner) GIT_OWNER="${2:-}"; shift 2 ;;
    --git-repo) GIT_REPO="${2:-}"; shift 2 ;;
    --git-branch) GIT_BRANCH="${2:-}"; shift 2 ;;
    --flux-cluster-path) FLUX_CLUSTER_PATH="${2:-}"; shift 2 ;;
    --flux-bootstrap-mode) FLUX_BOOTSTRAP_MODE="${2:-}"; shift 2 ;;
    --flux-public-sync-path) FLUX_PUBLIC_SYNC_PATH="${2:-}"; shift 2 ;;
    --public-repo) PUBLIC_REPO="${2:-}"; shift 2 ;;
    --public-ref) PUBLIC_REF="${2:-}"; shift 2 ;;
    --public-ref-kind) PUBLIC_REF_KIND="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --container-runtime) CONTAINER_RUNTIME="${2:-}"; shift 2 ;;
    --builder-image) BUILDER_IMAGE="${2:-}"; shift 2 ;;
    --no-build) NO_BUILD="true"; shift ;;
    --ubuntu-iso-url) UBUNTU_ISO_URL="${2:-}"; shift 2 ;;
    --ubuntu-iso-sha256) UBUNTU_ISO_SHA256="${2:-}"; shift 2 ;;
    --domain) AI_APPLIANCE_DOMAIN="${2:-}"; shift 2 ;;
    --dashboard-host) AI_APPLIANCE_DASHBOARD_HOST="${2:-}"; shift 2 ;;
    --dashboard-mdns-name) AI_APPLIANCE_DASHBOARD_MDNS_NAME="${2:-}"; shift 2 ;;
    --anything-llm-storage) AI_APPLIANCE_ANYTHING_LLM_STORAGE="${2:-}"; shift 2 ;;
    --qdrant-storage) AI_APPLIANCE_QDRANT_STORAGE="${2:-}"; shift 2 ;;
    --litellm-postgres-storage) AI_APPLIANCE_LITELLM_POSTGRES_STORAGE="${2:-}"; shift 2 ;;
    --loki-storage) AI_APPLIANCE_LOKI_STORAGE="${2:-}"; shift 2 ;;
    --alertmanager-storage) AI_APPLIANCE_ALERTMANAGER_STORAGE="${2:-}"; shift 2 ;;
    --prometheus-storage) AI_APPLIANCE_PROMETHEUS_STORAGE="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

require_value "--hostname" "$HOSTNAME_VALUE"

if [[ -z "$FLUX_CLUSTER_PATH" ]]; then
  FLUX_CLUSTER_PATH="deployments/${DEPLOYMENT_NAME}/infra-cluster/flux-bootstrap"
fi

case "$FLUX_BOOTSTRAP_MODE" in
  github | readonly-public) ;;
  *) die "--flux-bootstrap-mode must be github or readonly-public" ;;
esac

if [[ "$FLUX_BOOTSTRAP_MODE" == "github" ]]; then
  require_value "--deployment-name" "$DEPLOYMENT_NAME"
  require_value "--git-owner" "$GIT_OWNER"
  require_value "--git-repo" "$GIT_REPO"
  require_value "--git-branch" "$GIT_BRANCH"

  if [[ -z "${FLUX_GITHUB_TOKEN:-}" ]]; then
    printf 'Flux GitHub token: ' >&2
    IFS= read -r -s FLUX_GITHUB_TOKEN
    printf '\n' >&2
  fi

  [[ -n "${FLUX_GITHUB_TOKEN:-}" ]] || die "Flux GitHub token is required for github bootstrap mode"
else
  FLUX_GITHUB_TOKEN="${FLUX_GITHUB_TOKEN:-<github-pat>}"
fi

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-$(detect_runtime)}"
OUTPUT_ABS="$(absolute_path "$OUTPUT")"
OUTPUT_DIR="$(dirname "$OUTPUT_ABS")"
OUTPUT_BASENAME="$(basename "$OUTPUT_ABS")"
CACHE_DIR="$REPO_ROOT/.installer-cache"

mkdir -p "$OUTPUT_DIR" "$CACHE_DIR"

if [[ "$NO_BUILD" != "true" ]]; then
  "$CONTAINER_RUNTIME" build \
    -f "$SCRIPT_DIR/Containerfile" \
    -t "$BUILDER_IMAGE" \
    "$SCRIPT_DIR"
fi

export MAGICSTICK_DEPLOYMENT_NAME="$DEPLOYMENT_NAME"
export MAGICSTICK_HOSTNAME="$HOSTNAME_VALUE"
export MAGICSTICK_GIT_OWNER="$GIT_OWNER"
export MAGICSTICK_GIT_REPO="$GIT_REPO"
export MAGICSTICK_GIT_BRANCH="$GIT_BRANCH"
export MAGICSTICK_FLUX_CLUSTER_PATH="$FLUX_CLUSTER_PATH"
export MAGICSTICK_FLUX_BOOTSTRAP_MODE="$FLUX_BOOTSTRAP_MODE"
export MAGICSTICK_FLUX_PUBLIC_SYNC_PATH="$FLUX_PUBLIC_SYNC_PATH"
export MAGICSTICK_FLUX_GITHUB_TOKEN="$FLUX_GITHUB_TOKEN"
export MAGICSTICK_PUBLIC_REPO="$PUBLIC_REPO"
export MAGICSTICK_PUBLIC_REF="$PUBLIC_REF"
export MAGICSTICK_PUBLIC_REF_KIND="$PUBLIC_REF_KIND"
export MAGICSTICK_UBUNTU_ISO_URL="$UBUNTU_ISO_URL"
export MAGICSTICK_UBUNTU_ISO_SHA256="$UBUNTU_ISO_SHA256"
export MAGICSTICK_AI_APPLIANCE_DOMAIN="$AI_APPLIANCE_DOMAIN"
export MAGICSTICK_AI_APPLIANCE_DASHBOARD_HOST="$AI_APPLIANCE_DASHBOARD_HOST"
export MAGICSTICK_AI_APPLIANCE_DASHBOARD_MDNS_NAME="$AI_APPLIANCE_DASHBOARD_MDNS_NAME"
export MAGICSTICK_AI_APPLIANCE_ANYTHING_LLM_STORAGE="$AI_APPLIANCE_ANYTHING_LLM_STORAGE"
export MAGICSTICK_AI_APPLIANCE_QDRANT_STORAGE="$AI_APPLIANCE_QDRANT_STORAGE"
export MAGICSTICK_AI_APPLIANCE_LITELLM_POSTGRES_STORAGE="$AI_APPLIANCE_LITELLM_POSTGRES_STORAGE"
export MAGICSTICK_AI_APPLIANCE_LOKI_STORAGE="$AI_APPLIANCE_LOKI_STORAGE"
export MAGICSTICK_AI_APPLIANCE_ALERTMANAGER_STORAGE="$AI_APPLIANCE_ALERTMANAGER_STORAGE"
export MAGICSTICK_AI_APPLIANCE_PROMETHEUS_STORAGE="$AI_APPLIANCE_PROMETHEUS_STORAGE"

run_args=(
  run
  --rm
  --env MAGICSTICK_DEPLOYMENT_NAME
  --env MAGICSTICK_HOSTNAME
  --env MAGICSTICK_GIT_OWNER
  --env MAGICSTICK_GIT_REPO
  --env MAGICSTICK_GIT_BRANCH
  --env MAGICSTICK_FLUX_CLUSTER_PATH
  --env MAGICSTICK_FLUX_BOOTSTRAP_MODE
  --env MAGICSTICK_FLUX_PUBLIC_SYNC_PATH
  --env MAGICSTICK_FLUX_GITHUB_TOKEN
  --env MAGICSTICK_PUBLIC_REPO
  --env MAGICSTICK_PUBLIC_REF
  --env MAGICSTICK_PUBLIC_REF_KIND
  --env MAGICSTICK_UBUNTU_ISO_URL
  --env MAGICSTICK_UBUNTU_ISO_SHA256
  --env MAGICSTICK_AI_APPLIANCE_DOMAIN
  --env MAGICSTICK_AI_APPLIANCE_DASHBOARD_HOST
  --env MAGICSTICK_AI_APPLIANCE_DASHBOARD_MDNS_NAME
  --env MAGICSTICK_AI_APPLIANCE_ANYTHING_LLM_STORAGE
  --env MAGICSTICK_AI_APPLIANCE_QDRANT_STORAGE
  --env MAGICSTICK_AI_APPLIANCE_LITELLM_POSTGRES_STORAGE
  --env MAGICSTICK_AI_APPLIANCE_LOKI_STORAGE
  --env MAGICSTICK_AI_APPLIANCE_ALERTMANAGER_STORAGE
  --env MAGICSTICK_AI_APPLIANCE_PROMETHEUS_STORAGE
  --volume "$REPO_ROOT:/workspace:ro"
  --volume "$OUTPUT_DIR:/output"
  --volume "$CACHE_DIR:/cache"
)

if [[ "$(uname -s)" != "Darwin" ]]; then
  run_args+=(--user "$(id -u):$(id -g)")
fi

run_args+=("$BUILDER_IMAGE" --output "/output/$OUTPUT_BASENAME")

"$CONTAINER_RUNTIME" "${run_args[@]}"
