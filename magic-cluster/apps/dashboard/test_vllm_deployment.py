import copy
import json
import unittest
from unittest.mock import patch

import yaml

from test_dashboard_api import ROOT, load_server


class VllmDeploymentApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()
        path = ROOT.parents[1] / "platform/magicstick-operator/compute-target-catalog.yaml"
        cls.catalog = json.loads(yaml.safe_load(path.read_text())["data"]["targets.json"])

    def local(self, choice="auto"):
        return {"url": "hf://example/vision-model", "engine": "VLLM", "computeTarget": "amd-gpu",
                "vramMi": 16384, "contextWindow": 4096, "maxNumSeqs": 1,
                "vllm": {"visionAttention": choice}}

    def test_create_persists_each_catalog_choice(self):
        options = self.catalog["engines"]["VLLM"]["deploymentSettings"]["visionAttention"]["options"]
        with patch.dict(self.api, {"compute_target_catalog": lambda: self.catalog}):
            for option in options:
                with self.subTest(choice=option["value"]):
                    result = self.api["model_activation_payload"]("local", {"name": "example", "local": self.local(option["value"])})
                    self.assertEqual(result["spec"]["local"]["vllm"], {"visionAttention": option["value"]})
                    self.assertEqual(result["spec"]["local"]["contextWindow"], 4096)

    def test_validation_is_engine_and_target_specific_and_fail_closed(self):
        resolve = self.api["model_vllm_configuration"]
        for raw in (None, [], False, "triton", {"visionAttention": "unknown"},
                    {"visionAttention": True}, {"visionAttention": []}, {"args": ["--unsafe"]}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                resolve({"vllm": raw}, "VLLM", "amd-gpu", self.catalog)
        for engine, target in (("OLlama", "amd-gpu"), ("FreeToken", "nvidia-gpu"),
                               ("VLLM", "cpu"), ("VLLM", "nvidia-gpu"), ("VLLM", "intel-gpu")):
            with self.subTest(engine=engine, target=target), self.assertRaises(ValueError):
                resolve(self.local(), engine, target, self.catalog)
        with self.assertRaisesRegex(ValueError, "runtime catalog"):
            resolve(self.local("triton"), "VLLM", "amd-gpu", {})
        self.assertEqual(resolve({"vllm": {}}, "VLLM", "amd-gpu", self.catalog), {"visionAttention": "triton"})

    def test_legacy_creation_does_not_add_a_deployment_override(self):
        with patch.dict(self.api, {"compute_target_catalog": lambda: self.catalog}):
            for engine, target, url in (("VLLM", "amd-gpu", "hf://example/model"),
                                       ("VLLM", "nvidia-gpu", "hf://example/model"),
                                       ("OLlama", "amd-gpu", "ollama://example:latest")):
                result = self.api["model_activation_payload"]("local", {"name": "example", "local": {
                    "engine": engine, "computeTarget": target, "url": url, "vramMi": 16384}})
                self.assertNotIn("vllm", result["spec"]["local"])

    def test_edit_preserves_configuration_and_explicit_auto_resets_the_choice(self):
        current = {"metadata": {"name": "example", "resourceVersion": "17"},
                   "spec": {"type": "local", "enabled": True, "targetNamespace": "ai", "local": self.local("aotriton")}}
        current["spec"]["local"]["env"] = {"EXAMPLE_SETTING": "preserved"}
        calls = []
        with patch.dict(self.api, {
            "compute_target_catalog": lambda: self.catalog,
            "model_activation": lambda _: copy.deepcopy(current),
            "require_gpu_slot_available": lambda _: None,
            "request_json": lambda _method, _path, body, *_args: calls.append(body) or body,
        }):
            result = self.api["update_model_activation"]("example", {"expectedRevision": "17", "local": {"maxNumSeqs": 2}})
            self.assertEqual(result["spec"]["local"]["vllm"], {"visionAttention": "aotriton"})
            for choice in ("triton", "flash-attn-triton", "auto"):
                with self.subTest(choice=choice):
                    result = self.api["update_model_activation"]("example", {
                        "expectedRevision": "17", "local": {"vllm": {"visionAttention": choice}}})
                    saved = result["spec"]["local"]
                    self.assertEqual(saved["vllm"], {"visionAttention": choice})
                    self.assertEqual(saved["vramMi"], 16384)
                    self.assertEqual(saved["url"], current["spec"]["local"]["url"])
                    self.assertEqual(saved["env"], {"EXAMPLE_SETTING": "preserved"})
                    current["spec"]["local"] = copy.deepcopy(saved)
            count = len(calls)
            with self.assertRaisesRegex(ValueError, "vision attention backend"):
                self.api["update_model_activation"]("example", {
                    "expectedRevision": "17", "local": {"vllm": {"visionAttention": "invalid"}}})
            self.assertEqual(len(calls), count)


if __name__ == "__main__":
    unittest.main()
