# SPDX-License-Identifier: BUSL-1.1
"""Restrict the pinned Omni CUDA-only shutdown repair to CUDA builds.

The imported allocator loads libcudart even when the ROCm wheel is inspected
without a GPU. Do not fake a CUDA library, mask import errors or modify vLLM's
allocator. Reject upstream drift so a runtime upgrade requires a fresh review.
"""
import argparse
import hashlib
from pathlib import Path


# vllm-omni f3f8ebfc25de04ea1e1a7900144e6966a57da4f5 / vllm_omni/patch.py
UPSTREAM_SHA256 = "781f2f51f7376b3f248c104d229b7dcd19177cfd4bbf9454c08889fdd44cfab9"
ANCHOR = b"def _patch_cumem_free_callback_cuda() -> None:\n"
GUARDED = ANCHOR + b'''    # Magic Stick: the shutdown repair is CUDA-specific, not a HIP/CPU fix.
    # Build metadata works even on a CI runner with no visible GPU.
    if torch.version.hip is not None or torch.version.cuda is None:
        return
'''


def patch_source(source: bytes) -> bytes:
    already_patched = source.count(GUARDED) == 1
    original = source.replace(GUARDED, ANCHOR, 1) if already_patched else source
    if hashlib.sha256(original).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("Unreviewed vLLM-Omni patch.py; review the ROCm import guard for this revision")
    if original.count(ANCHOR) != 1:
        raise ValueError("Expected exactly one CUDA shutdown patch in the reviewed Omni source")
    return source if already_patched else original.replace(ANCHOR, GUARDED, 1)


def apply(source_root: Path) -> bool:
    target = source_root / "vllm_omni/patch.py"
    source = target.read_bytes()
    updated = patch_source(source)
    if updated == source:
        return False
    target.write_bytes(updated)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    args = parser.parse_args()
    changed = apply(args.source_root)
    print("ROCm CUDA-import guard " + ("applied" if changed else "already verified"))


if __name__ == "__main__":
    main()
