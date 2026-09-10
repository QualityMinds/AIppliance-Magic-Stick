#!/usr/bin/env python3
"""Small, model-free ROCm computation proof inside the exact inference image."""

import argparse
import json
import re
import sys
import time


def validate(torch, expected_architecture="gfx1151", device_index=0):
    if not getattr(torch.version, "hip", None):
        raise RuntimeError("PyTorch is not built for HIP/ROCm")
    if not torch.cuda.is_available() or torch.cuda.device_count() <= device_index:
        raise RuntimeError("No selected HIP GPU is available")
    properties = torch.cuda.get_device_properties(device_index)
    architecture = str(getattr(properties, "gcnArchName", "")).split(":")[0]
    if architecture != expected_architecture:
        raise RuntimeError(f"GPU architecture mismatch: expected {expected_architecture}, detected {architecture or 'unknown'}")
    device = torch.device(f"cuda:{device_index}")
    # Integers make the expected FP32 matmul exact at this small scale; no random inputs.
    left = (torch.arange(64 * 64, dtype=torch.float32).reshape(64, 64) % 13) - 6
    right = (torch.arange(64 * 64, dtype=torch.float32).reshape(64, 64) % 7) - 3
    expected = left @ right
    start = time.monotonic()
    result_gpu = left.to(device) @ right.to(device)
    if result_gpu.device.type != "cuda":
        raise RuntimeError("Computation was not placed on the GPU")
    torch.cuda.synchronize(device)
    result = result_gpu.cpu()
    if not bool(torch.isfinite(result).all()) or not bool(torch.equal(result, expected)):
        raise RuntimeError("HIP matrix result did not match the exact CPU reference")
    return {"schemaVersion": 1, "status": "passed", "test": "fp32-matmul-64x64-exact", "architecture": architecture,
            "deviceIndex": device_index, "hipVersion": torch.version.hip, "torchVersion": torch.__version__,
            "elapsedSeconds": round(time.monotonic() - start, 6), "modelInferenceValidated": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-architecture", default="gfx1151")
    parser.add_argument("--device-index", type=int, default=0)
    args = parser.parse_args()
    if not re.fullmatch(r"gfx[0-9a-f]+", args.expected_architecture) or args.device_index < 0:
        parser.error("Expected a gfx architecture and a non-negative device index")
    try:
        import torch
        report = validate(torch, args.expected_architecture, args.device_index)
    except Exception as error:
        # Avoid traceback/env disclosure; error message is diagnostic, not credentials.
        report = {"schemaVersion": 1, "status": "failed", "reason": str(error)[:500], "modelInferenceValidated": False}
        print(json.dumps(report, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
