"""Explicit offline contract check INSIDE the digest-pinned Omni image.

Not part of the host unit-test suite: this imports the actual runtime packages.
Supply the generated bootstrap.py. No model weights or GPU are needed, and no
inference is performed. Run in a disposable container: it patches that container's
reviewed Omni source just as the Realtime bootstrap does.
"""
import argparse
import importlib.util
import json
import pathlib
import runpy
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--rocm-profile", help="Generated ROCm profile.json; verify its actual projection without the CUDA offload shim")
    args = parser.parse_args()
    bootstrap = runpy.run_path(args.bootstrap, run_name="compatibility_check")
    root = pathlib.Path(importlib.util.find_spec("vllm_omni").origin).parent
    if not args.rocm_profile:
        bootstrap["ensure_cpu_offload_projection"](root)
        bootstrap["ensure_cpu_offload_projection"](root)

    from pydantic import ValidationError
    from transformers import Qwen3OmniMoeConfig
    from vllm_omni.config.omni_config import OmniStageLoadConfig, VllmOmniConfig
    from vllm_omni.config.pipeline_registry import resolve_pipeline_config
    from vllm_omni.config.stage_config import load_deploy_config
    from vllm_omni.engine.arg_utils import OmniEngineArgs
    from vllm_omni.engine.stage_init_utils import _project_omni_stage_engine_args

    pipeline = resolve_pipeline_config("qwen3_omni_moe", Qwen3OmniMoeConfig())
    assert pipeline is not None
    with tempfile.TemporaryDirectory() as directory:
        config_path = pathlib.Path(directory) / "profile.json"
        if args.rocm_profile:
            import torch
            from torchcodec.decoders import VideoDecoder  # noqa: F401

            assert torch.version.hip and not torch.version.cuda
            profile = json.loads(pathlib.Path(args.rocm_profile).read_text())
            profile["base_config"] = str(root / "deploy" / profile["base_config"])
            config_path.write_text(json.dumps(profile))
            config = VllmOmniConfig.from_pipeline_config(pipeline, user_deploy_config=load_deploy_config(config_path))
            for index in range(3):
                projected = _project_omni_stage_engine_args(config.stage_by_id(index))
                assert projected["enforce_eager"] is True, (index, projected)
                assert projected.get("cpu_offload_gb", 0) == 0
                if index < 2:
                    assert str(projected["attention_backend"]).split(".")[-1] == "TRITON_ATTN", projected
                    assert projected["max_num_batched_tokens"] <= 8192
                print(f"PASS: actual ROCm duplex config -> stage {index} EngineArgs")
            return
        for amount in (0, 12, 32):
            stages = [{"stage_id": i, "devices": "0", "max_num_seqs": 1} for i in range(3)]
            if amount:
                stages[0]["engine_extras"] = {"cpu_offload_gb": amount}
            profile = {"base_config": str(root / "deploy/qwen3_omni_duplex.yaml"),
                       "session_mode": "duplex", "stages": stages}
            config_path.write_text(json.dumps(profile))
            config = VllmOmniConfig.from_pipeline_config(
                pipeline, user_deploy_config=load_deploy_config(config_path))
            for index in range(3):
                stage = config.stage_by_id(index)
                # Exercise the actual terminal projection. Worker selection is
                # deliberately excluded: the disposable check has no GPU.
                projected = _project_omni_stage_engine_args(stage)
                expected = amount if index == 0 else 0
                assert projected.get("cpu_offload_gb", 0) == expected, (index, projected)
                engine = OmniEngineArgs(model=directory, cpu_offload_gb=projected.get("cpu_offload_gb", 0))
                assert engine.cpu_offload_gb == expected
            print(f"PASS: actual Qwen duplex config -> stage EngineArgs, Thinker offload={amount} GiB")

        stages[0]["engine_extras"] = {"unsupported_magicstick_argument": True}
        profile["stages"] = stages
        config_path.write_text(json.dumps(profile))
        try:
            VllmOmniConfig.from_pipeline_config(pipeline, user_deploy_config=load_deploy_config(config_path))
        except ValueError as error:
            assert "no structured config owner" in str(error)
        else:
            raise AssertionError("Unowned fields must still be rejected")

    for invalid in (-1, float("nan"), float("inf")):
        try:
            OmniStageLoadConfig(cpu_offload_gb=invalid)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"Invalid offload budget accepted: {invalid}")
    print("PASS: ownership and finite/nonnegative field validation remain enabled")


if __name__ == "__main__":
    main()
