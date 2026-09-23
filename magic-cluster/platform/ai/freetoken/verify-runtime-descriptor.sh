#!/usr/bin/env bash
# Validate the deliberately small, release-owned FreeToken runtime descriptor.
# This is not a general YAML parser; it verifies the exact public ConfigMap
# schema that the promotion workflow writes.
set -euo pipefail

descriptor="${1:-magic-cluster/platform/ai/freetoken/runtime-configmap.yaml}"

if [[ ! -f "${descriptor}" ]]; then
  echo "FreeToken runtime descriptor does not exist: ${descriptor}" >&2
  exit 1
fi

value() {
  local key="$1"
  local result
  result="$(sed -n -E "s/^  ${key}: (.*)$/\\1/p" "${descriptor}" | head -n 1)"
  result="${result#\"}"
  result="${result%\"}"
  printf '%s' "${result}"
}

image="$(value image)"
image_digest="$(value imageDigest)"
image_source="$(value imageSource)"
image_revision="$(value imageRevision)"
promotion_state="$(value promotionState)"
version="$(value version)"

expected_source="ghcr.io/qualityminds/magicstick-freetoken:v${version}"
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FreeToken runtime descriptor has an invalid version." >&2
  exit 1
fi
if [[ "${image_source}" != "${expected_source}" ]]; then
  echo "FreeToken runtime descriptor source must match its version." >&2
  exit 1
fi

case "${promotion_state}" in
  pending)
    if [[ -n "${image}" || -n "${image_digest}" || -n "${image_revision}" ]]; then
      echo "An unpromoted FreeToken descriptor must not contain an image reference or digest." >&2
      exit 1
    fi
    ;;
  verified)
    if [[ ! "${image_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "A promoted FreeToken descriptor requires a SHA-256 image digest." >&2
      exit 1
    fi
    if [[ "${image}" != "ghcr.io/qualityminds/magicstick-freetoken@${image_digest}" ]]; then
      echo "The promoted FreeToken image must be the exact configured digest reference." >&2
      exit 1
    fi
    if [[ ! "${image_revision}" =~ ^[a-f0-9]{40}$ ]]; then
      echo "A promoted FreeToken descriptor requires the attested source revision." >&2
      exit 1
    fi
    ;;
  *)
    echo "FreeToken runtime promotionState must be pending or verified." >&2
    exit 1
    ;;
esac

echo "FreeToken runtime descriptor is ${promotion_state}."
