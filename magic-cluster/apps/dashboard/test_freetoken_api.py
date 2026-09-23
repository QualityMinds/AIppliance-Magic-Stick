import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from test_dashboard_api import load_server


def freetoken_capabilities():
    return {
        "version": "0.1.3",
        "operatingSystems": ["linux"],
        "supportedVendors": ["nvidia"],
        "supportedArchitectures": ["amd64"],
        "minimumNvidiaDriverMajor": 580,
        "supportedComputeCapabilities": ["8.6", "8.9", "12.0"],
        "supportedPrecisionModes": ["auto", "float16", "bfloat16", "float32"],
        "minimumDevicesPerRuntime": 1,
        "deviceBinding": "whole-gpus-single-node",
        "tensorParallelism": {
            "supported": True,
            "requiresHomogeneousDevices": True,
            "resource": "nvidia.com/gpu",
        },
        "memoryStrategies": ["auto", "fused", "offload", "cpu", "hybrid"],
        "modelFamilies": ["Qwen3.6"],
        "modelIdMatchers": [r"^qwen/qwen3\.6-27b(?:-fp8)?$"],
    }


def catalog():
    return {
        "schemaVersion": 1,
        "engines": {
            "FreeToken": {
                "displayName": "FreeToken",
                "urlScheme": "hf://",
                "capabilities": freetoken_capabilities(),
            },
        },
        "targets": {
            "nvidia-gpu": {
                "displayName": "NVIDIA GPU",
                "kind": "gpu",
                "vendor": "nvidia",
                "architectures": ["amd64"],
                "nodeSelector": {"kubernetes.io/os": "linux"},
                "resourceNames": ["nvidia.com/gpu"],
                "engines": ["VLLM", "OLlama", "FreeToken"],
                "engineProfiles": {
                    "VLLM": {"defaultResourceProfile": "magicstick-vllm-nvidia-gpu:1"},
                    "OLlama": {"defaultResourceProfile": "magicstick-ollama-nvidia-gpu:1"},
                    "FreeToken": {
                        "defaultResourceProfile": "magicstick-freetoken-nvidia-gpu:1",
                        "nodeSelector": {"kubernetes.io/arch": "amd64"},
                    },
                },
                "defaultResourceProfile": "magicstick-vllm-nvidia-gpu:1",
            },
            "amd-gpu": {
                "displayName": "AMD GPU",
                "kind": "gpu",
                "vendor": "amd",
                "architectures": ["amd64"],
                "nodeSelector": {"kubernetes.io/os": "linux"},
                "resourceNames": ["amd.com/gpu"],
                "engines": ["VLLM", "OLlama"],
                "engineProfiles": {},
            },
        },
    }


def nvidia_node(*, name="nvidia-one", driver="580.12", compute="8.9", replicas=1, mig=False, gpu_count=1):
    major, minor = compute.split(".")
    labels = {
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": "amd64",
        "nvidia.com/gpu.count": str(gpu_count),
        "nvidia.com/gpu.replicas": str(replicas),
        "nvidia.com/gpu.compute.major": major,
        "nvidia.com/gpu.compute.minor": minor,
        "nvidia.com/mig.strategy": "none",
        "nvidia.com/gpu.memory": "24576",
    }
    resources = {"memory": "64Gi", "nvidia.com/gpu": str(gpu_count)}
    if mig:
        resources["nvidia.com/mig-1g.10gb"] = "1"
    report = {
        "nodeUid": name + "-uid",
        "bootId": name + "-boot",
        "kernelVersion": "6.14.0-test",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "displayDevices": [{"vendorId": "10de", "driverVersion": driver, "deviceId": "2684", "name": "NVIDIA RTX 5090"} for _index in range(gpu_count)],
    }
    return {
        "metadata": {
            "name": name,
            "uid": name + "-uid",
            "labels": labels,
            "annotations": {"appliance.magicstick.dev/gpu-host-preflight": json.dumps(report)},
        },
        "status": {
            "capacity": resources,
            "allocatable": dict(resources),
            "nodeInfo": {
                "architecture": "amd64",
                "operatingSystem": "linux",
                "bootID": name + "-boot",
                "kernelVersion": "6.14.0-test",
            },
        },
    }


def amd_node():
    node = nvidia_node(name="amd-one")
    labels = node["metadata"]["labels"]
    for key in list(labels):
        if key.startswith("nvidia.com/"):
            labels.pop(key)
    node["status"]["capacity"].pop("nvidia.com/gpu")
    node["status"]["allocatable"].pop("nvidia.com/gpu")
    node["status"]["capacity"]["amd.com/gpu"] = "1"
    node["status"]["allocatable"]["amd.com/gpu"] = "1"
    report = json.loads(node["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"])
    report["displayDevices"] = [{"vendorId": "1002", "driverVersion": "6.4"}]
    node["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"] = json.dumps(report)
    return node


class FreeTokenDashboardApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def setUp(self):
        self.node = nvidia_node()
        self.catalog = catalog()

    def test_engine_normalization_has_no_shared_kv_cache_contract(self):
        self.assertEqual(self.api["normalize_local_engine"]("freetoken"), "FreeToken")
        self.assertEqual(self.api["default_kv_cache_type"]("FreeToken"), "")
        self.assertEqual(self.api["kv_cache_options"]("FreeToken", "nvidia-gpu"), [])
        self.assertEqual(self.api["normalize_kv_cache_type"]("FreeToken", ""), "")
        with self.assertRaisesRegex(self.api["RequestError"], "local.freetoken.advanced"):
            self.api["normalize_kv_cache_type"]("FreeToken", "fp8")

    def test_freetoken_discovery_uses_its_catalog_policy_without_the_vllm_hub_filter(self):
        supported = {
            "id": "Qwen/Qwen3.6-27B",
            "pipeline_tag": "text-generation",
            "tags": ["safetensors"],
            "siblings": [{"rfilename": "model.safetensors", "size": 1024}],
        }
        unsupported = {
            "id": "community/Qwen3.6-27B-AWQ",
            "pipeline_tag": "text-generation",
            "tags": ["safetensors", "awq"],
            "siblings": [{"rfilename": "model.safetensors", "size": 1024}],
        }
        calls = []

        def fake_fetch(url, required=True):
            calls.append((url, required))
            return [unsupported, supported]

        self.api["HF_DISCOVERY_CACHE"].clear()
        try:
            with patch.dict(self.api, {
                "compute_target_catalog": lambda: self.catalog,
                "fetch_hf_discovery_json": fake_fetch,
            }):
                result = self.api["model_discovery_search"]({
                    "provider": ["huggingface"],
                    "q": ["Qwen"],
                    "limit": ["1"],
                    "engine": ["FreeToken"],
                    "computeTarget": ["nvidia-gpu"],
                    "modelType": ["chat"],
                })
        finally:
            self.api["HF_DISCOVERY_CACHE"].clear()

        self.assertEqual([item["repo"] for item in result["results"]], ["Qwen/Qwen3.6-27B"])
        self.assertEqual(result["results"][0]["compatibility"], "compatible")
        self.assertTrue(calls)
        for url, _required in calls:
            query = self.api["urllib"].parse.parse_qs(self.api["urllib"].parse.urlparse(url).query)
            self.assertNotIn("apps", query)

    def test_freetoken_artifact_discovery_rejects_a_model_outside_the_catalog_policy(self):
        unsupported = {
            "id": "community/Qwen3.6-27B-AWQ",
            "pipeline_tag": "text-generation",
            "tags": ["safetensors", "awq"],
            "siblings": [{"rfilename": "model.safetensors", "size": 1024}],
        }
        self.api["HF_DISCOVERY_CACHE"].clear()
        try:
            with patch.dict(self.api, {
                "compute_target_catalog": lambda: self.catalog,
                "fetch_hf_discovery_json": lambda *_args, **_kwargs: unsupported,
            }):
                with self.assertRaisesRegex(self.api["RequestError"], "supported-model policy"):
                    self.api["model_discovery_artifacts"]({
                        "provider": ["huggingface"],
                        "repo": ["community/Qwen3.6-27B-AWQ"],
                        "engine": ["FreeToken"],
                        "computeTarget": ["nvidia-gpu"],
                        "modelType": ["chat"],
                    })
        finally:
            self.api["HF_DISCOVERY_CACHE"].clear()

    def test_freetoken_artifact_cache_is_invalidated_when_the_catalog_policy_changes(self):
        supported = {
            "id": "Qwen/Qwen3.6-27B",
            "pipeline_tag": "text-generation",
            "tags": ["safetensors"],
            "siblings": [{"rfilename": "model.safetensors", "size": 1024}],
        }
        active_catalog = {"value": catalog()}
        calls = []

        def fake_fetch(url, required=True):
            calls.append((url, required))
            return supported if "/api/models/Qwen/Qwen3.6-27B" in url else []

        query = {
            "provider": ["huggingface"],
            "repo": ["Qwen/Qwen3.6-27B"],
            "engine": ["FreeToken"],
            "computeTarget": ["nvidia-gpu"],
            "modelType": ["chat"],
        }
        self.api["HF_DISCOVERY_CACHE"].clear()
        try:
            with patch.dict(self.api, {
                "compute_target_catalog": lambda: active_catalog["value"],
                "fetch_hf_discovery_json": fake_fetch,
            }):
                first = self.api["model_discovery_artifacts"](query)
                self.assertEqual([item["repo"] for item in first["artifacts"]], ["Qwen/Qwen3.6-27B"])
                first_call_count = len(calls)

                changed = catalog()
                changed["engines"]["FreeToken"]["capabilities"]["version"] = "0.1.4"
                changed["engines"]["FreeToken"]["capabilities"]["modelIdMatchers"] = [r"^other/model$"]
                active_catalog["value"] = changed
                with self.assertRaisesRegex(self.api["RequestError"], "supported-model policy"):
                    self.api["model_discovery_artifacts"](query)
        finally:
            self.api["HF_DISCOVERY_CACHE"].clear()

        self.assertEqual(len(calls), first_call_count + 1, "a changed FreeToken policy must not reuse a cached artifact response")

    def test_capability_gate_accepts_one_supported_nvidia_gpu_and_rejects_others(self):
        capabilities = freetoken_capabilities()
        supported, message = self.api["freetoken_node_eligibility"](self.node, capabilities)
        self.assertTrue(supported, message)
        self.assertIn("1 whole supported NVIDIA GPU", message)

        invalid = {
            "AMD": amd_node(),
            "MIG": nvidia_node(mig=True),
            "time slicing": nvidia_node(replicas=2),
            "unsupported compute capability": nvidia_node(compute="7.5"),
            "old driver": nvidia_node(driver="570.42"),
        }
        for name, node in invalid.items():
            with self.subTest(name=name):
                eligible, reason = self.api["freetoken_node_eligibility"](node, capabilities)
                self.assertFalse(eligible, reason)

        mixed = nvidia_node(gpu_count=2)
        report = json.loads(mixed["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"])
        report["displayDevices"][1].update({"deviceId": "26b5", "name": "NVIDIA RTX 6000 Ada"})
        mixed["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"] = json.dumps(report)
        eligible, reason = self.api["freetoken_node_eligibility"](mixed, capabilities)
        self.assertFalse(eligible, reason)
        self.assertIn("mixed NVIDIA GPU models", reason)

        incomplete = nvidia_node()
        report = json.loads(incomplete["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"])
        report["displayDevices"][0].pop("deviceId")
        report["displayDevices"][0].pop("name")
        incomplete["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"] = json.dumps(report)
        eligible, reason = self.api["freetoken_node_eligibility"](incomplete, capabilities)
        self.assertFalse(eligible, reason)
        self.assertIn("incomplete NVIDIA GPU model inventory", reason)

        extra_inventory = nvidia_node()
        report = json.loads(extra_inventory["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"])
        report["displayDevices"].append(dict(report["displayDevices"][0]))
        extra_inventory["metadata"]["annotations"]["appliance.magicstick.dev/gpu-host-preflight"] = json.dumps(report)
        eligible, reason = self.api["freetoken_node_eligibility"](extra_inventory, capabilities)
        self.assertFalse(eligible, reason)
        self.assertIn("incomplete NVIDIA GPU host inventory", reason)

    def dashboard_patches(self, *, gpu_free_mi=20 * 1024, system_available_mi=48 * 1024, gpu_count=1):
        memory = {
            "devices": [
                {
                    "id": "nvidia-one-" + str(index),
                    "kind": "gpu",
                    "vendor": "nvidia",
                    "computeTarget": "nvidia-gpu",
                    "nodes": ["nvidia-one"],
                    "totalMi": 24 * 1024,
                    "freeMi": gpu_free_mi,
                    "unreservedMi": gpu_free_mi,
                }
                for index in range(gpu_count)
            ],
        }
        return {
            "compute_target_catalog": lambda: self.catalog,
            "ready_schedulable_nodes": lambda: [self.node],
            "summarized_modules": lambda: {"modules": {}},
            "model_activations": lambda: [],
            "compute_memory_summary": lambda _activations: memory,
            "node_memory_samples": lambda _nodes: {
                "nvidia-one": {"availableMi": system_available_mi, "source": "kubelet"},
            },
        }

    def freetoken_payload(self, **freetoken):
        config = {
            "gpuDevice": "node:nvidia-one",
            "gpuMemoryMi": 16 * 1024,
            "systemMemoryMi": 8 * 1024,
            "memoryStrategy": "auto",
            "advanced": {"cacheType": "radix", "moeCacheSize": 0, "cudaGraphMaxBatchSize": 8},
            **freetoken,
        }
        return {
            "name": "qwen-freetoken",
            "local": {
                "url": "hf://Qwen/Qwen3.6-27B",
                "modelType": "chat",
                "engine": "FreeToken",
                "computeTarget": "nvidia-gpu",
                "contextWindow": 8192,
                "maxNumSeqs": 2,
                "freetoken": config,
            },
        }

    def test_dcgm_hostname_variants_bind_live_vram_to_freetoken_node(self):
        for hostname_label in ("hostname", "Hostname"):
            for free_mi in (20 * 1024, 0):
                with self.subTest(label=hostname_label, free_mi=free_mi):
                    labels = 'gpu="0",UUID="GPU-example",modelName="NVIDIA Test GPU",' + hostname_label + '="nvidia-one"'
                    metrics = (
                        'DCGM_FI_DEV_FB_FREE{' + labels + '} ' + str(free_mi) + '\n'
                        'DCGM_FI_DEV_FB_USED{' + labels + '} ' + str(24 * 1024 - free_mi)
                    )
                    patches = self.dashboard_patches()
                    # Exercise the real telemetry -> device -> capability ->
                    # create-validation path, not a pre-bound device fixture.
                    patches.pop("compute_memory_summary")
                    patches["request_text"] = lambda *_args, **_kwargs: metrics
                    with patch.dict(self.api, patches):
                        memory = self.api["compute_memory_summary"]([])
                        targets = self.api["compute_target_availability"]()
                        self.api["attach_freetoken_devices"](memory, targets)
                        devices = self.api["freetoken_selected_memory_devices"](memory, "nvidia-one")
                        self.assertEqual(len(devices), 1)
                        self.assertTrue(devices[0]["freeToken"]["supported"])
                        self.assertEqual(devices[0]["freeToken"]["id"], "node:nvidia-one")
                        self.assertEqual(self.api["freetoken_gpu_memory_limits"](devices, {}), (24 * 1024, free_mi))
                        if free_mi:
                            resource = self.api["model_activation_payload"]("local", self.freetoken_payload())
                            self.assertEqual(resource["spec"]["local"]["freetoken"]["gpuMemoryMi"], 16 * 1024)
                        else:
                            with self.assertRaisesRegex(self.api["RequestError"], "currently free or unreserved VRAM"):
                                self.api["model_activation_payload"]("local", self.freetoken_payload())

    def test_model_payload_persists_only_freetoken_specific_configuration(self):
        with patch.dict(self.api, self.dashboard_patches()):
            resource = self.api["model_activation_payload"]("local", self.freetoken_payload())

        local = resource["spec"]["local"]
        self.assertEqual(local["engine"], "FreeToken")
        self.assertEqual(local["computeTarget"], "nvidia-gpu")
        self.assertEqual(local["url"], "hf://Qwen/Qwen3.6-27B")
        self.assertNotIn("kvCacheType", local)
        self.assertNotIn("vramMi", local)
        self.assertNotIn("cpuOffloading", local)
        self.assertEqual(local["freetoken"], {
            "gpuDevice": "node:nvidia-one",
            "gpuCount": 1,
            "gpuMemoryMi": 16 * 1024,
            "systemMemoryMi": 8 * 1024,
            "memoryStrategy": "auto",
            "advanced": {"cacheType": "radix", "moeCacheSize": 0, "cudaGraphMaxBatchSize": 8},
        })
        self.assertEqual(resource["metadata"]["labels"]["appliance.magicstick.dev/engine"], "freetoken")

    def test_edit_retains_own_runtime_budget_without_adding_it_to_free_memory(self):
        previous = {"metadata": {"name": "qwen-freetoken"}, "spec": {"enabled": True, "local": self.freetoken_payload()["local"]}}
        patches = self.dashboard_patches(gpu_free_mi=1024, system_available_mi=1024)
        memory = patches["compute_memory_summary"]([])
        memory["devices"][0]["unreservedMi"] = 24 * 1024  # excludes this activation
        patches["model_activations"] = lambda: [previous]
        with patch.dict(self.api, patches):
            resource = self.api["model_activation_payload"]("local", self.freetoken_payload(memoryStrategy="hybrid"), "qwen-freetoken")
            self.assertEqual(resource["spec"]["local"]["freetoken"]["gpuMemoryMi"], 16 * 1024)
            self.assertEqual(resource["spec"]["local"]["freetoken"]["systemMemoryMi"], 8 * 1024)
            for config, message in (({"gpuMemoryMi": 16 * 1024 + 1}, "currently free"),
                                    ({"systemMemoryMi": 8 * 1024 + 1}, "currently available RAM")):
                with self.subTest(config=config), self.assertRaisesRegex(self.api["RequestError"], message):
                    self.api["model_activation_payload"]("local", self.freetoken_payload(**config), "qwen-freetoken")
            with self.assertRaisesRegex(self.api["RequestError"], "currently free"):
                self.api["model_activation_payload"]("local", self.freetoken_payload())
            previous["spec"]["enabled"] = False
            with self.assertRaisesRegex(self.api["RequestError"], "currently free"):
                self.api["model_activation_payload"]("local", self.freetoken_payload(), "qwen-freetoken")

    def test_model_payload_rejects_unsupported_model_and_impossible_memory(self):
        cases = (
            (self.freetoken_payload(), lambda payload: payload["local"].update(url="hf://Example/Unsupported"), ValueError, "supported-family"),
            (self.freetoken_payload(), lambda payload: payload["local"]["freetoken"].update(gpuMemoryMi=25 * 1024), ValueError, "physical"),
            (self.freetoken_payload(), lambda payload: payload["local"]["freetoken"].update(systemMemoryMi=50 * 1024), self.api["RequestError"], "currently available RAM"),
        )
        with patch.dict(self.api, self.dashboard_patches()):
            for payload, change, error_type, message in cases:
                with self.subTest(message=message):
                    change(payload)
                    with self.assertRaisesRegex(error_type, message):
                        self.api["model_activation_payload"]("local", payload)

    def test_multi_gpu_configuration_persists_an_aggregate_budget_and_requires_whole_slots(self):
        self.node = nvidia_node(gpu_count=2)
        payload = self.freetoken_payload(gpuCount=2, gpuMemoryMi=32 * 1024)
        with patch.dict(self.api, self.dashboard_patches(gpu_count=2)):
            resource = self.api["model_activation_payload"]("local", payload)

        self.assertEqual(resource["spec"]["local"]["freetoken"]["gpuCount"], 2)
        self.assertEqual(resource["spec"]["local"]["freetoken"]["gpuMemoryMi"], 32 * 1024)

        impossible = self.freetoken_payload(gpuCount=3, gpuMemoryMi=48 * 1024)
        with patch.dict(self.api, self.dashboard_patches(gpu_count=2)):
            with self.assertRaisesRegex(self.api["RequestError"], "only 2 allocatable whole GPU"):
                self.api["model_activation_payload"]("local", impossible)

    def test_multi_gpu_reservation_is_split_across_distinct_cards_on_its_node(self):
        activation = {
            "metadata": {"name": "two-gpu-freetoken"},
            "spec": {"type": "local", "local": {
                "engine": "FreeToken", "computeTarget": "nvidia-gpu",
                "freetoken": {"gpuDevice": "node:nvidia-a", "gpuCount": 2, "gpuMemoryMi": 16 * 1024, "systemMemoryMi": 8 * 1024},
            }},
        }
        devices = [
            {"id": "nvidia-a-0", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-a"], "totalMi": 24 * 1024},
            {"id": "nvidia-a-1", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-a"], "totalMi": 24 * 1024},
        ]
        assigned = self.api["assign_gpu_reservations"](devices, self.api["active_model_memory_reservations"]([activation]))
        self.assertEqual([device["reservedMi"] for device in assigned], [8 * 1024, 8 * 1024])

    def test_model_payload_requires_live_ram_capacity_on_the_selected_gpu_node(self):
        patches = self.dashboard_patches()
        patches["node_memory_samples"] = lambda _nodes: {}
        with patch.dict(self.api, patches):
            with self.assertRaisesRegex(self.api["RequestError"], "current system RAM capacity"):
                self.api["model_activation_payload"]("local", self.freetoken_payload())

    def test_freetoken_reservation_is_charged_only_to_its_selected_node(self):
        activation = {
            "metadata": {"name": "node-a-freetoken"},
            "spec": {"type": "local", "local": {
                "engine": "FreeToken",
                "computeTarget": "nvidia-gpu",
                "freetoken": {"gpuDevice": "node:nvidia-a", "gpuMemoryMi": 16 * 1024, "systemMemoryMi": 8 * 1024},
            }},
        }
        reservations = self.api["active_model_memory_reservations"]([activation])
        reservation = reservations["nvidia-gpu"][0]
        self.assertEqual((reservation["node"], reservation["nodeBinding"]), ("nvidia-a", "bound"))

        devices = [
            {"id": "nvidia-a", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-a"], "totalMi": 24 * 1024},
            {"id": "nvidia-b", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-b"], "totalMi": 48 * 1024},
        ]
        assigned = self.api["assign_gpu_reservations"](devices, reservations)
        by_node = {device["nodes"][0]: device for device in assigned}
        self.assertEqual(by_node["nvidia-a"]["reservedMi"], 16 * 1024)
        self.assertEqual(by_node["nvidia-b"]["reservedMi"], 0)

    def test_freetoken_missing_node_telemetry_never_charges_another_node(self):
        reservations = {
            "nvidia-gpu": [{
                "model": "node-a-freetoken", "reservedMi": 16 * 1024,
                "node": "nvidia-a", "nodeBinding": "bound",
            }],
        }
        devices = [{"id": "nvidia-b", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-b"], "totalMi": 48 * 1024}]
        assigned = self.api["assign_gpu_reservations"](devices, reservations)
        by_node = {device["nodes"][0]: device for device in assigned}
        self.assertEqual(by_node["nvidia-b"]["reservedMi"], 0)
        self.assertEqual(by_node["nvidia-a"]["reservedMi"], 16 * 1024)
        self.assertIn("No capacity is inferred on another node", by_node["nvidia-a"]["warning"])

    def test_unbound_freetoken_and_generic_reservations_keep_visible_target_fallback(self):
        unbound = {
            "metadata": {"name": "legacy-freetoken"},
            "spec": {"type": "local", "local": {
                "engine": "FreeToken", "computeTarget": "nvidia-gpu",
                "freetoken": {"gpuMemoryMi": 16 * 1024},
            }},
        }
        reservations = self.api["active_model_memory_reservations"]([unbound])
        self.assertEqual(reservations["nvidia-gpu"][0]["nodeBinding"], "fallback")

        devices = [
            {"id": "nvidia-a", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-a"], "totalMi": 24 * 1024},
            {"id": "nvidia-b", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-b"], "totalMi": 48 * 1024},
        ]
        assigned = self.api["assign_gpu_reservations"](devices, reservations)
        self.assertEqual(assigned[0]["reservedMi"], 16 * 1024)
        self.assertIn("target-wide placement fallback", assigned[0]["warning"])

        # Generic reservations do not carry a FreeToken node binding. Preserve
        # their established best-fit placement across heterogeneous GPUs.
        generic_devices = [
            {"id": "nvidia-a", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-a"], "totalMi": 24 * 1024},
            {"id": "nvidia-b", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-b"], "totalMi": 48 * 1024},
        ]
        generic = self.api["assign_gpu_reservations"](generic_devices, {
            "nvidia-gpu": [{"model": "legacy-generic", "reservedMi": 32 * 1024}],
        })
        self.assertEqual([device["reservedMi"] for device in generic], [0, 32 * 1024])

    def test_freetoken_estimate_keeps_a_measured_zero_vram_budget_at_zero(self):
        memory = {"devices": [{
            "id": "nvidia-one", "kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["nvidia-one"],
            "totalMi": 24 * 1024, "freeMi": 0, "unreservedMi": 0,
        }]}
        with patch.dict(self.api, {
            "require_compute_target_available": lambda *_args: {},
            "compute_target_availability": lambda: {"freeTokenCapabilities": {"devices": [{"id": "node:nvidia-one", "node": "nvidia-one"}]}},
            "model_activations": lambda: [],
            "compute_memory_summary": lambda _activations: memory,
        }):
            estimate = self.api["estimate_freetoken_memory"]({
                "engine": "FreeToken", "computeTarget": "nvidia-gpu", "freetoken": {"gpuDevice": "node:nvidia-one"},
            })

        self.assertEqual(estimate["maximumMi"], 0)
        self.assertFalse(estimate["gpuAvailable"])

    def test_freetoken_runtime_pod_is_authorized_for_model_logs_without_kubeai_owner(self):
        activation = {
            "metadata": {"name": "qwen-freetoken"},
            "spec": {"type": "local", "targetNamespace": "ai", "local": {"engine": "FreeToken"}},
        }
        freetoken_pod = {
            "metadata": {
                "name": "qwen-freetoken-runtime",
                "namespace": "ai",
                "creationTimestamp": "2026-09-20T10:00:00Z",
                "labels": {
                    "app": "model",
                    "model": "qwen-freetoken",
                    "app.kubernetes.io/managed-by": "magicstick-operator",
                    "appliance.magicstick.dev/modelactivation": "qwen-freetoken",
                    "appliance.magicstick.dev/runtime-backend": "freetoken",
                },
            },
            "spec": {"containers": [{"name": "freetoken"}]},
            "status": {"containerStatuses": [{"name": "freetoken", "ready": True, "state": {"running": {}}}]},
        }
        foreign_pod = {
            "metadata": {"name": "foreign", "labels": {"app": "model", "model": "qwen-freetoken"}},
            "spec": {"containers": [{"name": "freetoken"}]},
            "status": {},
        }
        with patch.dict(self.api, {
            "model_activation": lambda _name: activation,
            "list_resource": lambda _path: [freetoken_pod, foreign_pod],
            "request_text": lambda *_args: "freetoken ready",
        }):
            result = self.api["model_runtime_logs"]("qwen-freetoken", {"tailLines": ["20"]})

        self.assertEqual([item["name"] for item in result["pods"]], ["qwen-freetoken-runtime"])
        self.assertEqual(result["pods"][0]["containers"][0]["logs"][0]["text"], "freetoken ready")
        self.assertFalse(self.api["owned_model_runtime_pod"](foreign_pod, "qwen-freetoken"))


if __name__ == "__main__":
    unittest.main()
