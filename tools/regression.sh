#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-help}"
docker_cli="${DOCKER_CLI:-docker}"
if [[ "$docker_cli" == */* ]]; then
  export PATH="$(dirname "$docker_cli"):$PATH"
fi
case "$mode" in
  help)
    printf '%s\n' 'Usage: bash tools/regression.sh {build|selftest|typecheck|preflight|locktest|ownedtest|smoke|cleanup-plan|recover}' \
      'Local Linux runner. Only opt-in smoke starts a run-owned CPU model; no global settings change.' \
      'Private inputs: .regression/inputs; reports: .regression/private/runs.' \
      'See docs/development/regression-test-concept.md#local-phase-0-runner.'
    exit 0 ;;
  build)
    revision="$(git -C "$root" rev-parse HEAD)"
    "$docker_cli" build --build-arg "SOURCE_REVISION=$revision" -f "$root/dashboard/apps/web/regression/Dockerfile" \
      -t magicstick-regression:local "$root"
    exit $? ;;
  selftest|typecheck|preflight|locktest|ownedtest|smoke|cleanup-plan|recover) ;;
  *) printf '%s\n' 'Unknown regression command. Use help.' >&2; exit 2 ;;
esac

export REGRESSION_INPUT_DIR="${REGRESSION_INPUT_DIR:-$root/.regression/inputs}"
export REGRESSION_PRIVATE_DIR="${REGRESSION_PRIVATE_DIR:-$root/.regression/private}"
export REGRESSION_RUNNER_UID="${REGRESSION_RUNNER_UID:-$(id -u)}"
export REGRESSION_RUNNER_GID="${REGRESSION_RUNNER_GID:-$(id -g)}"
mkdir -p "$REGRESSION_INPUT_DIR" "$REGRESSION_PRIVATE_DIR"
chmod 700 "$REGRESSION_INPUT_DIR" "$REGRESSION_PRIVATE_DIR"
compose=("$docker_cli" compose -f "$root/dashboard/apps/web/regression/compose.yaml")
# Optional PRIVATE DNS/host mappings, reviewed by the lab owner, not in Git.
if [[ -n "${REGRESSION_COMPOSE_OVERRIDE:-}" ]]; then
  compose+=(-f "$REGRESSION_COMPOSE_OVERRIDE")
fi
shift
"${compose[@]}" run --rm --no-deps regression "$mode" "$@"
