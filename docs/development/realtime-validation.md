# Realtime validation

## ROCm build checks

The [ROCm image workflow](../../magic-cluster/platform/ai/realtime/README.md#ci-build-and-publication)
checks real installed Omni imports during the Docker build, before exporting the
large image or a cache. A hash-bound repair skips the pinned upstream's
CUDA-only shutdown patch on HIP/CPU builds; it does not mock a GPU or suppress
runtime errors. The generated one-/two-device stage-contract tests still run
after the build. Registry caches are branch-specific, contain final-image layers
only, and are written only after successful checks. None of these checks replaces
GPU or audio acceptance below.

The final package/license inventory scans the tested container's read-only
filesystem with installed-package catalogers and no network. This avoids Syft's
Docker-daemon TAR export (and a second full-size image copy). Reports retain the
tested image ID, source revision and SBOM checksum; SPDX/CycloneDX conversion and
the existing license review remain required before publication.

## Protocol limits and acceptance

The selected Qwen plugin supports audio/text turns, server VAD or explicit
commits, concurrent input and interruptible audio output. It does **not** provide
model-native continuous input KV processing: each committed turn creates an
inference request. Realtime tool calling and reference-voice audio are not
implemented by this plugin. OpenAI compatibility is not full feature parity;
named voices, session resumption across proxies and every Playground option
must be checked with the selected runtime.

Local tests cover configuration persistence, open experimental selection, scheduling resource bounds,
stage budgets, readiness, lifecycle, slot accounting, log ownership, catalog
publication and the dashboard form. They do not download weights or run CUDA/ROCm.
Before declaring the installation accepted:

- Confirm the image pulls and all three stages load on the intended GPU(s).
- In sharing mode, verify the assigned NVIDIA slot or AMD claim/CDI binding,
  concurrent inference with another model, and manual memory budgets. Confirm
  exhausted slots block new starts and Stop releases only this model's slot.
- In the LiteLLM Realtime Playground, verify microphone input, intelligible audio
  output, a second turn with context, and barge-in/server VAD.
- Verify the authenticated Gateway WebSocket path as well as localhost testing;
  confirm an unauthorized API key cannot open the session.
- Stop/start/restart the model, confirm route withdrawal/recovery and GPU release,
  and check that another ordinary Ollama/vLLM model still answers requests.
- Record the source digest, GPU/driver, settings, logs and outcomes. A Ready
  `/health` alone is not proof of successful speech inference.

Primary sources:

- [Pinned vLLM-Omni source](https://github.com/vllm-project/vllm-omni/tree/f3f8ebfc25de04ea1e1a7900144e6966a57da4f5)
- [Qwen duplex profile](https://github.com/vllm-project/vllm-omni/blob/f3f8ebfc25de04ea1e1a7900144e6966a57da4f5/vllm_omni/deploy/qwen3_omni_duplex.yaml)
- [Qwen plugin capability contract](https://github.com/vllm-project/vllm-omni/blob/f3f8ebfc25de04ea1e1a7900144e6966a57da4f5/vllm_omni/model_executor/models/qwen3_omni/duplex/plugin.py)
- [Realtime duplex API](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/realtime_duplex_api/)
- [LiteLLM 1.101.0](https://github.com/BerriAI/litellm/releases/tag/v1.101.0)
- [OpenAI Realtime conversation schema](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Pinned upstream ROCm build](https://github.com/vllm-project/vllm-omni/blob/f3f8ebfc25de04ea1e1a7900144e6966a57da4f5/docker/Dockerfile.rocm)
- [NVIDIA time-slicing limitations](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html)
- [Kubernetes direct Pod DRA claims](https://kubernetes.io/docs/concepts/resource-management/dynamic-resource-allocation/)
