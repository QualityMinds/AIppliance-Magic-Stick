#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-help}"
docker_cli="${DOCKER_CLI:-docker}"
export REGRESSION_RUNNER_IMAGE="${REGRESSION_RUNNER_IMAGE:-magicstick-regression:local}"
if [[ "$docker_cli" == */* ]]; then
  export PATH="$(dirname "$docker_cli"):$PATH"
fi
case "$mode" in
  help)
    printf '%s\n' 'Usage: bash tools/regression.sh {build|selftest|typecheck|phase0|phase1|phase2|preflight|locktest|ownedtest|foundations|smoke-fast|smoke-fixtures|phase2-fast|phase2-fixtures|phase2-readonly|phase2-models|phase2-faults|session-smoke|core-smoke|smoke|model-edit|cleanup-plan|recover}' \
      'phase0 runs the complete P0 harness acceptance, including owned CPU model/key fault and recovery tests.' \
      'phase1 runs the installed CPU/Ollama P0 smoke matrix: sessions, navigation, lifecycle, UI keys, logs and inference.' \
      'phase2 runs the CPU Ollama/vLLM model-control P0 matrix: discovery, forms, persistence, conflicts, memory, logs and external routing.' \
      'phase2-models [ollama|vllm|admission|memory-risk|external] runs a diagnostic subset; never full Phase 2 acceptance.' \
      'Local Linux runner. Opt-in smoke/model-edit use only a run-owned CPU model; no global settings change.' \
      'Private inputs: .regression/inputs; reports: .regression/private/runs.' \
      'See docs/development/regression-test-concept.md#local-phase-0-runner.'
    exit 0 ;;
  build)
    revision="$(git -C "$root" rev-parse HEAD)"
    "$docker_cli" build --build-arg "SOURCE_REVISION=$revision" -f "$root/dashboard/apps/web/regression/Dockerfile" \
      -t "$REGRESSION_RUNNER_IMAGE" "$root"
    exit $? ;;
  selftest|typecheck|phase0|phase1|phase2|preflight|locktest|ownedtest|foundations|smoke-fast|smoke-fixtures|phase2-fast|phase2-fixtures|phase2-readonly|phase2-models|phase2-faults|session-smoke|core-smoke|smoke|model-edit|cleanup-plan|recover) ;;
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
