# Experimental ROCm Realtime image

This image builds the same reviewed Omni revision as the CUDA profile on the
matching immutable vLLM ROCm base. It is a hardware-acceptance candidate, not a
validated Strix Halo release. See [Realtime documentation](../../../../docs/realtime.md).

## CI build and publication

The [Omni ROCm image workflow](../../../../.github/workflows/build-omni-rocm-image.yml)
builds on native `linux/amd64` after relevant pushes to `main`. Pull requests run
the source/fixture contracts without publishing. Manual dispatch on `main` also
supports `publish=false` for a build-and-audit run without registry upload:

```sh
gh workflow run build-omni-rocm-image.yml --ref main -f publish=false
```

CI derives the exact Omni commit from the runtime catalog and rejects a mismatch
with the Dockerfile or CUDA profile. It builds the image, checks the actual
installed one-/two-device stage configuration without a GPU or model download,
and creates final-image SPDX/CycloneDX/Syft inventories. The native contract runs
without networking, privileged mode, host device mounts or model weights.

Publication uses the repository's `GITHUB_TOKEN` with `packages: write`, not a
developer's local Docker login or a personal token. Source checks must pass
before registry login or push. Open license-review items are retained as
advisory warnings, not a global publication veto; `publish=false` never uploads.
The organization must allow this repository's Actions token to write the GHCR
package. The workflow does not alter package visibility or organization policy.

After publication the workflow records
`ghcr.io/qualityminds/magicstick-omni-rocm:sha-<full-source-commit>` and the exact
digest, and creates a build attestation. `omni-rocm-evidence-<source-commit>` keeps
the generated contract and inventory reports for 30 days, including blocked
releases. Archive accepted release evidence separately for longer retention.
No catalog update or appliance rollout is performed by the build job. The digest
still needs explicit review/promotion; passing CI is not GPU/audio acceptance.

## Local development build

For development, build from the repository root on an amd64 Docker builder
(cross-building is possible but TorchCodec compilation is substantially slower):

```sh
docker build --platform linux/amd64 \
  -f magic-cluster/platform/ai/realtime/image/Dockerfile.rocm \
  -t magicstick-omni-rocm:candidate .
```

The image is large. Check space for compressed layers **and** unpacked snapshots
before importing it on an appliance; retain the kubelet's disk-pressure margin.
Do not evict running workloads or remove cached model weights to fit a test image.

Before GPU testing, run the controller's `verify_realtime_image.py` inside a
disposable candidate container, supplying the generated `bootstrap.py` and
`profile.json` with `--bootstrap ... --rocm-profile ...`. It checks the actual
installed Qwen pipeline and stage-argument projection without loading weights.
The Docker build separately checks the ROCm PyTorch ABI, TorchCodec import and
vLLM layout APIs. None of these checks proves GPU kernel or speech inference.
Run the contract check natively on amd64 when possible. For cross-architecture
diagnostics, disable core dumps (`--ulimit core=0`) and bound container memory;
a native-library crash under emulation is not a passing contract or GPU test.

On the appliance, first run `verify_rocm_gpu.py --expected-architecture gfx1151`
inside a disposable candidate Pod with one normally assigned AMD GPU. It tests
small BF16 matrix multiplication, a real vLLM RMSNorm kernel and transpose
convolution. A passing probe is only a prerequisite, not a model acceptance test.

For a live test, use the normal ModelActivation/controller path with one AMD
GPU through exclusive allocation or the existing shared DRA claim, sufficient
shared host RAM, and an explicitly coordinated memory budget for other workloads.
Do not change the sharing mode or stop other models automatically. Shared slots
do not isolate VRAM. Do not bypass normal GPU assignment with host device mounts.
Verify all three stages, `/health`, real text/audio WebSocket
responses, lifecycle and route recovery as described in the main documentation.

An experimental image may be published by CI after technical checks and the
advisory license report, without claiming hardware acceptance. Use its digest as an explicit runtime
override for hardware tests. Only after the appropriate acceptance/review should
its immutable `repository@sha256:...` become the default in
`engines.VLLM.realtimeProfiles.qwen3-omni-rocm.image`. The empty default remains
intentional until promotion; a build must not silently advertise verified support.
