import unittest
from unittest.mock import patch

from test_dashboard_api import load_server


class CpuOffloadingTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.base = {"repo": "example/model", "weightsMi": 20000, "kvCacheMi": 2000,
                     "runtimeReserveMi": 2000, "modelLayers": 40, "confidence": "estimated",
                     "contextWindow": 4096, "maxNumSeqs": 1, "downloadBytes": 22000000000}
        self.api.update({
            "estimate_vllm_memory": lambda *_: dict(self.base),
            "estimate_ollama_memory": lambda *_: dict(self.base),
            "model_activations": lambda: [],
            "vram_summary": lambda _: {"available": True, "plannedRemainingMi": 24000},
            "offloading_host_memory_available": lambda _: 32000,
            "compute_target_catalog": lambda: {"targets": {"nvidia-gpu": {"kind": "gpu"}}},
            "resolve_local_preset_artifact": lambda _: None,
        })
        self.payload = {"engine": "VLLM", "computeTarget": "nvidia-gpu", "url": "hf://example/model",
                        "cpuOffloading": True, "vramMi": 16000, "memoryRequiredMi": 20000}

    def test_vllm_separates_weights_kv_runtime_and_download(self):
        result = self.api["estimate_model_memory"](self.payload)
        plan = result["offloading"]
        self.assertEqual(plan["weightsOnCpuMi"] + plan["weightsOnGpuMi"], 20000)
        self.assertEqual(plan["kvOnGpuMi"], 2000)
        self.assertEqual(plan["kvOnCpuMi"], 0)
        self.assertEqual(plan["cpuOffloadMi"], plan["weightsOnCpuMi"])
        self.assertGreater(plan["ramMinimumMi"], plan["cpuOffloadMi"])
        self.assertEqual(plan["ramRecommendedMi"] % 100, 0)
        self.assertLessEqual(result["recommendedMi"], 16000)
        self.assertEqual(result["downloadBytes"], self.base["downloadBytes"])

    def test_ollama_is_layer_estimate_with_conservative_host_cache(self):
        result = self.api["estimate_model_memory"]({**self.payload, "engine": "OLlama", "url": "ollama://example:latest"})
        plan = result["offloading"]
        self.assertEqual(plan["mode"], "layers")
        self.assertGreater(plan["gpuLayers"], 0)
        self.assertLess(plan["gpuLayers"], 41)
        self.assertEqual(plan["kvOnCpuMi"], 2000)
        self.assertTrue(plan["estimated"])
        self.assertIn("byte-exact", " ".join(result["warnings"]))

    def test_offloading_cannot_move_oversized_gpu_cache(self):
        self.base["kvCacheMi"] = 30000
        plan = self.api["estimate_model_memory"](self.payload)["offloading"]
        self.assertFalse(plan["fitsVram"])
        with self.assertRaisesRegex(ValueError, "VRAM budget"):
            self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, "memoryRequiredMi": 30000}})

    def test_creation_derives_runtime_controls_and_keeps_ram_request(self):
        result = self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, "cpuOffloadMi": 1}})
        local = result["spec"]["local"]
        self.assertEqual(local["memoryRequiredMi"], 20000)
        self.assertGreater(local["cpuOffloadMi"], 1)
        self.assertTrue(local["cpuOffloading"])

    def test_creation_rejects_small_or_unknown_host_budget(self):
        with self.assertRaisesRegex(ValueError, "RAM reservation must"):
            self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, "memoryRequiredMi": 100}})
        self.api["offloading_host_memory_available"] = lambda _: None
        with self.assertRaisesRegex(ValueError, "verifiable"):
            self.api["model_activation_payload"]("local", {"name": "test", "local": self.payload})

    def test_creation_requires_known_vram_capacity_and_one_replica(self):
        for changes in ({"minReplicas": 2}, {"maxReplicas": 2}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "one model replica"):
                self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, **changes}})
        self.api["vram_summary"] = lambda _: {"available": False}
        with self.assertRaisesRegex(ValueError, "verifiable unreserved GPU"):
            self.api["model_activation_payload"]("local", {"name": "test", "local": self.payload})

    def test_legacy_and_explicit_disabled_models_have_no_added_host_request(self):
        for flag in ({}, {"cpuOffloading": False}):
            local = {**self.payload, **flag}
            if not flag:
                local.pop("cpuOffloading")
            result = self.api["model_activation_payload"]("local", {"name": "test", "local": local})
            self.assertNotIn("memoryRequiredMi", result["spec"]["local"])
            self.assertNotIn("cpuOffloadMi", result["spec"]["local"])

    def test_unsupported_targets_and_invalid_types_are_rejected(self):
        for target in ("cpu", "amd-gpu", "intel-gpu"):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, "NVIDIA"):
                self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, "computeTarget": target}})
        with self.assertRaisesRegex(ValueError, "boolean"):
            self.api["model_activation_payload"]("local", {"name": "test", "local": {**self.payload, "cpuOffloading": "true"}})

    def test_gpu_host_reservation_is_also_charged_to_ram(self):
        reservations = self.api["active_model_memory_reservations"]([{
            "metadata": {"name": "hybrid"}, "spec": {"type": "local", "local": self.payload},
        }])
        self.assertEqual(reservations["cpu"][0]["reservedMi"], 20000)
        self.assertEqual(reservations["nvidia-gpu"][0]["reservedMi"], 16000)

    def test_host_budget_is_per_gpu_node_and_counts_other_workloads(self):
        api = load_server()
        nodes = [{"metadata": {"name": name}, "status": {"allocatable": {"memory": "32Gi", "nvidia.com/gpu": "2"}}} for name in ("node-a", "node-b")]
        pods = [{"spec": {"nodeName": name, "containers": [{"resources": {"requests": {"memory": "8Gi"}}}]} } for name in ("node-a", "node-b")]
        with patch.dict(api, {"ready_schedulable_nodes": lambda: nodes, "list_resource": lambda _: pods}):
            self.assertEqual(api["offloading_host_memory_available"]("nvidia-gpu"), 24 * 1024)

    def test_host_budget_counts_native_sidecars_overhead_and_pending_requests(self):
        api = load_server()
        nodes = [{"metadata": {"name": "node-a"}, "status": {"allocatable": {"memory": "32Gi", "nvidia.com/gpu": "1"}}}]
        def request(memory, **extra):
            return {"resources": {"requests": {"memory": memory}}, **extra}
        pods = [{"spec": {"nodeName": "node-a", "containers": [request("8Gi")],
                 "initContainers": [request("2Gi", restartPolicy="Always"), request("12Gi"), request("1Gi", restartPolicy="Always")],
                 "overhead": {"memory": "1Gi"}}},
                {"spec": {"containers": [request("4Gi")]}}]
        with patch.dict(api, {"ready_schedulable_nodes": lambda: nodes, "list_resource": lambda _: pods}):
            self.assertEqual(api["offloading_host_memory_available"]("nvidia-gpu"), (32 - 14 - 1 - 4) * 1024)


if __name__ == "__main__":
    unittest.main()
