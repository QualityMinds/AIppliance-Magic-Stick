import ast
import json
import unittest
from unittest.mock import patch

import yaml

from test_controller import CLUSTER_ROOT, ROOT, load_controller


class VllmDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = load_controller()
        cls.catalog = json.loads(yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        cls.definition = cls.catalog["engines"]["VLLM"]["deploymentSettings"]["visionAttention"]

    def resource(self, local):
        with patch.dict(self.c, {
            "cluster_architectures": lambda: {"amd64"},
            "resolve_compute_target_profile": lambda _definition, _engine: "example-profile:1",
        }):
            return self.c["kubeai_model_resource"]({"metadata": {"name": "example-model"}, "spec": {"local": {
                "engine": "VLLM", "computeTarget": "amd-gpu", "url": "hf://example/vision-model",
                "vramMi": 16384, "contextWindow": 4096, "maxNumSeqs": 1, "kvCacheType": "fp8", **local,
            }}}, {}, self.catalog)

    def test_each_manual_choice_maps_to_documented_vision_argument_and_environment(self):
        for choice, backend, env in (
            ("aotriton", "TORCH_SDPA", {"TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL": "1"}),
            ("triton", "TRITON_ATTN", {}),
            ("flash-attn-triton", "FLASH_ATTN", {"FLASH_ATTENTION_TRITON_AMD_ENABLE": "TRUE"}),
        ):
            with self.subTest(choice=choice):
                resource, runtime = self.resource({"vllm": {"visionAttention": choice}, "env": {"PRESERVE_ME": "true"},
                                                   "args": ["--attention-backend=ROCM_ATTN", "--trust-remote-code"]})
                self.assertIn("--mm-encoder-attn-backend=" + backend, resource["spec"]["args"])
                self.assertIn("--attention-backend=ROCM_ATTN", resource["spec"]["args"])
                self.assertIn("--kv-cache-dtype=fp8", resource["spec"]["args"])
                self.assertIn("--max-model-len=4096", resource["spec"]["args"])
                self.assertEqual(resource["metadata"]["annotations"]["appliance.magicstick.dev/vllm-vision-attention"], choice)
                self.assertEqual(resource["spec"]["env"]["PRESERVE_ME"], "true")
                for key in ("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "FLASH_ATTENTION_TRITON_AMD_ENABLE"):
                    self.assertEqual(resource["spec"]["env"].get(key), env.get(key))
                self.assertEqual(runtime["vramMi"], 16384)
                self.assertEqual(runtime["cpuResources"], {"requestMillicores": 1000, "limitMillicores": 0})

    def test_auto_removes_vision_overrides_but_not_decoder_or_kv_configuration(self):
        args = ["--mm-encoder-attn-backend", "TORCH_SDPA", "--mm-encoder-attn-backend=FLASH_ATTN",
                "--mm_encoder_attn_backend", "TRITON_ATTN", "--mm_encoder_attn_backend=FLASH_ATTN",
                "--attention-backend=ROCM_ATTN", "--trust-remote-code"]
        env = {"TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL": "1", "FLASH_ATTENTION_TRITON_AMD_ENABLE": "TRUE",
               "VLLM_ATTENTION_BACKEND": "ROCM_ATTN", "PRESERVE_ME": "true"}
        resource, _ = self.resource({"args": args, "env": env, "vllm": {"visionAttention": "auto"}})
        self.assertFalse(any("mm-encoder-attn-backend" in arg.replace("_", "-") for arg in resource["spec"]["args"]))
        self.assertIn("--attention-backend=ROCM_ATTN", resource["spec"]["args"])
        self.assertEqual(resource["spec"]["env"]["VLLM_ATTENTION_BACKEND"], "ROCM_ATTN")
        self.assertNotIn("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", resource["spec"]["env"])
        self.assertNotIn("FLASH_ATTENTION_TRITON_AMD_ENABLE", resource["spec"]["env"])
        self.assertIn("--kv-cache-dtype=fp8", resource["spec"]["args"])
        self.assertEqual(len(args), 8)
        self.assertEqual(len(env), 4)

    def test_changing_manual_choice_replaces_conflicts_without_duplicates(self):
        resource, _ = self.resource({"vllm": {"visionAttention": "triton"},
                                    "args": ["--mm-encoder-attn-backend=FLASH_ATTN"],
                                    "env": {"TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL": "1", "FLASH_ATTENTION_TRITON_AMD_ENABLE": "TRUE"}})
        self.assertEqual([arg for arg in resource["spec"]["args"] if arg.startswith("--mm-encoder")], ["--mm-encoder-attn-backend=TRITON_ATTN"])
        self.assertNotIn("FLASH_ATTENTION_TRITON_AMD_ENABLE", resource["spec"]["env"])
        self.assertNotIn("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", resource["spec"]["env"])

    def test_incomplete_legacy_override_cannot_swallow_managed_context_limits(self):
        resource, _ = self.resource({"vllm": {"visionAttention": "auto"}, "args": ["--mm-encoder-attn-backend"]})
        self.assertIn("--max-model-len=4096", resource["spec"]["args"])
        self.assertIn("--max-num-seqs=1", resource["spec"]["args"])
        self.assertNotIn("--mm-encoder-attn-backend", resource["spec"]["args"])

    def test_absent_configuration_preserves_existing_vllm_models(self):
        for target in ("amd-gpu", "nvidia-gpu", "intel-gpu", "cpu"):
            with self.subTest(target=target):
                local = {"computeTarget": target, "kvCacheType": "auto", "args": ["--mm-encoder-attn-backend=TORCH_SDPA"],
                         "env": {"TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL": "1"}}
                if target == "cpu":
                    local.update(vramMi=0, memoryRequiredMi=8192)
                resource, _ = self.resource(local)
                self.assertIn("--mm-encoder-attn-backend=TORCH_SDPA", resource["spec"]["args"])
                self.assertEqual(resource["spec"]["env"]["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"], "1")
                self.assertNotIn("appliance.magicstick.dev/vllm-vision-attention", resource["metadata"]["annotations"])

    def test_invalid_target_or_engine_cannot_use_typed_vllm_options(self):
        for engine, target in (("VLLM", "nvidia-gpu"), ("VLLM", "cpu"), ("VLLM", "intel-gpu"), ("OLlama", "amd-gpu")):
            with self.subTest(engine=engine, target=target), self.assertRaises(ValueError):
                self.resource({"engine": engine, "computeTarget": target, "vllm": {"visionAttention": "triton"}})
        with self.assertRaisesRegex(ValueError, "only for vLLM"):
            self.c["freetoken_runtime_resources"]({"metadata": {"name": "example"}, "spec": {"local": {
                "engine": "FreeToken", "computeTarget": "nvidia-gpu", "url": "hf://example/model",
                "vllm": {"visionAttention": "triton"}}}}, {}, self.catalog)

    def test_ollama_is_unchanged(self):
        resource, _ = self.resource({"engine": "OLlama", "url": "ollama://example:latest", "kvCacheType": "q8_0"})
        self.assertEqual(resource["spec"]["args"], [])
        self.assertEqual(resource["spec"]["env"]["OLLAMA_KV_CACHE_TYPE"], "q8_0")
        self.assertNotIn("FLASH_ATTENTION_TRITON_AMD_ENABLE", resource["spec"]["env"])

    def test_catalog_and_crd_agree_and_triton_is_the_default(self):
        crd = yaml.safe_load((ROOT / "crds/modelactivations.appliance.magicstick.dev.yaml").read_text())
        schema = crd["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["local"]["properties"]["vllm"]["properties"]["visionAttention"]
        self.assertEqual(set(schema["enum"]), {item["value"] for item in self.definition["options"]})
        self.assertEqual(schema["default"], self.definition["default"])
        self.assertEqual(schema["default"], "triton")
        self.assertEqual(self.definition["computeTargets"], ["amd-gpu"])

    def test_api_and_controller_share_the_validation_contract(self):
        api_source = yaml.safe_load((CLUSTER_ROOT / "apps/dashboard/dashboard-api.yaml").read_text())["data"]["server.py"]
        controller_source = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text())["data"]["controller.py"]
        def function(source):
            return next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "model_vllm_configuration")
        self.assertEqual(ast.dump(function(api_source)), ast.dump(function(controller_source)))


if __name__ == "__main__":
    unittest.main()
