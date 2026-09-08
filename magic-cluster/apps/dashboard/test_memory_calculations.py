import unittest

from test_dashboard_api import load_server


class MemoryCalculationTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.gguf = {"general.architecture": "qwen35", **{"qwen35." + key: value for key, value in {
            "block_count": 65, "nextn_predict_layers": 1, "embedding_length": 5120,
            "context_length": 262144, "attention.head_count": 24, "attention.head_count_kv": 4,
            "attention.key_length": 256, "attention.value_length": 256, "full_attention_interval": 4,
            "ssm.conv_kernel": 4, "ssm.inner_size": 6144, "ssm.state_size": 128, "ssm.group_count": 16,
        }.items()}}
        self.api["ollama_metadata"] = lambda _: {"modelBytes": 17741860480, "ggufMetadata": self.gguf}
        self.api["model_activations"] = lambda: []
        self.api["vram_summary"] = lambda _: {"available": True, "plannedRemainingMi": 24000}
        self.api["offloading_host_memory_available"] = lambda _: 32000
        self.payload = {"url": "ollama://example:latest", "engine": "OLlama", "computeTarget": "nvidia-gpu", "contextWindow": 10000, "maxNumSeqs": 1}

    def test_attention_formula_uses_actual_dimensions_and_binary_units(self):
        result = self.api["estimate_model_memory"](self.payload)
        self.assertEqual(result["runtimeDetails"]["attentionKvCacheMi"], 625)
        calc = result["calculations"]["attentionKvCacheMi"]
        self.assertIn("16 × 4 × (256 + 256)", calc["substitution"])
        self.assertIn("× 10,000 × 1", calc["substitution"])
        self.assertIn("= 625 MiB", calc["substitution"])
        self.assertIn("65,536 bytes (64 KiB) per token per sequence", " ".join(calc["notes"]))
        self.assertIn("Weight quantization does not set KV precision", " ".join(calc["notes"]))

    def test_context_and_sequences_update_formulas_without_scaling_recurrent_context(self):
        cache = self.api["ollama_gguf_cache_estimate"]
        first, second, parallel = cache(self.gguf, 10000, 1), cache(self.gguf, 20000, 1), cache(self.gguf, 10000, 2)
        self.assertEqual((first["attentionKvCacheMi"], second["attentionKvCacheMi"], parallel["attentionKvCacheMi"]), (625, 1250, 1250))
        self.assertEqual((first["recurrentStateMi"], second["recurrentStateMi"]), (150, 150))
        self.assertEqual(parallel["recurrentStateMi"], 300)
        self.assertIn("× 20,000 × 1", second["calculations"]["attentionKvCacheMi"]["substitution"])
        self.assertIn("48 × [(4 − 1)", first["calculations"]["recurrentStateMi"]["substitution"])
        self.assertEqual(first["calculations"]["recurrentStateMi"], second["calculations"]["recurrentStateMi"])

    def test_heterogeneous_layer_groups_are_not_explained_as_uniform(self):
        metadata = {"general.architecture": "example", "example.block_count": 2, "example.embedding_length": 64,
                    "example.attention.head_count": [4, 8], "example.attention.head_count_kv": [2, 4],
                    "example.attention.key_length": [16, 8], "example.attention.value_length": [16, 12]}
        calc = self.api["ollama_gguf_cache_estimate"](metadata, 4096, 1)["calculations"]["attentionKvCacheMi"]
        self.assertIn("1 × 2 × (16 + 16) + 1 × 4 × (8 + 12)", calc["substitution"])
        self.assertIn("288 bytes", " ".join(calc["notes"]))

    def test_fallback_is_explicit_not_a_fictitious_architecture_formula(self):
        self.api["ollama_metadata"] = lambda _: {"modelBytes": 1024 * 1048576}
        result = self.api["estimate_model_memory"](self.payload)
        calc = result["calculations"]["kvCacheMi"]
        self.assertIn("max(1, context tokens ÷ 4,096)", calc["formula"])
        self.assertIn("Fallback heuristic only", " ".join(calc["notes"]))
        self.assertNotIn("attentionKvCacheMi", result["calculations"])

    def test_all_ollama_targets_explain_reserves_totals_and_download(self):
        for target in ("cpu", "nvidia-gpu", "amd-gpu"):
            with self.subTest(target=target):
                result = self.api["estimate_model_memory"]({**self.payload, "computeTarget": target})
                calc = result["calculations"]
                for key in ("weightsMi", "minimumMi", "recommendedMi", "recommendedReserveMi"):
                    self.assertIn(f"{result[key]:,} MiB", calc[key]["substitution"])
                self.assertIn(f"= {result['reserveMi']:,} MiB", calc["engineRuntimeReserveMi"]["substitution"])
                self.assertIn("17,741,860,480", calc["downloadBytes"]["substitution"])

    def test_all_vllm_targets_and_cpu_hybrid_safety(self):
        self.api["hf_metadata"] = lambda _: {"config": {"num_hidden_layers": 32, "hidden_size": 4096,
            "num_attention_heads": 16, "num_key_value_heads": 4, "head_dim": 256,
            "layer_types": ["full_attention"] * 8 + ["linear_attention"] * 24, "kv_cache_dtype": "fp8"},
            "safetensorsIndex": {"metadata": {"total_size": 4096 * 1048576}}}
        for target in ("cpu", "nvidia-gpu", "amd-gpu", "intel-gpu"):
            with self.subTest(target=target):
                result = self.api["estimate_model_memory"]({**self.payload, "engine": "VLLM", "computeTarget": target, "url": "hf://example/model"})
                calc = result["calculations"]
                self.assertIn("8 × 4 × (256 + 256)", calc["theoreticalKvCacheMi"]["substitution"])
                self.assertIn("FP8", " ".join(calc["theoreticalKvCacheMi"]["notes"]))
                self.assertEqual(result["kvCompatibilityFactor"], 4 if target == "cpu" else 1)
                self.assertIn(f"= {result['hybridAllocatorSafetyMi']:,} MiB", calc["hybridAllocatorSafetyMi"]["substitution"])
                self.assertIn("compileReserveMi" if target == "cpu" else "engineRuntimeReserveMi", calc)

    def test_offloading_summaries_explain_gpu_and_host_budgets(self):
        result = self.api["estimate_model_memory"]({**self.payload, "cpuOffloading": True, "vramMi": 10000})
        calc, plan = result["calculations"], result["offloading"]
        for key in ("weightsOnGpuMi", "weightsOnCpuMi", "kvOnCpuMi", "hostRuntimeMi", "ramMinimumMi", "ramRecommendedMi"):
            self.assertIn(f"{plan[key]:,} MiB", calc[key]["substitution"])
        self.assertIn(f"{plan['gpuMinimumMi']:,} MiB", calc["minimumMi"]["substitution"])


if __name__ == "__main__":
    unittest.main()
