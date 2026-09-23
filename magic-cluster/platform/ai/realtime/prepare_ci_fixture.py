# SPDX-License-Identifier: BUSL-1.1
"""Generate offline image-contract inputs from the real runtime controller.

Synthetic Kubernetes data only; this does not contact an appliance or the Hub.
The Dockerfile and both GPU catalog profiles must use the same exact Omni source.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[4]
CONTROLLER = ROOT / "magic-cluster/platform/magicstick-operator"
sys.path.insert(0, str(CONTROLLER / "controller"))
from test_controller import load_controller  # noqa: E402 - reuse the offline harness


def source_metadata(catalog, dockerfile):
    profiles = catalog["engines"]["VLLM"]["realtimeProfiles"]
    revision = profiles["qwen3-omni-rocm"]["sourceRevision"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Omni source must be an immutable 40-character commit")
    if profiles["qwen3-omni"]["sourceRevision"] != revision:
        raise ValueError("CUDA and ROCm Omni source revisions differ")
    recipe_pin = re.search(r"^ARG OMNI_REVISION=([0-9a-f]{40})$", dockerfile, re.MULTILINE)
    if not recipe_pin or recipe_pin.group(1) != revision:
        raise ValueError("Dockerfile and runtime catalog Omni revisions differ")
    base = re.search(r"^FROM (\S+@sha256:[0-9a-f]{64})$", dockerfile, re.MULTILINE)
    if not base:
        raise ValueError("ROCm base image must be pinned by digest")
    return {"omni_revision": revision, "base_image": base.group(1), "platform": "linux/amd64"}


def prepare(output):
    catalog = json.loads(yaml.safe_load((CONTROLLER / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
    recipe = (Path(__file__).parent / "image/Dockerfile.rocm").read_text()
    metadata = source_metadata(catalog, recipe)
    controller = load_controller()
    node = {"metadata": {"name": "example-node", "uid": "example-node-uid", "labels": {"kubernetes.io/os": "linux"}},
            "status": {"conditions": [{"type": "Ready", "status": "True"}],
                       "allocatable": {"memory": "128Gi", "amd.com/gpu": "2"}}}
    output.mkdir(parents=True, exist_ok=True)
    for count in (1, 2):
        activation = {"metadata": {"name": "omni-contract", "namespace": "ai-system"},
                      "spec": {"type": "local", "enabled": True, "targetNamespace": "ai", "local": {
                          "engine": "VLLM", "computeTarget": "amd-gpu", "modelType": "chat",
                          "url": "hf://example/omni-contract", "contextWindow": 8192, "maxNumSeqs": 1,
                          "realtime": {"profile": "qwen3-omni-rocm", "gpuNode": "example-node", "gpuCount": count,
                                       "runtimeImage": "magicstick-omni-rocm:ci", "systemMemoryMi": 16384}}}}
        with patch.dict(controller, {"compute_target_nodes": lambda *_: [node], "gpu_host_preflight": lambda _: {}}):
            _, _, runtime = controller["realtime_runtime_resources"](activation, catalog)
        data = runtime["configuration"]["data"]
        (output / f"profile-{count}.json").write_text(data["profile.json"] + "\n")
        (output / "bootstrap.py").write_text(data["bootstrap.py"])
    shutil.copyfile(CONTROLLER / "controller/verify_realtime_image.py", output / "verify_realtime_image.py")
    (output / "source.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    metadata = prepare(args.output)
    if args.github_output:
        with args.github_output.open("a") as handle:
            handle.write("omni_revision=" + metadata["omni_revision"] + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
