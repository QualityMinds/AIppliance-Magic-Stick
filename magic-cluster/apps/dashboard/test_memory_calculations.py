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
        self.api["compute_target_catalog"] = lambda: {"targets": {}}
        self.api["ready_schedulable_nodes"] = lambda: []
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

    def test_ollama_q8_and_q4_include_block_scales_and_preserve_recurrent_state(self):
        f16 = self.api["estimate_model_memory"]({**self.payload, "kvCacheType": "f16"})
        q8 = self.api["estimate_model_memory"]({**self.payload, "kvCacheType": "q8_0"})
        q4 = self.api["estimate_model_memory"]({**self.payload, "kvCacheType": "q4_0"})
        self.assertEqual((q8["runtimeDetails"]["attentionKvCacheMi"], q4["runtimeDetails"]["attentionKvCacheMi"]), (333, 176))
        self.assertEqual(q8["runtimeDetails"]["recurrentStateMi"], f16["runtimeDetails"]["recurrentStateMi"])
        self.assertEqual(q4["runtimeDetails"]["recurrentStateMi"], f16["runtimeDetails"]["recurrentStateMi"])
        self.assertIn("34 bytes", " ".join(q8["calculations"]["attentionKvCacheMi"]["notes"]))
        self.assertIn("18 bytes", " ".join(q4["calculations"]["attentionKvCacheMi"]["notes"]))
        self.assertGreater(q8["kvCacheSavingsMi"], 0)
        self.assertGreater(q4["kvCacheSavingsMi"], q8["kvCacheSavingsMi"])

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

        q4 = self.api["estimate_model_memory"]({**self.payload, "kvCacheType": "q4_0"})
        self.assertEqual(q4["kvCacheMi"], 256)
        self.assertIn("256 MiB safety floor", " ".join(q4["calculations"]["kvCacheMi"]["notes"]))

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
                self.assertIn("values × 2 bytes", " ".join(calc["theoreticalKvCacheMi"]["notes"]))
                self.assertEqual(result["kvCompatibilityFactor"], 4 if target == "cpu" else 1)
                self.assertIn(f"= {result['hybridAllocatorSafetyMi']:,} MiB", calc["hybridAllocatorSafetyMi"]["substitution"])
                self.assertIn("compileReserveMi" if target == "cpu" else "engineRuntimeReserveMi", calc)

        fp8 = self.api["estimate_model_memory"]({**self.payload, "engine": "VLLM", "computeTarget": "nvidia-gpu",
            "url": "hf://example/model", "kvCacheType": "fp8"})
        self.assertEqual(fp8["kvCacheType"], "fp8")
        self.assertIn("values × 1 byte", " ".join(fp8["calculations"]["theoreticalKvCacheMi"]["notes"]))
        self.assertGreater(fp8["kvCacheSavingsMi"], 0)

    def test_offloading_summaries_explain_gpu_and_host_budgets(self):
        result = self.api["estimate_model_memory"]({**self.payload, "cpuOffloading": True, "vramMi": 10000})
        calc, plan = result["calculations"], result["offloading"]
        for key in ("weightsOnGpuMi", "weightsOnCpuMi", "kvOnCpuMi", "hostRuntimeMi", "ramMinimumMi", "ramRecommendedMi"):
            self.assertIn(f"{plan[key]:,} MiB", calc[key]["substitution"])
        self.assertIn(f"{plan['gpuMinimumMi']:,} MiB", calc["minimumMi"]["substitution"])

    def vllm_group(self, heads=8, layers=32, count=4, strategy="tensor"):
        config = {"num_hidden_layers": layers, "hidden_size": 4096, "num_attention_heads": 32,
                  "num_key_value_heads": heads, "head_dim": 128}
        self.api["hf_metadata"] = lambda _: {"config": config,
            "safetensorsIndex": {"metadata": {"total_size": 100 * 1024 ** 3}}}
        self.api["compute_target_catalog"] = lambda: {"engines": {"VLLM": {"multiGpu": {
            "computeTargets": ["nvidia-gpu"], "maxDevices": 16, "strategies": ["auto", "tensor", "pipeline"]}}}}
        payload = {"engine": "VLLM", "computeTarget": "nvidia-gpu", "url": "hf://example/model",
                   "contextWindow": 131072, "maxNumSeqs": 1, "kvCacheType": "auto",
                   "gpuDevices": [{"uuid": str(i)} for i in range(count)], "vllm": {"parallelism": strategy}}
        base = self.api["estimate_vllm_memory"](payload, "nvidia-gpu")
        return payload, base, self.api["multi_gpu_estimate"](payload, base), config

    def test_tensor_cache_and_runtime_follow_each_shard_not_the_full_model(self):
        _, base, group, _ = self.vllm_group()
        self.assertEqual(base["kvCacheMi"], 16 * 1024)
        self.assertEqual(group["kvCacheMi"], 4 * 1024)
        self.assertEqual(group["weightsMi"], 25 * 1024)
        self.assertEqual(group["runtimeDetails"]["engineRuntimeReserveMi"], 2 * 1024)
        self.assertEqual(group["runtimeDetails"]["partitionReserveMi"], 2560)
        self.assertEqual(sum(group[k] for k in ("weightsMi", "kvCacheMi", "runtimeReserveMi")) * 4, 134 * 1024)
        self.assertEqual(group["confidence"], "estimated")
        self.assertIn("KV heads per rank: 2", group["calculations"]["kvCacheMi"]["notes"][0])

    def test_tensor_gqa_replication_keeps_one_kv_head_per_rank(self):
        _, base, group, _ = self.vllm_group(heads=2)
        self.assertEqual(base["kvCacheMi"], 4 * 1024)
        self.assertEqual(group["kvCacheMi"], 2 * 1024)
        self.assertEqual(group["kvCacheMi"] * 4, 8 * 1024)  # Two heads replicate to four ranks.

    def test_mla_latent_cache_is_replicated_and_unknown_attention_is_not_zero(self):
        config = {"num_hidden_layers": 8, "hidden_size": 4096, "num_attention_heads": 32,
                  "kv_lora_rank": 512, "qk_rope_head_dim": 64, "layer_types": ["sliding_attention"] * 8}
        one = self.api["vllm_device_cache"](config, 8192, 1, "auto", 1)
        four = self.api["vllm_device_cache"](config, 8192, 1, "auto", 4)
        self.assertEqual(one["attentionKvCacheMi"], 72)
        self.assertEqual(four["attentionKvCacheMi"], one["attentionKvCacheMi"])
        self.assertEqual(four["kvHeadsPerGpu"], 1)

    def test_moe_without_checkpoint_metadata_does_not_use_dense_weight_guess(self):
        self.assertIsNone(self.api["estimated_parameter_count"]({
            "num_experts": 512, "num_hidden_layers": 48, "hidden_size": 2560,
            "num_attention_heads": 24, "intermediate_size": 640,
        }))

    def test_pipeline_cache_uses_local_layers_and_retains_largest_stage_budget(self):
        _, base, group, _ = self.vllm_group(layers=9, count=2, strategy="pipeline")
        self.assertEqual(group["gpuParallelism"], "pipeline")
        self.assertLess(group["kvCacheMi"], base["kvCacheMi"])
        self.assertEqual(group["runtimeDetails"]["fullAttentionLayers"], 5)
        self.assertIn("largest rank", group["calculations"]["kvCacheMi"]["formula"])

    def test_hybrid_cache_adds_state_and_side_caches_without_context_scaling_state(self):
        config = {"num_hidden_layers": 4, "hidden_size": 2560, "num_attention_heads": 24,
                  "num_key_value_heads": 2, "head_dim": 256, "layer_types": ["linear_attention"] * 3 + ["full_attention"],
                  "linear_conv_kernel_dim": 4, "linear_num_key_heads": 16, "linear_key_head_dim": 128,
                  "linear_num_value_heads": 48, "linear_value_head_dim": 128,
                  "indexer_compress_ratio": 4, "indexer_head_dim": 128, "indexer_kv_heads": 1}
        first = self.api["vllm_device_cache"](config, 65536, 1, "fp8", 4)
        second = self.api["vllm_device_cache"](config, 131072, 1, "fp8", 4)
        self.assertEqual(first["recurrentStateMi"], second["recurrentStateMi"])
        self.assertEqual(first["auxiliaryCacheMi"] * 2, second["auxiliaryCacheMi"])
        self.assertEqual(first["totalMi"], sum(first[k] for k in ("attentionKvCacheMi", "recurrentStateMi", "auxiliaryCacheMi")))
        self.assertTrue(first["recurrentStateKnown"])

    def test_ollama_cache_is_layer_distributed_and_uses_one_host_runner(self):
        base = self.api["estimate_ollama_memory"](self.payload, "nvidia-gpu")
        payload = {**self.payload, "gpuDevices": [{"uuid": str(i)} for i in range(4)]}
        self.api["compute_target_catalog"] = lambda: {"engines": {"OLlama": {"multiGpu": {
            "computeTargets": ["nvidia-gpu"], "maxDevices": 16}}}}
        group = self.api["multi_gpu_estimate"](payload, base)
        self.assertLess(group["kvCacheMi"], base["kvCacheMi"])
        self.assertEqual(group["kvCacheMi"], group["runtimeDetails"]["attentionKvCacheMi"] + group["runtimeDetails"]["recurrentStateMi"])
        plan = self.api["model_system_memory_plan"](payload, group, {"contextWindow": 10000}, 100000)
        self.assertEqual(plan["workerCount"], 1)
        self.assertEqual(plan["hostRuntimeMi"], 4096 + 3 * 256)

    def test_gpu_host_ram_separates_serving_transfer_and_reclaimable_file_cache(self):
        result = self.api["estimate_model_memory"](self.payload)
        plan = result["systemMemory"]
        self.assertEqual(plan["scope"], "per-pod")
        self.assertGreater(plan["startupMinimumMi"], plan["runningMinimumMi"])
        self.assertGreater(plan["startupUpperMi"], plan["startupMinimumMi"])
        self.assertGreater(plan["recommendedMi"], plan["startupUpperMi"])
        self.assertEqual(plan["maximumMi"], 32000)
        self.assertIn("reclaimable", " ".join(plan["warnings"]))

    def test_host_startup_lower_bound_uses_shards_per_worker_not_full_checkpoint(self):
        payload, base, group, _ = self.vllm_group()
        group["_largestWeightFileMi"] = 3 * 1024
        plan = self.api["model_system_memory_plan"](payload, group, {"contextWindow": 131072}, 250000)
        self.assertEqual(plan["workerCount"], 4)
        self.assertEqual(plan["loadingBuffersMi"], 12 * 1024)
        self.assertGreater(plan["fileCacheUpperMi"], plan["loadingBuffersMi"])
        self.assertGreater(plan["startupUpperMi"], plan["startupMinimumMi"])

    def test_replica_ram_is_per_copy_and_total_is_not_worker_multiplied_twice(self):
        base = self.api["estimate_ollama_memory"](self.payload, "nvidia-gpu")
        payload = {**self.payload, "gpuDeployment": "replicated", "gpuDevices": [{"uuid": str(i)} for i in range(4)]}
        plan = self.api["model_system_memory_plan"](payload, base, {"replicaCount": 4, "contextWindow": 10000}, 32000)
        self.assertEqual((plan["scope"], plan["workerCount"], plan["replicaCount"]), ("per-copy", 1, 4))
        self.assertEqual(plan["totalRecommendedMi"], plan["recommendedMi"] * 4)

    def test_unknown_metadata_and_other_gpu_nodes_cannot_invent_ram_capacity(self):
        plan = self.api["model_system_memory_plan"](self.payload, {"weightsMi": 0, "confidence": "fallback"}, {}, None)
        self.assertIsNone(plan["minimumMi"])
        self.assertIsNone(plan["recommendedMi"])
        self.assertEqual(plan["confidence"], "unknown")
        amd = self.api["estimate_model_memory"]({**self.payload, "computeTarget": "amd-gpu"})
        self.assertIsNone(amd["systemMemory"]["maximumMi"])  # NVIDIA budget is not AMD host evidence.

    def test_special_lookup_table_detection_never_invents_active_offloading(self):
        payload, base, group, config = self.vllm_group()
        group["_dimensions"] = {**config, "ngram_vocab_size_base": 20000000, "ple_embed_dim": 2560}
        plan = self.api["model_system_memory_plan"](payload, group, {}, 250000)
        self.assertEqual(plan["largeLookupParameters"], 51200000000)
        self.assertEqual(plan["weightsOnCpuMi"], 0)
        self.assertTrue(any("generic CPU offloading is not proof" in warning for warning in plan["warnings"]))


if __name__ == "__main__":
    unittest.main()
