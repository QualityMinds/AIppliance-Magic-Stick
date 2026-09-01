#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="https://github.com/QualityMinds/AIppliance-Magic-Stick.git"
REQUESTED_REF="main"
REF_KIND=""
SYNC_PATH="magic-cluster/flux/entrypoints/single-node"
APPLIANCE_DOMAIN="magicstick.example.com"
MDNS_DOMAIN="magicstick.local"
KUBE_CONTEXT=""
ENVOY_GATEWAY_VERSION="v1.8.2"
INSTALLER_STATE_NAME="magicstick-installer-state"
BOOTSTRAP_INSTALLATION_ID=""
RESUME_ALLOWED=false
ASSUME_YES=false
PREFLIGHT_ONLY=false

usage() {
  cat <<'EOF'
Deploy Magic Stick into an existing Kubernetes cluster.

Usage:
  bash deploy-on-k8s.sh [options]

Options:
  --context CONTEXT     kubectl context (default: current context)
  --ref REF             Git branch, tag, or 40-character commit (default: main)
  --ref-kind KIND       branch, tag, semver, or commit (auto-detected by default)
  --repository URL      Public Git repository URL
  --domain DOMAIN       Initial public domain placeholder
  --mdns-domain DOMAIN  Initial local domain (default: magicstick.local)
  --preflight-only      Check the cluster without changing it
  --yes                 Skip the interactive context confirmation
  -h, --help            Show this help

Required local tools: kubectl, helm, flux, and python3.
The selected kubeconfig identity must have cluster-admin permissions.
EOF
}

log() {
  printf '[magicstick] %s\n' "$*"
}

warn() {
  printf '[magicstick] WARNING: %s\n' "$*" >&2
}

fail() {
  printf '[magicstick] ERROR: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  printf '[magicstick] Deployment stopped near line %s (exit %s).\n' "${BASH_LINENO[0]:-unknown}" "$exit_code" >&2
  printf '[magicstick] Existing cluster resources were not removed.\n' >&2
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
    --context)
      require_value "$1" "${2:-}"
      KUBE_CONTEXT="$2"
      shift 2
      ;;
    --ref)
      require_value "$1" "${2:-}"
      REQUESTED_REF="$2"
      shift 2
      ;;
    --ref-kind)
      require_value "$1" "${2:-}"
      REF_KIND="$2"
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

detect_ref_kind() {
  if [[ -n "$REF_KIND" ]]; then
    case "$REF_KIND" in
      branch|tag|semver|commit) return ;;
      *) fail "--ref-kind must be branch, tag, semver, or commit." ;;
    esac
  fi

  if [[ "$REQUESTED_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
    REF_KIND="commit"
  elif [[ "$REQUESTED_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
    REF_KIND="tag"
  else
    REF_KIND="branch"
  fi
}

k() {
  kubectl --context "$KUBE_CONTEXT" "$@"
}

resource_exists() {
  k "$@" >/dev/null 2>&1
}

run_preflight() {
  local tool
  for tool in kubectl helm flux python3; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required tool not found: $tool"
  done

  validate_domain "$APPLIANCE_DOMAIN" "--domain"
  validate_domain "$MDNS_DOMAIN" "--mdns-domain"
  [[ "$MDNS_DOMAIN" == *.local ]] || fail "--mdns-domain must end in .local."
  detect_ref_kind

  if [[ -z "$KUBE_CONTEXT" ]]; then
    KUBE_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  fi
  [[ -n "$KUBE_CONTEXT" ]] || fail "No kubectl context is selected. Use --context."
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 || fail "Unknown kubectl context: $KUBE_CONTEXT"
  k get --raw=/readyz >/dev/null || fail "The Kubernetes API is not ready for context $KUBE_CONTEXT."

  local cluster_admin
  cluster_admin="$(k auth can-i '*' '*' --all-namespaces 2>/dev/null || true)"
  [[ "$cluster_admin" == "yes" ]] || fail "The selected identity does not have cluster-admin permissions."

  local default_storage_classes
  default_storage_classes="$(k get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if [[ -z "$default_storage_classes" ]]; then
    default_storage_classes="$(k get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.beta\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  fi
  [[ -n "$default_storage_classes" ]] || fail "The cluster has no default StorageClass."

  if resource_exists -n identity-system get appliancesetup local; then
    fail "ApplianceSetup/local already exists. This script never resets an existing appliance."
  fi

  if resource_exists -n flux-system get configmap "$INSTALLER_STATE_NAME"; then
    local state state_repository state_ref state_ref_kind state_path
    state="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.state}')"
    state_repository="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.repository}')"
    state_ref="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.ref}')"
    state_ref_kind="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.refKind}')"
    state_path="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.path}')"
    BOOTSTRAP_INSTALLATION_ID="$(k -n flux-system get configmap "$INSTALLER_STATE_NAME" -o jsonpath='{.data.installationId}')"
    [[ "$state" == "Installing" ]] || fail "Unknown bootstrap marker state: $state"
    [[ "$state_repository" == "$REPOSITORY_URL" && "$state_ref" == "$REQUESTED_REF" && \
       "$state_ref_kind" == "$REF_KIND" && "$state_path" == "$SYNC_PATH" ]] || \
      fail "An interrupted bootstrap uses different repository options. Re-run with its original --repository, --ref, and --ref-kind values."
    [[ "$BOOTSTRAP_INSTALLATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || \
      fail "The bootstrap marker has no valid installation ID."
    RESUME_ALLOWED=true
    log "An interrupted Magic Stick bootstrap was found and can be resumed."
  fi

  if resource_exists -n ai-system get appliance local; then
    $RESUME_ALLOWED || fail "Appliance/local already exists. Use Flux reconciliation to update this installation."
  fi

  if resource_exists -n flux-system get gitrepository flux-system; then
    local existing_url
    existing_url="$(k -n flux-system get gitrepository flux-system -o jsonpath='{.spec.url}')"
    [[ "$existing_url" == "$REPOSITORY_URL" ]] || \
      fail "GitRepository/flux-system already points to $existing_url. Magic Stick will not replace a shared Flux source."
    $RESUME_ALLOWED || \
      fail "A matching GitRepository/flux-system exists without an active installer marker. Use Flux reconciliation instead of reinitializing it."
  fi
  if resource_exists -n flux-system get kustomization flux-system; then
    local existing_path
    existing_path="$(k -n flux-system get kustomization flux-system -o jsonpath='{.spec.path}')"
    [[ "$existing_path" == "./$SYNC_PATH" ]] || \
      fail "Kustomization/flux-system already uses $existing_path. Use a dedicated cluster or a deployment overlay."
    $RESUME_ALLOWED || \
      fail "A matching Kustomization/flux-system exists without an active installer marker. Use Flux reconciliation instead of reinitializing it."
  fi

  log "Preflight passed for context '$KUBE_CONTEXT'."
  log "Default StorageClass: $(printf '%s' "$default_storage_classes" | paste -sd, -)"
  warn "The cluster must provide a private LoadBalancer address for ports 443 and 9443."
}

initialize_bootstrap_state() {
  k create namespace flux-system --dry-run=client -o yaml | k apply -f -
  if $RESUME_ALLOWED; then
    log "Resuming bootstrap installation $BOOTSTRAP_INSTALLATION_ID."
    return
  fi

  BOOTSTRAP_INSTALLATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  k -n flux-system create configmap "$INSTALLER_STATE_NAME" \
    --from-literal=state=Installing \
    --from-literal="repository=$REPOSITORY_URL" \
    --from-literal="ref=$REQUESTED_REF" \
    --from-literal="refKind=$REF_KIND" \
    --from-literal="path=$SYNC_PATH" \
    --from-literal="installationId=$BOOTSTRAP_INSTALLATION_ID" \
    --dry-run=client -o yaml | k apply -f -
}

confirm_cluster() {
  $ASSUME_YES && return 0
  [[ -r /dev/tty ]] || fail "No interactive terminal is available. Re-run with --yes after reviewing the context."
  local cluster_server
  cluster_server="$(kubectl config view --minify --context "$KUBE_CONTEXT" -o jsonpath='{.clusters[0].cluster.server}')"
  cat >/dev/tty <<EOF

Magic Stick will be deployed with cluster-wide resources:
  context:    $KUBE_CONTEXT
  API server: $cluster_server
  repository: $REPOSITORY_URL
  ref:        $REF_KIND $REQUESTED_REF

Continue? [y/N]
EOF
  local answer=""
  IFS= read -r answer </dev/tty
  [[ "$answer" =~ ^[Yy]$ ]] || fail "Deployment cancelled."
}

install_gateway_crds() {
  log "Applying Envoy Gateway $ENVOY_GATEWAY_VERSION CRDs without forcing ownership conflicts."
  local crd_bundle
  crd_bundle="$(mktemp)"
  helm show crds oci://docker.io/envoyproxy/gateway-helm --version "$ENVOY_GATEWAY_VERSION" >"$crd_bundle"
  [[ -s "$crd_bundle" ]] || fail "Envoy Gateway CRD bundle is empty."
  k apply --server-side --field-manager=magicstick-installer -f "$crd_bundle"
  rm -f "$crd_bundle"
}

install_flux() {
  if resource_exists -n flux-system get deployment source-controller && \
     resource_exists -n flux-system get deployment kustomize-controller; then
    log "Reusing the existing Flux controllers without upgrading them."
    flux --context "$KUBE_CONTEXT" check
  else
    log "Installing Flux controllers."
    flux --context "$KUBE_CONTEXT" check --pre
    flux --context "$KUBE_CONTEXT" install
  fi
}

apply_settings() {
  local mdns_name="${MDNS_DOMAIN%.local}"
  k create namespace flux-system --dry-run=client -o yaml | k apply -f -
  k -n flux-system create configmap ai-appliance-settings \
    --from-literal="AI_APPLIANCE_DOMAIN=$APPLIANCE_DOMAIN" \
    --from-literal="AI_APPLIANCE_DASHBOARD_HOST=$APPLIANCE_DOMAIN" \
    --from-literal="AI_APPLIANCE_MDNS_DOMAIN=$MDNS_DOMAIN" \
    --from-literal="AI_APPLIANCE_MDNS_NAME=$mdns_name" \
    --from-literal="AI_APPLIANCE_DASHBOARD_MDNS_NAME=$mdns_name" \
    --from-literal=AI_APPLIANCE_ENVOY_CRDS_POLICY=Skip \
    --dry-run=client -o yaml | k apply -f -
}

apply_flux_sync() {
  log "Creating the read-only Magic Stick Flux source."
  local manifest repository_json ref_json
  repository_json="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$REPOSITORY_URL")"
  ref_json="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$REQUESTED_REF")"
  manifest="$(mktemp)"
  cat >"$manifest" <<EOF
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m0s
  ref:
    $REF_KIND: $ref_json
  url: $repository_json
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 10m0s
  path: "./$SYNC_PATH"
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  wait: true
  timeout: 15m0s
EOF
  k apply -f "$manifest"
  rm -f "$manifest"

  flux --context "$KUBE_CONTEXT" reconcile source git flux-system --namespace=flux-system --timeout=5m
  flux --context "$KUBE_CONTEXT" reconcile kustomization flux-system --namespace=flux-system --with-source --timeout=20m
}

create_first_run_setup() {
  log "Waiting for the First-Run Setup API."
  k wait --for=condition=Established crd/appliancesetups.appliance.magicstick.dev --timeout=20m
  k get namespace identity-system >/dev/null
  if resource_exists -n identity-system get appliancesetup local; then
    fail "ApplianceSetup/local appeared during deployment; refusing to overwrite it."
  fi

  local claim claim_hash manifest
  claim="$(python3 -c 'import secrets; a="0123456789abcdefghjkmnpqrstvwxyz"; print("".join(secrets.choice(a) for _ in range(8)))')"
  claim_hash="$(CLAIM_VALUE="$claim" python3 -c 'import hashlib, os; print(hashlib.sha256(os.environ["CLAIM_VALUE"].encode()).hexdigest())')"

  k -n identity-system create secret generic magicstick-setup-claim \
    --from-literal="claim-sha256=$claim_hash" \
    --dry-run=client -o yaml | k apply -f -

  manifest="$(mktemp)"
  cat >"$manifest" <<EOF
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ApplianceSetup
metadata:
  name: local
  namespace: identity-system
spec:
  setupVersion: v1
  installationId: "$BOOTSTRAP_INSTALLATION_ID"
EOF
  k apply -f "$manifest"
  rm -f "$manifest"

  printf '\n'
  printf '============================================================\n'
  printf 'Magic Stick Einrichtungscode: %s\n' "$claim"
  printf 'Notiere ihn jetzt. Kubernetes speichert nur seinen SHA-256-Hash.\n'
  printf 'Setup: https://<private-load-balancer-ip>:9443/setup\n'
  printf '============================================================\n'

  k -n identity-system patch appliancesetup local --subresource=status --type=merge \
    -p '{"status":{"phase":"Pending"}}'
  k -n flux-system delete configmap "$INSTALLER_STATE_NAME"
  unset claim claim_hash
}

run_preflight
if $PREFLIGHT_ONLY; then
  log "Preflight-only mode completed; no changes were made."
  exit 0
fi

confirm_cluster
initialize_bootstrap_state
install_gateway_crds
install_flux
apply_settings
apply_flux_sync
create_first_run_setup

log "Cluster bootstrap completed."
log "Inspect the setup address with: kubectl --context '$KUBE_CONTEXT' -n identity-system get gateway magicstick-setup"
