"""Focused contract tests for the direct FreeToken runtime adapter.

The adapter deliberately uses a Deployment and Service rather than a KubeAI
Model.  These tests keep its upstream capability policy and the safety checks
around a whole NVIDIA GPU explicit without requiring a Kubernetes cluster.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_controller():
    manifest = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text(encoding="utf-8"))
    source = manifest["data"]["controller.py"].replace(
        "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)",
        "SSL_CONTEXT = None",
    )
    namespace = {"__name__": "magicstick_freetoken_runtime_test"}
    exec(compile(source, "controller.py", "exec"), namespace)
    return namespace


def compute_catalog():
    manifest = yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text(encoding="utf-8"))
    return yaml.safe_load(manifest["data"]["targets.json"])


def nvidia_node(
    *,
    name="nvidia-node",
    gpu_count="1",
    replicas=None,
    driver="580.12",
    compute_major="8",
    compute_minor="9",
    gpu_memory_mi=24576,
    system_memory="65536Mi",
    device_ids=None,
    device_names=None,
    extra_labels=None,
):
    count = int(gpu_count)
    labels = {
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": "amd64",
        "nvidia.com/gpu.count": gpu_count,
        "nvidia.com/gpu.compute.major": compute_major,
        "nvidia.com/gpu.compute.minor": compute_minor,
        "nvidia.com/mig.strategy": "none",
        "nvidia.com/gpu.memory": str(gpu_memory_mi),
    }
    if replicas is not None:
        labels["nvidia.com/gpu.replicas"] = str(replicas)
    labels.update(extra_labels or {})
    device_ids = device_ids or ["1eb8"] * count
    device_names = device_names or ["NVIDIA RTX"] * count
    devices = [
        {
            "vendorId": "10de", "deviceId": device_ids[index], "name": device_names[index],
            "driverVersion": driver, "memoryTotalMi": gpu_memory_mi,
        }
        for index in range(count)
    ]
    return {
        "metadata": {"name": name, "uid": name + "-uid", "labels": labels},
        "status": {
            "nodeInfo": {"architecture": "amd64"},
            "conditions": [{"type": "Ready", "status": "True"}],
            "allocatable": {"nvidia.com/gpu": gpu_count, "memory": system_memory},
        },
        "_freetoken_host": {
            "displayDevices": devices,
        },
    }


def activation(*, compute_target="nvidia-gpu", model="hf://Qwen/Qwen3.5-35B-A3B", gpu_device="node:nvidia-node", gpu_count=1):
    return {
        "metadata": {"name": "freetoken-qwen", "namespace": "ai-system"},
        "spec": {
            "targetNamespace": "ai",
            "local": {
                "engine": "FreeToken",
                "computeTarget": compute_target,
                "url": model,
                "contextWindow": 32768,
                "maxNumSeqs": 2,
                "maxOutputTokens": 2048,
                "freetoken": {
                    "gpuDevice": gpu_device,
                    "gpuCount": gpu_count,
                    "gpuMemoryMi": 12288,
                    "systemMemoryMi": 8192,
                    "memoryStrategy": "auto",
                    "restartNonce": "restart-1",
                    "advanced": {
                        "cacheType": "radix",
                        "kvReserveTokens": 64,
                        "cudaGraphMaxBatchSize": 8,
                    },
                },
            },
        },
    }


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FreeTokenRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()
        cls.catalog = compute_catalog()

    def test_catalog_declares_pinned_nvidia_only_capability_policy(self):
        capabilities = self.controller["freetoken_capabilities"](self.catalog)

        self.assertEqual(capabilities["version"], "0.1.3")
        self.assertEqual(capabilities["supportedVendors"], ["nvidia"])
        self.assertEqual(capabilities["supportedArchitectures"], ["amd64"])
        self.assertEqual(capabilities["minimumNvidiaDriverMajor"], 580)
        self.assertEqual(capabilities["minimumDevicesPerRuntime"], 1)
        self.assertEqual(capabilities["deviceBinding"], "whole-gpus-single-node")
        self.assertEqual(
            capabilities["tensorParallelism"],
            {
                "sameNodeOnly": True,
                "requiresWholeDevices": True,
                "requiresHomogeneousDevices": True,
                "gpuArgument": "container-local-indices",
                "sizeArgument": "tensor-parallel-size",
            },
        )
        self.assertEqual(
            self.catalog["targets"]["nvidia-gpu"]["engineProfiles"]["FreeToken"]
            ["defaultResourceProfile"],
            "magicstick-freetoken-nvidia-gpu:1",
        )
        self.assertNotIn("FreeToken", self.catalog["targets"]["amd-gpu"]["engines"])
        self.assertNotIn("FreeToken", self.catalog["targets"]["intel-gpu"]["engines"])

    def test_runtime_descriptor_reads_the_provisioned_runtime_configmap(self):
        digest = "sha256:" + "a" * 64
        configmap = {
            "data": {
                "image": "ghcr.io/example/freetoken:v0.1.3",
                "imageDigest": digest,
                "imageSource": "ghcr.io/example/freetoken:v0.1.3",
                "imageRevision": "b" * 40,
                "promotionState": "verified",
                "version": "0.1.3",
                "port": "1919",
                "healthPath": "/health",
                "upstream": "https://github.com/FlashML-org/FreeToken",
            }
        }
        with patch.dict(self.controller, {"get_core_resource": lambda *_args: configmap}):
            descriptor = self.controller["freetoken_runtime_descriptor"]()

        self.assertEqual(descriptor["image"], "ghcr.io/example/freetoken@" + digest)
        self.assertEqual(descriptor["sourceImage"], "ghcr.io/example/freetoken:v0.1.3")
        self.assertTrue(descriptor["imagePinned"])
        self.assertEqual(descriptor["version"], "0.1.3")
        self.assertEqual(descriptor["port"], 1919)
        self.assertEqual(descriptor["healthPath"], "/health")

    def test_rejects_unsupported_amd_target_and_model_family(self):
        with self.assertRaisesRegex(ValueError, "does not support FreeToken|supports NVIDIA GPUs only"):
            self.controller["freetoken_runtime_resources"](
                activation(compute_target="amd-gpu"), {}, self.catalog
            )

        capabilities = self.controller["freetoken_capabilities"](self.catalog)
        with self.assertRaisesRegex(ValueError, "not in the documented FreeToken"):
            self.controller["freetoken_model_supported"]("unrelated/example-gguf", capabilities)

    def test_eligible_node_rejects_mig_time_slicing_and_old_driver(self):
        definition = self.catalog["targets"]["nvidia-gpu"]
        capabilities = self.controller["freetoken_capabilities"](self.catalog)
        cases = (
            (
                nvidia_node(extra_labels={"nvidia.com/mig.config": "all-1g.10gb"}),
                "MIG or non-whole",
            ),
            (nvidia_node(replicas=2), "time-slicing"),
            (nvidia_node(driver="550.54"), "driver r580"),
        )
        for node, expected in cases:
            with self.subTest(expected=expected), patch.dict(
                self.controller,
                {
                    "compute_target_nodes": lambda *_args, node=node: [node],
                    "gpu_host_preflight": lambda item: item["_freetoken_host"],
                },
            ):
                with self.assertRaisesRegex(ValueError, expected):
                    self.controller["freetoken_eligible_nodes"](definition, capabilities)

    def test_deployment_uses_one_whole_nvidia_gpu_and_selected_eligible_node(self):
        node = nvidia_node()
        descriptor = {
            "image": "ghcr.io/example/freetoken:v0.1.3",
            "version": "0.1.3",
            "port": 1919,
            "healthPath": "/health",
            "upstream": "https://github.com/FlashML-org/FreeToken",
        }
        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [node],
                "freetoken_runtime_descriptor": lambda: descriptor,
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            deployment, service, runtime = self.controller["freetoken_runtime_resources"](
                activation(), {}, self.catalog
            )

        self.assertEqual(deployment["kind"], "Deployment")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["template"]["spec"]["runtimeClassName"], "nvidia")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["name"], "freetoken")
        self.assertEqual(container["image"], descriptor["image"])
        self.assertEqual(container["resources"]["requests"]["nvidia.com/gpu"], "1")
        self.assertEqual(container["resources"]["limits"]["nvidia.com/gpu"], "1")
        self.assertFalse(any(key.startswith("nvidia.com/mig-") for key in container["resources"]["limits"]))
        self.assertEqual(container["startupProbe"]["exec"]["command"], ["/usr/local/bin/magicstick-freetoken", "health-live"])
        self.assertEqual(container["readinessProbe"]["exec"]["command"], ["/usr/local/bin/magicstick-freetoken", "health-ready"])
        self.assertEqual(container["livenessProbe"]["exec"]["command"], ["/usr/local/bin/magicstick-freetoken", "health-live"])
        self.assertEqual(
            deployment["spec"]["template"]["spec"]["nodeSelector"],
            {
                "kubernetes.io/os": "linux",
                "kubernetes.io/arch": "amd64",
                "kubernetes.io/hostname": "nvidia-node",
            },
        )
        env = {entry["name"]: entry["value"] for entry in container["env"]}
        self.assertEqual(env["MAGICSTICK_FREETOKEN_MODEL"], "Qwen/Qwen3.5-35B-A3B")
        self.assertEqual(env["MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI"], "12288")
        self.assertEqual(env["MAGICSTICK_FREETOKEN_MOE_STRATEGY"], "auto")
        self.assertEqual(env["MAGICSTICK_FREETOKEN_CONTEXT_LENGTH"], "32768")
        self.assertEqual(env["MAGICSTICK_FREETOKEN_CUDA_GRAPH_MAX_BS"], "8")
        self.assertEqual(service["kind"], "Service")
        self.assertEqual(service["spec"]["ports"][0]["port"], 1919)
        self.assertEqual(runtime["backend"], "freetoken")
        self.assertEqual(runtime["runtimeEndpoint"], "http://freetoken-qwen-freetoken.ai.svc.cluster.local:1919/v1")
        self.assertEqual(runtime["gpuSharing"], {"mode": "exclusive", "node": "nvidia-node", "wholeGpuCount": 1, "tensorParallelSize": 1, "vramMiPerDevice": 12288})
        # Exercise the status writer against the CRD enum. A valid Deployment
        # alone did not catch the API server rejecting every status update.
        patches = []
        with patch.dict(self.controller, {"patch_json": lambda _path, body: patches.append(body)}):
            self.controller["patch_model_status"](
                activation(), "Reconciling", "Starting", "Loading model",
                engine="FreeToken", gpu_allocation_mode=runtime["gpuAllocationMode"],
                gpu_sharing=runtime["gpuSharing"],
            )
        crd = yaml.safe_load((ROOT / "crds/modelactivations.appliance.magicstick.dev.yaml").read_text())
        fields = crd["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["status"]["properties"]
        self.assertIn(patches[0]["status"]["gpuAllocationMode"], fields["gpuAllocationMode"]["enum"])
        self.assertEqual(patches[0]["status"]["gpuSharing"]["mode"], "exclusive")

    def test_deployment_reserves_multiple_whole_gpus_and_sets_tensor_parallel_contract(self):
        node = nvidia_node(gpu_count="2")
        descriptor = {
            "image": "ghcr.io/example/freetoken:v0.1.3", "version": "0.1.3", "port": 1919,
            "healthPath": "/health", "upstream": "https://github.com/FlashML-org/FreeToken",
        }
        multi = activation(gpu_count=2)
        # This is an aggregate budget.  The controller must derive 12 GiB per
        # TP rank, not pass 24 GiB to every GPU.
        multi["spec"]["local"]["freetoken"]["gpuMemoryMi"] = 24576
        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [node],
                "freetoken_runtime_descriptor": lambda: descriptor,
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            deployment, _service, runtime = self.controller["freetoken_runtime_resources"](multi, {}, self.catalog)

        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["resources"]["requests"]["nvidia.com/gpu"], "2")
        self.assertEqual(container["resources"]["limits"]["nvidia.com/gpu"], "2")
        env = {entry["name"]: entry["value"] for entry in container["env"]}
        self.assertEqual(env["MAGICSTICK_FREETOKEN_GPU_COUNT"], "2")
        self.assertEqual(env["MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI"], "24576")
        self.assertEqual(deployment["metadata"]["annotations"]["appliance.magicstick.dev/freetoken-gpu-count"], "2")
        self.assertEqual(runtime["vramMi"], 24576)
        self.assertEqual(runtime["gpuMemoryPerDeviceMi"], 12288)
        self.assertEqual(runtime["staticLimits"]["vramMi"], 49152)
        self.assertEqual(runtime["gpuSharing"], {"mode": "exclusive", "node": "nvidia-node", "wholeGpuCount": 2, "tensorParallelSize": 2, "vramMiPerDevice": 12288})

    def test_multiple_gpu_request_rejects_capacity_mixed_devices_and_known_tp_incompatible_model(self):
        descriptor = {"image": "example/freetoken:v0.1.3", "version": "0.1.3", "port": 1919, "healthPath": "/health"}
        two = nvidia_node(gpu_count="2")
        too_many = activation(gpu_count=3)
        too_many["spec"]["local"]["freetoken"]["gpuMemoryMi"] = 24576
        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [two],
                "freetoken_runtime_descriptor": lambda: descriptor,
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            with self.assertRaisesRegex(ValueError, "only 2 are currently allocatable"):
                self.controller["freetoken_runtime_resources"](too_many, {}, self.catalog)

            too_small_per_rank = activation(gpu_count=2)
            too_small_per_rank["spec"]["local"]["freetoken"]["gpuMemoryMi"] = 300
            with self.assertRaisesRegex(ValueError, "at least 256 MiB for each"):
                self.controller["freetoken_runtime_resources"](too_small_per_rank, {}, self.catalog)

            qwen_vl = activation(model="hf://Qwen/Qwen3-VL-8B-Instruct", gpu_count=2)
            qwen_vl["spec"]["local"]["freetoken"]["gpuMemoryMi"] = 24576
            with self.assertRaisesRegex(ValueError, "does not support tensor parallelism"):
                self.controller["freetoken_runtime_resources"](qwen_vl, {}, self.catalog)

        mixed = nvidia_node(gpu_count="2", device_ids=["1eb8", "2330"])
        definition = self.catalog["targets"]["nvidia-gpu"]
        capabilities = self.controller["freetoken_capabilities"](self.catalog)
        with patch.dict(
            self.controller,
            {
                "compute_target_nodes": lambda *_args: [mixed],
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            with self.assertRaisesRegex(ValueError, "mixed NVIDIA GPU models"):
                self.controller["freetoken_eligible_nodes"](definition, capabilities)

        unknown_identity = nvidia_node(gpu_count="2", device_ids=["", ""], device_names=["", ""])
        with patch.dict(
            self.controller,
            {
                "compute_target_nodes": lambda *_args: [unknown_identity],
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            with self.assertRaisesRegex(ValueError, "incomplete NVIDIA GPU identity inventory"):
                self.controller["freetoken_eligible_nodes"](definition, capabilities)

    def test_entrypoint_uses_container_local_gpu_indices_without_overriding_visibility(self):
        entrypoint = (ROOT.parent / "ai" / "freetoken" / "image" / "entrypoint.sh").read_text(encoding="utf-8")

        self.assertIn('MAGICSTICK_FREETOKEN_GPU_COUNT', entrypoint)
        self.assertIn('--tensor-parallel-size "${EXPECTED_GPU_COUNT}"', entrypoint)
        self.assertIn('--gpu "${gpu_indices}"', entrypoint)
        self.assertNotIn('local visible_devices=', entrypoint)
        self.assertNotIn('export NVIDIA_VISIBLE_DEVICES=', entrypoint)
        self.assertNotIn('export CUDA_VISIBLE_DEVICES=', entrypoint)

    def run_gpu_preflight(self, *, full_runtime=False, **overrides):
        entrypoint = (ROOT.parent / "ai/freetoken/image/entrypoint.sh").read_text()
        functions = entrypoint.split("# Kubernetes invokes these modes", 1)[0]
        # Keep the real shell and Python CUDA checks; only hardware providers
        # and the fixed image Python path are replaced in this local fixture.
        functions = functions.replace("local python_bin=/opt/freetoken/bin/python", "local python_bin=" + sys.executable)
        hardware = r'''
nvidia-smi() {
  if [[ "$1" == "-L" ]]; then
    for ((i=0; i<${TEST_NVML_COUNT:-1}; i++)); do
      printf 'GPU %s: Test GPU (UUID: GPU-test-%s)\n' "$i" "$i"
    done
    if [[ "${TEST_MIG:-0}" == "1" ]]; then printf '  MIG 1g Device 0\n'; fi
  elif [[ "$1" == "--query-gpu=driver_version,memory.free" ]]; then
    printf '595.91.07, 48540\n'
  else
    printf '48540\n'
  fi
}
nvcc() { printf 'Cuda compilation tools, release %s, V%s.88\n' "${TEST_TOOLKIT:-13.0}" "${TEST_TOOLKIT:-13.0}"; }
'''
        with tempfile.TemporaryDirectory() as temporary:
            pathlib.Path(temporary, "torch.py").write_text(textwrap.dedent('''
                import os
                from types import SimpleNamespace
                version = SimpleNamespace(cuda="13.0")
                cuda = SimpleNamespace(
                    is_available=lambda: os.environ.get("CUDA_VISIBLE_DEVICES") != "-1",
                    device_count=lambda: int(os.environ.get("TEST_CUDA_COUNT", "1")),
                    get_device_name=lambda index: "Test GPU",
                )
            '''))
            env = {key: value for key, value in os.environ.items()
                   if key not in {"NVIDIA_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES"}}
            env.update(PYTHONPATH=temporary, MAGICSTICK_FREETOKEN_GPU_COUNT="1", **overrides)
            script = functions + hardware + "\nvalidate_assigned_gpu\n"
            if full_runtime:
                ft = pathlib.Path(temporary, "ft")
                ft.write_text("#!" + sys.executable + "\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n")
                ft.chmod(0o755)
                env.update(FREETOKEN_HOME=temporary, HF_HOME=temporary, XDG_CACHE_HOME=temporary, HOME=temporary)
                script = hardware + entrypoint.replace("/opt/freetoken/bin/python", sys.executable).replace("/opt/freetoken/bin/ft", str(ft))
            return subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)

    def test_full_entrypoint_starts_with_unset_optional_parameters(self):
        result = self.run_gpu_preflight(
            full_runtime=True, NVIDIA_VISIBLE_DEVICES="void",
            MAGICSTICK_FREETOKEN_MODEL="Qwen/Qwen3-VL-8B-Instruct",
            MAGICSTICK_FREETOKEN_VRAM_BUDGET_MI="16384",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        self.assertEqual(args[0], "serve")
        self.assertEqual(args[args.index("--gpu") + 1], "0")
        self.assertNotIn("--max-prefill-length", args)
        self.assertNotIn("--moe-cache-size", args)
        self.assertIn("starting FreeToken", result.stderr)

    def test_full_entrypoint_passes_configured_optional_parameters(self):
        result = self.run_gpu_preflight(
            full_runtime=True, NVIDIA_VISIBLE_DEVICES="void",
            MAGICSTICK_FREETOKEN_MODEL="Qwen/Qwen3-VL-8B-Instruct",
            MAGICSTICK_FREETOKEN_CONTEXT_LENGTH="4096", MAGICSTICK_FREETOKEN_MOE_CACHE_SIZE="0",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        self.assertEqual(args[args.index("--max-seq-len-override") + 1], "4096")
        self.assertEqual(args[args.index("--moe-cache-size") + 1], "0")

    def test_gpu_preflight_accepts_cdi_void_and_absent_legacy_visibility(self):
        for visibility in ({}, {"NVIDIA_VISIBLE_DEVICES": "void"}, {"NVIDIA_VISIBLE_DEVICES": "GPU-test-0"}):
            with self.subTest(visibility=visibility):
                result = self.run_gpu_preflight(**visibility)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("CUDA toolkit 13.0", result.stderr)

    def test_gpu_preflight_still_rejects_missing_extra_mig_and_cuda_hidden_devices(self):
        for overrides, error in (
            ({"TEST_NVML_COUNT": "0"}, "exposes 0"),
            ({"TEST_NVML_COUNT": "2"}, "exposes 2"),
            ({"TEST_MIG": "1"}, "MIG devices"),
            ({"TEST_CUDA_COUNT": "0"}, "found 0"),
            ({"CUDA_VISIBLE_DEVICES": "-1"}, "is_available() is false"),
            ({"TEST_TOOLKIT": "12.9"}, "expected CUDA 13 tooling"),
        ):
            with self.subTest(overrides=overrides):
                result = self.run_gpu_preflight(NVIDIA_VISIBLE_DEVICES="void", **overrides)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(error, result.stderr)

    def test_selected_node_must_remain_eligible(self):
        node = nvidia_node(name="still-eligible")
        descriptor = {"image": "example/freetoken:v0.1.3", "version": "0.1.3", "port": 1919, "healthPath": "/health"}
        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [node],
                "freetoken_runtime_descriptor": lambda: descriptor,
            },
        ):
            with self.assertRaisesRegex(ValueError, "no longer eligible"):
                self.controller["freetoken_runtime_resources"](
                    activation(gpu_device="node:other-node"), {}, self.catalog
                )

    def test_static_node_limits_reject_impossible_vram_and_system_ram(self):
        descriptor = {"image": "example/freetoken:v0.1.3", "version": "0.1.3", "port": 1919, "healthPath": "/health"}
        too_small_gpu = nvidia_node(gpu_memory_mi=8192)
        too_small_ram = nvidia_node(system_memory="4096Mi")

        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [too_small_gpu],
                "freetoken_runtime_descriptor": lambda: descriptor,
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            with self.assertRaisesRegex(ValueError, "GPU memory budget .* exceeding detected per-GPU VRAM"):
                self.controller["freetoken_runtime_resources"](activation(), {}, self.catalog)

        ram_activation = activation()
        ram_activation["spec"]["local"]["freetoken"]["gpuMemoryMi"] = 4096
        with patch.dict(
            self.controller,
            {
                "freetoken_eligible_nodes": lambda *_args: [too_small_ram],
                "freetoken_runtime_descriptor": lambda: descriptor,
                "gpu_host_preflight": lambda item: item["_freetoken_host"],
            },
        ):
            with self.assertRaisesRegex(ValueError, "system RAM reservation .* exceeds Kubernetes allocatable RAM"):
                self.controller["freetoken_runtime_resources"](ram_activation, {}, self.catalog)

    def test_health_probes_service_root_when_runtime_endpoint_is_versioned(self):
        urlopen = self.controller["urllib"].request.urlopen
        try:
            captured = []

            def responding(request, timeout):
                captured.append((request, timeout))
                return FakeResponse(b'{"status":"ok"}')

            self.controller["urllib"].request.urlopen = responding
            state, message, payload = self.controller["freetoken_health"](
                "http://freetoken-qwen.ai.svc.cluster.local:1919/v1"
            )
        finally:
            self.controller["urllib"].request.urlopen = urlopen

        self.assertEqual(state, "ok")
        self.assertEqual(message, "")
        self.assertEqual(payload, {"status": "ok"})
        self.assertEqual(captured[0][0].full_url, "http://freetoken-qwen.ai.svc.cluster.local:1919/health")

    def test_health_error_is_actionable_even_when_the_endpoint_returns_http_200(self):
        urlopen = self.controller["urllib"].request.urlopen
        try:
            self.controller["urllib"].request.urlopen = lambda *_args, **_kwargs: FakeResponse(
                b'{"status":"error","message":"CUDA out of memory while loading weights"}'
            )
            state, message, payload = self.controller["freetoken_health"](
                "http://freetoken-qwen.ai.svc.cluster.local:1919/v1"
            )
        finally:
            self.controller["urllib"].request.urlopen = urlopen

        self.assertEqual(state, "error")
        self.assertIn("could not reserve the requested GPU memory", message)
        self.assertEqual(payload["status"], "error")

    def test_reconcile_surfaces_a_terminal_health_error_before_a_pod_becomes_ready(self):
        deployment = {
            "metadata": {"namespace": "ai", "name": "freetoken-qwen-freetoken"},
            "status": {"readyReplicas": 0, "availableReplicas": 0},
        }
        runtime = {
            "runtimeDescriptor": {"image": "ghcr.io/example/freetoken@sha256:" + "a" * 64, "imagePinned": True},
            "runtimeEndpoint": "http://freetoken-qwen-freetoken.ai.svc.cluster.local:1919/v1",
        }
        with patch.dict(self.controller, {
            "apply_resource": lambda _resource: None,
            "get_resource": lambda *_args: deployment,
            "freetoken_health": lambda _endpoint: ("error", "FreeToken could not reserve the requested GPU memory.", {}),
        }):
            phase, reason, message = self.controller["reconcile_freetoken_runtime"](
                activation(), deployment, {"kind": "Service"}, runtime
            )

        self.assertEqual((phase, reason), ("Degraded", "FreeTokenHealthFailed"))
        self.assertIn("could not reserve", message)

    def test_normalizes_documented_v013_stats_to_flat_freetoken_status_contract(self):
        urlopen = self.controller["urllib"].request.urlopen
        payload = {
            "vram_bytes": 4 * 1024 * 1024 * 1024,
            "throughput": {"decode_tps": 12.5, "prefill_tps": 3.5},
            "requests": {
                "active": 2,
                "completed": 7,
                "p95_ms": 240,
                "ttft_mean_ms": 80,
                "prompt_tokens_total": 1000,
                "completion_tokens_total": 250,
            },
            "kv": {"used_pages": 4, "total_pages": 16, "page_size": 32},
            "mamba": {"used_slots": 1, "total_slots": 3},
            "swa": {"used_pages": 5, "total_pages": 20, "page_size": 8},
        }
        try:
            self.controller["urllib"].request.urlopen = lambda *_args, **_kwargs: FakeResponse(
                json.dumps(payload).encode("utf-8")
            )
            stats = self.controller["freetoken_runtime_stats"](
                "http://freetoken-qwen.ai.svc.cluster.local:1919/v1"
            )
        finally:
            self.controller["urllib"].request.urlopen = urlopen

        self.assertEqual(stats["source"], "freetoken-v1-stats/v0.1.3")
        self.assertEqual(stats["vramMi"], 4096)
        self.assertEqual(stats["decodeTokensPerSecond"], 12.5)
        self.assertEqual(stats["prefillTokensPerSecond"], 3.5)
        self.assertEqual(stats["tokensPerSecond"], 16.0)
        self.assertEqual(stats["activeRequests"], 2)
        self.assertEqual(stats["completedRequests"], 7)
        self.assertEqual(stats["p95LatencyMs"], 240)
        self.assertEqual(stats["ttftMs"], 80)
        self.assertEqual(stats["lifetimeTokens"], 1250)
        self.assertEqual(stats["kvTotalPages"], 16)

    def test_free_token_stats_are_patched_without_changing_memory_usage_contract(self):
        calls = []
        sample = {"source": "freetoken-v1-stats/v0.1.3", "vramMi": 4096}
        with patch.dict(self.controller, {"patch_json": lambda path, body, *_args: calls.append((path, body))}):
            self.controller["patch_model_status"](
                activation(), "Ready", "FreeTokenRuntimeReady", "ready",
                free_token_stats=sample,
            )

        status = calls[0][1]["status"]
        self.assertEqual(status["freeTokenStats"], sample)
        self.assertIsNone(status["memoryUsage"])

    def test_unpinned_runtime_descriptor_fails_closed_before_resources_are_applied(self):
        applied = []
        runtime = {
            "runtimeDescriptor": {"image": "ghcr.io/example/freetoken:v0.1.3", "imagePinned": False},
            "runtimeEndpoint": "http://freetoken.ai.svc.cluster.local:1919/v1",
        }
        with patch.dict(self.controller, {"apply_resource": lambda resource: applied.append(resource)}):
            phase, reason, message = self.controller["reconcile_freetoken_runtime"](
                activation(), {"metadata": {"namespace": "ai", "name": "freetoken"}}, {"kind": "Service"}, runtime
            )

        self.assertEqual((phase, reason), ("WaitingForRuntime", "FreeTokenRuntimeImageUnverified"))
        self.assertIn("digest-pinned", message)
        self.assertEqual(applied, [])

    def test_existing_vllm_path_still_builds_a_kubeai_model(self):
        activation_vllm = {
            "metadata": {"name": "existing-vllm"},
            "spec": {
                "targetNamespace": "ai",
                "local": {
                    "engine": "VLLM",
                    "computeTarget": "nvidia-gpu",
                    "url": "hf://example/vllm-model",
                    "vramMi": 4096,
                    "contextWindow": 4096,
                    "maxNumSeqs": 1,
                },
            },
        }

        resource, runtime = self.controller["kubeai_model_resource"](activation_vllm, {})

        self.assertEqual(resource["kind"], "Model")
        self.assertEqual(resource["spec"]["engine"], "VLLM")
        self.assertEqual(runtime["engine"], "VLLM")
        self.assertNotEqual(resource["kind"], "Deployment")


if __name__ == "__main__":
    unittest.main()
