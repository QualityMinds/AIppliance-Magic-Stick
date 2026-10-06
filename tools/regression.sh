#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-help}"
docker_cli="${DOCKER_CLI:-docker}"
export REGRESSION_RUNNER_IMAGE="${REGRESSION_RUNNER_IMAGE:-magicstick-regression:local}"
if [[ "$docker_cli" == */* ]]; then export PATH="$(dirname "$docker_cli"):$PATH"; fi
case "$mode" in
  help)
    printf '%s\n' 'Build once: bash tools/regression.sh build' \
      'Register a DISPOSABLE test server once: bash tools/regression.sh setup' \
      'Run all Phase 0–8 P0 tests: bash tools/regression.sh all' \
      'Credentials and fixtures are prepared automatically. No per-test approvals or ACCEPT forms.' \
      'Full runs may stop models, change settings, clear caches and reboot the registered lab.' \
      'Every selected test reports Passed, Failed or Blocked; independent tests continue.' \
      'Optional subset: all --phases 2-4; isolated checks: phaseN-fast / phaseN-fixtures.' \
      'Reports: .regression/private/runs. Exit 0 = Passed, 1 = Failed, 2 = Blocked only.' \
      'Guide: docs/development/regression-remaining-p0.md; setup --help for CI access inputs.'
    exit 0 ;;
  setup)
    shift; export DOCKER_CLI="$docker_cli"
    exec "${REGRESSION_SETUP_PYTHON:-python3}" "$root/tools/regression_inputs.py" "$@" ;;
  build)
    revision="$(git -C "$root" rev-parse HEAD)"
    if [[ -n "$(git -C "$root" status --porcelain)" ]]; then revision=unknown; fi
    "$docker_cli" build --build-arg "SOURCE_REVISION=$revision" -f "$root/dashboard/apps/web/regression/Dockerfile" \
      -t "$REGRESSION_RUNNER_IMAGE" "$root"
    exit $? ;;
  all|prepare|phase[0-8]|phase[0-8]-fast|phase[0-8]-fixtures|phase[5-8]-live|phase6-drill|selftest|typecheck|phase3-gpu|phase3-validation|phase4-sharing|gpu-recover|preflight|locktest|ownedtest|foundations|smoke-fast|smoke-fixtures|phase2-readonly|phase2-models|phase2-faults|session-smoke|core-smoke|smoke|model-edit|cleanup-plan|recover) ;;
  *) printf '%s\n' 'Unknown regression command. Use help.' >&2; exit 2 ;;
esac
if ! "$docker_cli" info >/dev/null 2>&1; then
  printf '%s\n' 'Cannot reach the active Docker daemon. Start Docker/Rancher Desktop and check docker context ls.' >&2
  exit 2
fi
if ! "$docker_cli" image inspect "$REGRESSION_RUNNER_IMAGE" >/dev/null 2>&1; then
  printf 'Regression runner image "%s" is missing in the active Docker context.\n' "$REGRESSION_RUNNER_IMAGE" >&2
  printf 'Build it first: REGRESSION_RUNNER_IMAGE=%q bash tools/regression.sh build\n' "$REGRESSION_RUNNER_IMAGE" >&2
  printf '%s\n' 'If a previous test worked, check for a Docker context switch or image cleanup. The runner never removes images.' >&2
  exit 2
fi
export REGRESSION_INPUT_DIR="${REGRESSION_INPUT_DIR:-$root/.regression/inputs}"
export REGRESSION_PRIVATE_DIR="${REGRESSION_PRIVATE_DIR:-$root/.regression/private}"
export REGRESSION_RUNNER_UID="${REGRESSION_RUNNER_UID:-$(id -u)}"
export REGRESSION_RUNNER_GID="${REGRESSION_RUNNER_GID:-$(id -g)}"
mkdir -p "$REGRESSION_INPUT_DIR" "$REGRESSION_PRIVATE_DIR"
chmod 700 "$REGRESSION_INPUT_DIR" "$REGRESSION_PRIVATE_DIR"
if [[ "$mode" == all || "$mode" =~ ^phase[0-8]$ ]]; then
  # A refresh has no stdin and cannot register a replacement server. Failure
  # blocks installed tests only, never suppressing the isolated case ledger.
  preparation_exit=0
  "${REGRESSION_SETUP_PYTHON:-python3}" "$root/tools/regression_inputs.py" --refresh </dev/null || preparation_exit=$?
  if [[ "$preparation_exit" != 0 ]]; then
    if [[ "$preparation_exit" == 1 ]]; then export REGRESSION_PREPARATION_FAILED=Failed; else export REGRESSION_PREPARATION_FAILED=Blocked; fi
    printf '%s\n' 'Automatic preparation unavailable. Continuing isolated tests; affected installed tests will report Blocked.' >&2
  fi
fi
# Never mount a retained bootstrap/admin credential in a regular test service.
# The aggregate still runs isolated tests with an empty private input mount.
if [[ -e "$REGRESSION_INPUT_DIR/.setup-bootstrap.kubeconfig" || -L "$REGRESSION_INPUT_DIR/.setup-bootstrap.kubeconfig" ||
      -e "$REGRESSION_INPUT_DIR/.setup-access-restore.json" || -L "$REGRESSION_INPUT_DIR/.setup-access-restore.json" ]]; then
  if [[ "$mode" == all || "$mode" =~ ^phase[0-8]$ || "$mode" =~ -(fast|fixtures)$ || "$mode" == selftest ]]; then
    export REGRESSION_INPUT_DIR="$REGRESSION_PRIVATE_DIR/blocked-inputs"
    export REGRESSION_PREPARATION_FAILED=Blocked
    mkdir -p "$REGRESSION_INPUT_DIR"; chmod 700 "$REGRESSION_INPUT_DIR"
    unset REGRESSION_COMPOSE_OVERRIDE
  else
    printf '%s\n' 'An interrupted setup must restore its temporary access before installed checks. Run setup again; no admin fallback is mounted.' >&2
    exit 2
  fi
fi
compose=("$docker_cli" compose -f "$root/dashboard/apps/web/regression/compose.yaml")
if [[ -z "${REGRESSION_COMPOSE_OVERRIDE:-}" && -f "$REGRESSION_INPUT_DIR/compose.override.yaml" ]]; then
  export REGRESSION_COMPOSE_OVERRIDE="$REGRESSION_INPUT_DIR/compose.override.yaml"
fi
if [[ -n "${REGRESSION_COMPOSE_OVERRIDE:-}" ]]; then compose+=(-f "$REGRESSION_COMPOSE_OVERRIDE"); fi
shift
if [[ "$mode" == prepare ]]; then
  "${compose[@]}" run --rm --no-deps prepare "$@"
  exit $?
fi
"${compose[@]}" run --rm --no-deps -T regression "$mode" "$@"
