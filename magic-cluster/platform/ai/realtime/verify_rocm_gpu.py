"""Small, explicit GPU acceptance probe inside the candidate ROCm image.

Requires exactly one GPU assigned by the AMD device plugin or DRA. Does not download
weights or certify Qwen speech inference; run before the full three-stage test.
"""
import argparse
import json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-architecture", required=True)
    args = parser.parse_args()

    import torch
    from vllm import _custom_ops as ops

    if not torch.version.hip or torch.version.cuda:
        raise RuntimeError("This probe requires a ROCm PyTorch build")
    if torch.cuda.device_count() != 1:
        raise RuntimeError("Assign exactly one AMD GPU before running this probe")
    properties = torch.cuda.get_device_properties(0)
    architecture = properties.gcnArchName.split(":")[0]
    if architecture != args.expected_architecture:
        raise RuntimeError(f"Assigned GPU architecture is {architecture}, not {args.expected_architecture}")
    free, total = torch.cuda.mem_get_info()
    if free < 512 * 1024**2:
        raise RuntimeError("Not enough free GPU memory for the bounded kernel probe")

    # PyTorch intentionally uses the torch.cuda API on ROCm as well.
    x = torch.randn(128, 512, device="cuda", dtype=torch.bfloat16)
    product = x @ x.T
    output = torch.empty_like(x)
    weight = torch.ones(512, device="cuda", dtype=torch.bfloat16)
    ops.rms_norm(output, x, weight, 1e-6)
    reference = (x.float() * torch.rsqrt(x.float().square().mean(-1, keepdim=True) + 1e-6)).to(x.dtype)
    torch.testing.assert_close(output, reference, atol=.04, rtol=.04)
    audio = torch.nn.functional.conv_transpose1d(
        torch.randn(1, 32, 16, device="cuda", dtype=torch.bfloat16),
        torch.randn(32, 32, 4, device="cuda", dtype=torch.bfloat16))
    torch.cuda.synchronize()
    if not bool(torch.isfinite(product).all()) or not bool(torch.isfinite(audio).all()):
        raise RuntimeError("GPU kernel probe returned non-finite results")
    print(json.dumps({"result": "passed", "architecture": architecture, "gpu": properties.name,
                      "torch": torch.__version__, "hip": torch.version.hip,
                      "totalMi": total // 1024**2, "freeMiBeforeProbe": free // 1024**2,
                      "checks": ["bf16-matmul", "vllm-rms-norm", "bf16-transpose-convolution"]}))


if __name__ == "__main__":
    main()
