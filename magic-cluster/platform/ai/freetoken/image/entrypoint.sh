#!/usr/bin/env bash
# This adapter deliberately maps only named Magic Stick settings to the
# documented FreeToken v0.1.3 CLI.  It never evals an environment value and it
# intentionally has no generic "extra arguments" escape hatch.
set -Eeuo pipefail

readonly PREFIX="[magicstick-freetoken]"
readonly SERVER_PORT="1919"
readonly MINIMUM_NVIDIA_DRIVER_MAJOR="580"

log() {
  printf '%s %s\n' "${PREFIX}" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 2
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

validate_text() {
  local name="$1"
  local value="$2"
  [[ -n "${value}" ]] || die "${name} is required"
  [[ "${value}" != -* ]] || die "${name} must not start with a dash"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "${name} must not contain a line break"
  ((${#value} <= 255)) || die "${name} is too long"
}

validate_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} must be an integer"
  local numeric=$((10#${value}))
  ((numeric >= minimum)) || die "${name} must be at least ${minimum}"
}

validate_ratio() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^(0|[0-9]+)(\.[0-9]+)?$ ]] || die "${name} must be a decimal number between 0 (exclusive) and 1"
  awk -v value="${value}" 'BEGIN { exit !(value > 0 && value <= 1) }' \
    || die "${name} must be greater than 0 and at most 1"
}

require_writable_directory() {
  local directory="$1"
  mkdir -p "${directory}" || die "cannot create ${directory}; ensure the Pod mounts a writable state directory"
  [[ -w "${directory}" ]] || die "${directory} is not writable; configure the Pod securityContext fsGroup for the FreeToken runtime user"
}

locate_nvidia_smi() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    command -v nvidia-smi
    return
  fi
  if [[ -x /usr/local/nvidia/bin/nvidia-smi ]]; then
    printf '%s' /usr/local/nvidia/bin/nvidia-smi
    return
  fi
  if [[ -x /usr/bin/nvidia-smi ]]; then
    printf '%s' /usr/bin/nvidia-smi
    return
  fi
  die "nvidia-smi is unavailable. FreeToken requires an NVIDIA device-plugin assignment and host driver >=${MINIMUM_NVIDIA_DRIVER_MAJOR}."
}

validate_assigned_gpu() {
  # CDI injects the assigned devices directly and may set
  # NVIDIA_VISIBLE_DEVICES=void to prevent duplicate legacy-hook injection.
  # That variable is not evidence of CUDA availability. Do not rewrite either
  # visibility variable; validate the actual assignment with NVML and CUDA.

  local expected_gpu_count="${MAGICSTICK_FREETOKEN_GPU_COUNT:-1}"
  validate_integer "MAGICSTICK_FREETOKEN_GPU_COUNT" "${expected_gpu_count}" 1
  EXPECTED_GPU_COUNT="${expected_gpu_count}"

  local nvidia_smi
  nvidia_smi="$(locate_nvidia_smi)"
  local listed_gpus
  if ! listed_gpus="$(${nvidia_smi} -L 2>&1)"; then
    die "nvidia-smi could not list the assigned GPUs: ${listed_gpus:-unknown error}"
  fi
  [[ "${listed_gpus}" != *MIG* ]] \
    || die "MIG devices are visible in this Pod. FreeToken requires whole NVIDIA GPUs."
  local -a listed_gpu_rows=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] && listed_gpu_rows+=("${line}")
  done <<< "${listed_gpus}"
  [[ "${#listed_gpu_rows[@]}" -eq "${EXPECTED_GPU_COUNT}" ]] \
    || die "FreeToken expected ${EXPECTED_GPU_COUNT} whole GPU(s), but nvidia-smi exposes ${#listed_gpu_rows[@]}."

  local gpu_info
  if ! gpu_info="$(${nvidia_smi} --query-gpu=driver_version,memory.free --format=csv,noheader,nounits 2>&1)"; then
    die "nvidia-smi could not read the assigned GPU drivers and free memory: ${gpu_info:-unknown error}"
  fi
  local -a gpu_rows=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] && gpu_rows+=("${line}")
  done <<< "${gpu_info}"
  [[ "${#gpu_rows[@]}" -eq "${EXPECTED_GPU_COUNT}" ]] \
    || die "nvidia-smi returned ${#gpu_rows[@]} GPU memory rows, expected ${EXPECTED_GPU_COUNT}."

  local driver_raw free_raw driver_version free_mib driver_major
  GPU_FREE_MIB=""
  GPU_DRIVER_VERSION=""
  for gpu_row in "${gpu_rows[@]}"; do
    IFS=',' read -r driver_raw free_raw <<< "${gpu_row}"
    driver_version="$(trim_whitespace "${driver_raw:-}")"
    free_mib="$(trim_whitespace "${free_raw:-}")"
    [[ "${driver_version}" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]] \
      || die "could not parse an NVIDIA driver version from nvidia-smi: ${driver_version:-empty}"
    validate_integer "nvidia-smi free VRAM" "${free_mib}" 1
    driver_major=$((10#${driver_version%%.*}))
    ((driver_major >= MINIMUM_NVIDIA_DRIVER_MAJOR)) \
      || die "NVIDIA driver ${driver_version} is too old. FreeToken v0.1.3 requires driver >=${MINIMUM_NVIDIA_DRIVER_MAJOR} for its CUDA 13 runtime."
    if [[ -z "${GPU_FREE_MIB}" || $((10#${free_mib})) -lt $((10#${GPU_FREE_MIB})) ]]; then
      GPU_FREE_MIB="${free_mib}"
    fi
    GPU_DRIVER_VERSION="${driver_version}"
  done

  command -v nvcc >/dev/null 2>&1 \
    || die "nvcc is missing from this image; the required CUDA 13 toolchain is unavailable"
  local toolkit_version
  toolkit_version="$(nvcc --version | awk '/release/ { for (i = 1; i < NF; i++) if ($i == "release") { value = $(i + 1); sub(/,/, "", value); print value; exit } }')"
  [[ "${toolkit_version}" == 13.* ]] \
    || die "expected CUDA 13 tooling, but nvcc reported ${toolkit_version:-an unknown version}"

  local python_bin=/opt/freetoken/bin/python
  [[ -x "${python_bin}" ]] || die "the FreeToken Python environment is missing"
  local cuda_probe
  if ! cuda_probe="$(${python_bin} - "${EXPECTED_GPU_COUNT}" <<'PY' 2>&1
import sys
import torch

expected = int(sys.argv[1])
if not torch.cuda.is_available():
    raise SystemExit("torch.cuda.is_available() is false")
if torch.cuda.device_count() != expected:
    raise SystemExit(f"expected {expected} CUDA-visible GPU(s), found {torch.cuda.device_count()}")
cuda = str(torch.version.cuda or "")
if not cuda.startswith("13."):
    raise SystemExit(f"FreeToken v0.1.3 requires CUDA 13, but PyTorch reports {cuda or 'none'}")
names = ", ".join(f"GPU {index}: {torch.cuda.get_device_name(index)}" for index in range(expected))
print(f"CUDA {cuda}; {names}")
PY
  )"; then
    die "FreeToken CUDA availability check failed: ${cuda_probe:-no diagnostic output}"
  fi

  # PyTorch's CUDA probe can create a context and consume a small amount of
  # device memory.  Sample free VRAM again immediately before the budget is
  # converted to --memory-ratio, so the user-facing budget is bounded by the
  # most current value this process can observe rather than an earlier probe.
  local refreshed_info
  if ! refreshed_info="$(${nvidia_smi} --query-gpu=memory.free --format=csv,noheader,nounits 2>&1)"; then
    die "nvidia-smi could not refresh assigned GPU free VRAM: ${refreshed_info:-unknown error}"
  fi
  local -a refreshed_rows=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] && refreshed_rows+=("${line}")
  done <<< "${refreshed_info}"
  [[ "${#refreshed_rows[@]}" -eq "${EXPECTED_GPU_COUNT}" ]] \
    || die "nvidia-smi returned ${#refreshed_rows[@]} refreshed GPU memory rows, expected ${EXPECTED_GPU_COUNT}."
  GPU_FREE_MIB=""
  for free_raw in "${refreshed_rows[@]}"; do
    free_mib="$(trim_whitespace "${free_raw:-}")"
    validate_integer "nvidia-smi current free VRAM" "${free_mib}" 1
    if [[ -z "${GPU_FREE_MIB}" || $((10#${free_mib})) -lt $((10#${GPU_FREE_MIB})) ]]; then
      GPU_FREE_MIB="${free_mib}"
    fi
  done
  CUDA_TOOLKIT_VERSION="${toolkit_version}"
  log "validated ${EXPECTED_GPU_COUNT} whole NVIDIA GPU(s), driver ${GPU_DRIVER_VERSION}, CUDA toolkit ${CUDA_TOOLKIT_VERSION}, ${cuda_probe}"
}

append_positive_integer() {
  local name="$1"
  local flag="$2"
  local value="${!name:-}"
  [[ -n "${value}" ]] || return 0
  validate_integer "${name}" "${value}" 1
  args+=("${flag}" "${value}")
}

append_nonnegative_integer() {
  local name="$1"
  local flag="$2"
  local value="${!name:-}"
  [[ -n "${value}" ]] || return 0
  validate_integer "${name}" "${value}" 0
  args+=("${flag}" "${value}")
}

probe_freetoken_health() {
  local mode="$1"
  local python_bin=/opt/freetoken/bin/python
  [[ -x "${python_bin}" ]] || {
    log "health probe cannot find the FreeToken Python runtime"
    return 1
  }
  "${python_bin}" - "${mode}" "${SERVER_PORT}" <<'PY'
import json
import sys
import urllib.request

mode, port = sys.argv[1:]
url = f"http://127.0.0.1:{port}/health"
try:
    with urllib.request.urlopen(url, timeout=3) as response:
        body = response.read().decode("utf-8", errors="replace")
    payload = json.loads(body)
except Exception as error:
    print(f"FreeToken health probe failed: {error}", file=sys.stderr)
    raise SystemExit(1)

if not isinstance(payload, dict):
    print("FreeToken health probe received a non-object JSON payload", file=sys.stderr)
    raise SystemExit(1)

status = str(payload.get("status") or "").strip().lower()
if status == "error":
    detail = str(payload.get("message") or payload.get("error") or "runtime reported status:error")
    print(f"FreeToken health probe rejected runtime error: {detail}", file=sys.stderr)
    raise SystemExit(1)

if mode == "health-ready":
    if status not in {"ok", "ready", "healthy"}:
        print(f"FreeToken is not ready yet (status={status or 'missing'})", file=sys.stderr)
        raise SystemExit(1)
elif mode != "health-live":
    print(f"unknown FreeToken health probe mode: {mode}", file=sys.stderr)
    raise SystemExit(2)
PY
}

# Kubernetes invokes these modes independently of the main runtime process.
# They intentionally run before model/GPU validation, because a readiness or
# liveness check must only inspect an already-running HTTP server.
case "${1:-}" in
  health-ready|health-live)
    probe_freetoken_health "$1"
    exit 0
    ;;
esac

state_dir="${FREETOKEN_HOME:-/var/lib/freetoken}"
export FREETOKEN_HOME="${state_dir}"
export HOME="${HOME:-${state_dir}}"
export HF_HOME="${HF_HOME:-${state_dir}/huggingface}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${state_dir}/.cache}"
require_writable_directory "${FREETOKEN_HOME}"
require_writable_directory "${HF_HOME}"
require_writable_directory "${XDG_CACHE_HOME}"

model="$(trim_whitespace "${MAGICSTICK_FREETOKEN_MODEL:-}")"
validate_text "MAGICSTICK_FREETOKEN_MODEL" "${model}"
served_model_name="$(trim_whitespace "${MAGICSTICK_FREETOKEN_SERVED_MODEL_NAME:-}")"
if [[ -n "${served_model_name}" ]]; then
  validate_text "MAGICSTICK_FREETOKEN_SERVED_MODEL_NAME" "${served_model_name}"
fi

validate_assigned_gpu

# CUDA_VISIBLE_DEVICES/NVIDIA_VISIBLE_DEVICES (or the container's CDI device
# specification) is assigned by the Kubernetes device plugin.  These are
# container-local indices, not host-global GPU IDs.  FreeToken maps entry i in
# this comma-separated list to tensor-parallel rank i.
gpu_indices=""
for ((gpu_index = 0; gpu_index < EXPECTED_GPU_COUNT; gpu_index += 1)); do
  gpu_indices+="${gpu_indices:+,}${gpu_index}"
done
args=(serve --model "${model}" --host 0.0.0.0 --port "${SERVER_PORT}" --gpu "${gpu_indices}" --tensor-parallel-size "${EXPECTED_GPU_COUNT}")
if [[ -n "${served_model_name}" ]]; then
  args+=(--served-model-name "${served_model_name}")
fi

vram_budget_mi="${MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI:-}"
memory_ratio="${MAGICSTICK_FREETOKEN_MEMORY_RATIO:-}"
if [[ -n "${vram_budget_mi}" && -n "${memory_ratio}" ]]; then
  die "set either MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI or MAGICSTICK_FREETOKEN_MEMORY_RATIO, not both"
fi
if [[ -n "${vram_budget_mi}" ]]; then
  validate_integer "MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI" "${vram_budget_mi}" 1
  per_gpu_budget_mi=$((10#${vram_budget_mi} / EXPECTED_GPU_COUNT))
  ((per_gpu_budget_mi >= 1)) \
    || die "MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI=${vram_budget_mi}Mi cannot provide a positive budget for all ${EXPECTED_GPU_COUNT} GPUs"
  ((per_gpu_budget_mi <= 10#${GPU_FREE_MIB})) \
    || die "MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI=${vram_budget_mi}Mi requires ${per_gpu_budget_mi}Mi per GPU, exceeding the current minimum free VRAM (${GPU_FREE_MIB}Mi) across assigned GPUs"
  memory_ratio="$(awk -v budget="${per_gpu_budget_mi}" -v free="${GPU_FREE_MIB}" 'BEGIN { printf "%.6f", budget / free }')"
  validate_ratio "calculated FreeToken memory ratio" "${memory_ratio}"
  log "mapping ${vram_budget_mi}Mi total (${per_gpu_budget_mi}Mi per GPU; minimum free ${GPU_FREE_MIB}Mi) to --memory-ratio=${memory_ratio}"
fi
if [[ -n "${memory_ratio}" ]]; then
  validate_ratio "MAGICSTICK_FREETOKEN_MEMORY_RATIO" "${memory_ratio}"
  args+=(--memory-ratio "${memory_ratio}")
fi

moe_strategy="${MAGICSTICK_FREETOKEN_MOE_STRATEGY:-auto}"
case "${moe_strategy}" in
  auto|fused|offload|cpu|hybrid) ;;
  *) die "MAGICSTICK_FREETOKEN_MOE_STRATEGY must be auto, fused, offload, cpu, or hybrid" ;;
esac
args+=(--moe-strategy "${moe_strategy}")

cache_type="${MAGICSTICK_FREETOKEN_CACHE_TYPE:-radix}"
case "${cache_type}" in
  radix|naive) ;;
  *) die "MAGICSTICK_FREETOKEN_CACHE_TYPE must be radix or naive" ;;
esac
args+=(--cache-type "${cache_type}")

dtype="${MAGICSTICK_FREETOKEN_DTYPE:-auto}"
case "${dtype}" in
  auto|float16|bfloat16|float32) ;;
  *) die "MAGICSTICK_FREETOKEN_DTYPE must be auto, float16, bfloat16, or float32" ;;
esac
args+=(--dtype "${dtype}")

expert_load="${MAGICSTICK_FREETOKEN_EXPERT_LOAD:-auto}"
case "${expert_load}" in
  auto|serial|parallel) ;;
  *) die "MAGICSTICK_FREETOKEN_EXPERT_LOAD must be auto, serial, or parallel" ;;
esac
args+=(--expert-load "${expert_load}")

append_positive_integer MAGICSTICK_FREETOKEN_CONTEXT_LENGTH --max-seq-len-override
append_positive_integer MAGICSTICK_FREETOKEN_MAX_RUNNING_REQUESTS --max-running-requests
append_positive_integer MAGICSTICK_FREETOKEN_MAX_OUTPUT_TOKENS --max-output-tokens
append_positive_integer MAGICSTICK_FREETOKEN_MAX_PREFILL_LENGTH --max-prefill-length
append_positive_integer MAGICSTICK_FREETOKEN_CUDA_GRAPH_MAX_BS --cuda-graph-max-bs
append_positive_integer MAGICSTICK_FREETOKEN_KV_RESERVE_TOKENS --kv-reserve-tokens
append_nonnegative_integer MAGICSTICK_FREETOKEN_MOE_CACHE_SIZE --moe-cache-size
append_positive_integer MAGICSTICK_FREETOKEN_MOE_CPU_THREADS --moe-cpu-threads

log "starting FreeToken with ${EXPECTED_GPU_COUNT} assigned whole GPU(s): model=${model}, strategy=${moe_strategy}, cache=${cache_type}, dtype=${dtype}"
exec /opt/freetoken/bin/ft "${args[@]}"
