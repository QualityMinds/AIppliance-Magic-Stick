import json
import pathlib
import unittest
from unittest.mock import patch

import yaml
from test_controller import load_controller


class OffloadingRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()
        self.activation = {"metadata": {"name": "hybrid"}, "spec": {"type": "local", "local": {
            "engine": "VLLM", "computeTarget": "nvidia-gpu", "url": "hf://example/model",
            "vram": "12000Mi", "memoryRequiredMi": 16000, "cpuOffloading": True, "cpuOffloadMi": 8000,
        }}}

    def test_vllm_profile_has_one_gpu_and_separate_host_ram(self):
        resource, runtime = self.c["kubeai_model_resource"](self.activation, {})
        self.assertEqual(resource["spec"]["resourceProfile"], "magicstick-nvidia-gpu-ram-16000:1")
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_CPU_OFFLOAD_MI"], "8000")
        self.assertEqual(runtime["memoryMi"], 16000)
        root = pathlib.Path(__file__).resolve().parents[2]
        release = yaml.safe_load((root / "ai/kubeai/base/helmrelease.yaml").read_text())
        applied = []
        with patch.dict(self.c, {"get_resource": lambda *_: release, "get_core_resource": lambda *_: {"metadata": {"name": "magicstick-offloading-profiles"}},
                                "apply_resource": lambda value: applied.append(value)}):
            self.c["ensure_offloading_profile"](runtime["baseResourceProfile"], runtime["memoryMi"])
        profile = json.loads(applied[0]["data"]["values.json"])["resourceProfiles"]["magicstick-nvidia-gpu-ram-16000"]
        self.assertEqual(profile["requests"]["nvidia.com/gpu"], "1")
        self.assertEqual(profile["requests"]["memory"], "16000Mi")
        self.assertEqual(profile["limits"]["memory"], "16000Mi")
        self.assertEqual(profile["requests"]["cpu"], "6")

    def test_ollama_layer_settings_reach_startup_probe_and_serving_runtime(self):
        self.activation["spec"]["local"].update(engine="OLlama", url="ollama://example:latest", cpuOffloadMi=0, ollamaGpuLayers=12)
        resource, _ = self.c["kubeai_model_resource"](self.activation, {})
        self.assertEqual(resource["spec"]["env"]["LLAMA_ARG_N_GPU_LAYERS"], "12")
        self.assertEqual(resource["spec"]["env"]["LLAMA_ARG_FIT"], "off")
        self.assertNotIn("MAGICSTICK_CPU_OFFLOAD_MI", resource["spec"]["env"])

    def test_partial_rollout_does_not_silently_publish_an_unloadable_profile(self):
        with patch.dict(self.c, {"get_resource": lambda *_: {"spec": {"values": {}}}}):
            with self.assertRaisesRegex(ValueError, "Update the KubeAI HelmRelease"):
                self.c["ensure_offloading_profile"]("magicstick-nvidia-gpu:1", 16000)

    def test_disabled_is_explicit_but_legacy_env_is_unchanged(self):
        local = self.activation["spec"]["local"]
        local.update(engine="OLlama", url="ollama://example:latest", cpuOffloading=False)
        resource, _ = self.c["kubeai_model_resource"](self.activation, {})
        self.assertEqual(resource["spec"]["env"]["LLAMA_ARG_N_GPU_LAYERS"], "999")
        local.pop("cpuOffloading")
        resource, _ = self.c["kubeai_model_resource"](self.activation, {})
        self.assertNotIn("LLAMA_ARG_N_GPU_LAYERS", resource["spec"]["env"])

    def test_raw_intent_cannot_omit_host_ram_or_request_multiple_replicas(self):
        for changes in ({"memoryRequiredMi": 100}, {"maxReplicas": 2}, {"minReplicas": 2}, {"cpuOffloadMi": -10}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.c["offloading_runtime"]({**self.activation["spec"]["local"], **changes}, "VLLM", "nvidia-gpu")

    def test_explicit_risk_acceptance_reaches_runtime_without_increasing_reservation(self):
        self.activation["spec"]["local"].update(memoryRequiredMi=100, allowMemoryRisk=True)
        resource, runtime = self.c["kubeai_model_resource"](self.activation, {})
        self.assertEqual(runtime["memoryMi"], 100)
        self.assertEqual(resource["spec"]["resourceProfile"], "magicstick-nvidia-gpu-ram-100:1")
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_CPU_OFFLOAD_MI"], "8000")

    def test_risk_acceptance_does_not_bypass_types_positive_budgets_or_replica_rules(self):
        for changes in ({"memoryRequiredMi": 0}, {"allowMemoryRisk": "true"}, {"maxReplicas": 2}, {"cpuOffloadMi": -1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.c["offloading_runtime"]({**self.activation["spec"]["local"], "allowMemoryRisk": True, **changes}, "VLLM", "nvidia-gpu")

    def test_usage_is_engine_reported_and_missing_is_not_zero(self):
        with patch.dict(self.c, {"model_pod_endpoints": lambda *_: ["http://example.local"],
            "ollama_request_json": lambda *_: {"models": [{"name": "hybrid:latest", "size": 20 * 1048576, "size_vram": 12 * 1048576}]} }):
            usage = self.c["ollama_memory_usage"]("ai", "hybrid")
            self.assertEqual((usage["ramMi"], usage["vramMi"]), (8, 12))
            self.assertEqual(usage["source"], "ollama-api-ps")
        with patch.dict(self.c, {"model_pod_endpoints": lambda *_: []}):
            self.assertIsNone(self.c["ollama_memory_usage"]("ai", "hybrid"))


if __name__ == "__main__":
    unittest.main()
