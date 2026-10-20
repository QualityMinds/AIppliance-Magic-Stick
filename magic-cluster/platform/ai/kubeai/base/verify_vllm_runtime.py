# SPDX-License-Identifier: BUSL-1.1
"""Exercise the wrapper's real vLLM interfaces in the pinned CPU image.

No network, downloaded weights, GPU or appliance access is needed. This is an
import/CLI/configuration contract, not proof of CUDA/ROCm/XPU inference.
"""
import argparse
import ast
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from packaging.version import Version
import yaml


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--controller-manifest", type=Path, required=True,
                     help="Read-only operator ConfigMap source for the native KV-cache producer/consumer contract")
    options = cli.parse_args()
    version = importlib.metadata.version("vllm")
    assert Version(version).public == "0.31.0", f"Unexpected native runtime: {version}"
    manifest = yaml.safe_load(Path(__file__).with_name("vllm-wrapper-configmap.yaml").read_text())
    with tempfile.TemporaryDirectory(prefix="magicstick-vllm-contract-") as directory:
        root = Path(directory)
        for name, source in manifest["data"].items():
            (root / name).write_text(source)
        sys.path.insert(0, directory)
        import wrapper
        from vllm.config import CacheConfig
        from vllm.model_executor.models import ModelRegistry
        from vllm.transformers_utils.config import get_config
        from transformers import Qwen2Config

        architectures = ModelRegistry.get_supported_archs()
        assert "Qwen2ForCausalLM" in architectures
        assert "Qwen4ExpForConditionalGeneration" in architectures
        flash = root / "synthetic-flash-config"
        flash.mkdir()
        (flash / "config.json").write_text(json.dumps({"model_type": "qwen4_exp",
            "architectures": ["Qwen4ExpForConditionalGeneration"]}))
        flash_config = get_config(str(flash), trust_remote_code=False)
        assert flash_config.model_type == "qwen4_exp"
        cache = CacheConfig()
        assert cache.kv_cache_memory_bytes is None
        assert cache.num_gpu_blocks_override is None
        cache.gpu_memory_utilization = 0.25
        assert cache.gpu_memory_utilization == 0.25
        config = Qwen2Config(vocab_size=128, hidden_size=64, intermediate_size=128,
                             num_hidden_layers=2, num_attention_heads=4,
                             num_key_value_heads=2, max_position_embeddings=256)
        config.architectures = ["Qwen2ForCausalLM"]
        model = root / "synthetic-model"
        config.save_pretrained(model)
        environment = {**os.environ, "PYTHONPATH": directory,
                       "MAGICSTICK_VLLM_WRAPPER_ENABLED": "false",
                       "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
        # Use the real child script and registry, but never fabricate devices.
        original_environment = dict(os.environ)
        try:
            os.environ.update(environment)
            probe = wrapper.parallelism_probe(["--model", str(model)])
        finally:
            os.environ.clear()
            os.environ.update(original_environment)
        assert probe == {"devices": [], "heads": 4, "hidden": 64, "layers": 2,
                         "pipeline": True}, probe

        # Parse the GPU adapter's flags using the installed native parser. This
        # does not construct a GPU worker or claim that an accelerator works.
        from vllm.entrypoints.launchers.cli_args import make_arg_parser
        from vllm.utils.argparse_utils import FlexibleArgumentParser
        parser = make_arg_parser(FlexibleArgumentParser())
        # Exercise the real producer as well as the real consumer. Hand-picked
        # flags alone missed the controller's removed FP8 calibration switch.
        controller = yaml.safe_load(options.controller_manifest.read_text())["data"]["controller.py"]
        definition = next(node for node in ast.parse(controller).body
                          if isinstance(node, ast.FunctionDef) and node.name == "model_args_with_kv_cache")
        producer = {}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "controller-kv-cache.py", "exec"), producer)
        for precision in ("auto", "fp8"):
            generated = producer["model_args_with_kv_cache"](["--model", str(model)], precision)
            # Current controller output must itself fit the current pin; the
            # compatibility wrapper cannot hide an obsolete producer contract.
            assert parser.parse_args(generated).kv_cache_dtype == precision
            normalized = wrapper.normalize_legacy_cache_flags(generated)
            parsed = parser.parse_args(normalized)
            assert parsed.kv_cache_dtype == precision
            assert "--calculate-kv-scales" not in normalized
        args = parser.parse_args(["--model", str(model), "--scheduling-policy=priority",
                                  "--gpu-memory-utilization=0.5", "--cpu-offload-gb=1",
                                  "--offload-backend=uva", "--offload-group-size=0",
                                  "--tensor-parallel-size=2", "--pipeline-parallel-size=1",
                                  "--data-parallel-size=1", "--distributed-executor-backend=mp",
                                  "--worker-cls=budget_worker.BudgetWorker"])
        assert args.scheduling_policy == "priority"
        assert args.gpu_memory_utilization == 0.5
        assert args.cpu_offload_gb == 1
        assert args.tensor_parallel_size == 2
        assert args.pipeline_parallel_size == 1
        assert args.worker_cls == "budget_worker.BudgetWorker"
        for backend in ("TRITON_ATTN", "TORCH_SDPA", "FLASH_ATTN"):
            vision = parser.parse_args(["--model", str(model), f"--mm-encoder-attn-backend={backend}"])
            assert getattr(vision.mm_encoder_attn_backend, "name", vision.mm_encoder_attn_backend) == backend
        environment.update(MAGICSTICK_VLLM_WRAPPER_ENABLED="true",
                           MAGICSTICK_VLLM_WRAPPER_APPLIED="false",
                           MAGICSTICK_COMPUTE_TARGET="cpu")
        result = subprocess.run(["vllm", "serve", "--help=all"],
                                env=environment, check=True, capture_output=True,
                                text=True, timeout=120)
        assert "compute_target=cpu" in result.stdout
        assert "--scheduling-policy" in result.stdout
        assert "--tensor-parallel-size" in result.stdout
        # Hardware diagnostics retain this deprecated, still supported alias.
        legacy = subprocess.run([sys.executable, "-m", "vllm.entrypoints.openai.api_server", "--help=all"],
                                env=environment, check=True, capture_output=True,
                                text=True, timeout=120)
        assert "compute_target=cpu" in legacy.stdout
        assert "--scheduling-policy" in legacy.stdout
    print(json.dumps({"runtime": version, "modelRegistry": "passed", "modelConfigProbe": "passed",
                      "flashNextConfig": "passed",
                      "nativeCliFlags": "passed", "cpuEntrypointWrapper": "passed",
                      "controllerKvCacheArguments": "passed",
                      "diagnosticEntrypoint": "passed", "visionCliChoices": "passed",
                      "workerCacheConfig": "passed",
                      "gpuInference": "not-executed"}, sort_keys=True))


if __name__ == "__main__":
    main()
