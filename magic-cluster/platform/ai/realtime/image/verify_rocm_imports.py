# SPDX-License-Identifier: BUSL-1.1
"""Import the actual installed ROCm/Omni stack without a GPU or network.

Run during docker build, before exporting layers. Keep the generated one-/two-
device stage contract as a separate post-build check; this is not GPU acceptance.
"""


def main():
    import importlib.metadata as metadata

    import torch
    import vllm
    import vllm_omni  # noqa: F401 - executes the real runtime's import-time patches
    from torchcodec.decoders import VideoDecoder  # noqa: F401
    from transformers import Qwen3OmniMoeConfig
    from vllm.v1.kv_cache_interface import compute_layout_strides  # noqa: F401
    from vllm.v1.kv_cache_layout import KVCacheLayout  # noqa: F401
    from vllm_omni.config.omni_config import OmniStageLoadConfig, VllmOmniConfig  # noqa: F401
    from vllm_omni.config.pipeline_registry import resolve_pipeline_config
    from vllm_omni.config.stage_config import load_deploy_config  # noqa: F401
    from vllm_omni.engine.arg_utils import OmniEngineArgs  # noqa: F401
    from vllm_omni.engine.stage_init_utils import _project_omni_stage_engine_args  # noqa: F401

    assert torch.version.hip and not torch.version.cuda, "Expected the immutable ROCm PyTorch ABI"
    assert vllm.__version__.startswith("0.29."), vllm.__version__
    assert metadata.version("vllm-omni").startswith("0.29.")
    assert resolve_pipeline_config("qwen3_omni_moe", Qwen3OmniMoeConfig()) is not None
    print("PASS: installed ROCm/Omni imports and Qwen duplex pipeline (no GPU or inference)")


if __name__ == "__main__":
    main()
