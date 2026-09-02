import json
import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
PRESET_PATH = ROOT / "model-presets.yaml"

PORTABLE_PRESETS = {
    "qwen3508b",
    "qwen352b",
    "qwen354b",
    "qwen359b",
    "qwen3527b",
    "qwen3535b",
    "qwen3627b",
    "qwen3635b",
    "qwen3827b",
}
PORTABLE_MATRIX = {
    ("VLLM", "cpu"),
    ("VLLM", "nvidia-gpu"),
    ("VLLM", "amd-gpu"),
    ("VLLM", "intel-gpu"),
    ("OLlama", "cpu"),
    ("OLlama", "nvidia-gpu"),
    ("OLlama", "amd-gpu"),
}


def load_catalog():
    manifest = yaml.safe_load(PRESET_PATH.read_text(encoding="utf-8"))
    return json.loads(manifest["data"]["presets.json"])


def memory_to_mib(value):
    match = re.fullmatch(r"([1-9][0-9]*)(Mi|Gi)", value)
    if not match:
        raise AssertionError(f"invalid memory quantity: {value}")
    amount = int(match.group(1))
    return amount * (1024 if match.group(2) == "Gi" else 1)


class ModelPresetContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog()
        cls.presets = cls.catalog["presets"]

    def test_schema_and_requested_families_are_present(self):
        self.assertEqual(self.catalog["schemaVersion"], 2)
        self.assertTrue(PORTABLE_PRESETS.issubset(self.presets))
        self.assertNotIn("qwen38flashnext", self.presets)

    def test_portable_presets_expose_the_supported_engine_target_matrix(self):
        for preset_id in PORTABLE_PRESETS:
            with self.subTest(preset=preset_id):
                variants = self.presets[preset_id]["variants"]
                actual = {(variant["engine"], variant["computeTarget"]) for variant in variants}
                self.assertEqual(actual, PORTABLE_MATRIX)
                self.assertEqual(len(actual), len(variants))

    def test_variants_follow_runtime_url_and_memory_contracts(self):
        for preset_id, preset in self.presets.items():
            self.assertRegex(preset_id, r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
            for variant in preset["variants"]:
                with self.subTest(preset=preset_id, variant=variant.get("id")):
                    engine = variant["engine"]
                    target = variant["computeTarget"]
                    self.assertGreater(variant.get("contextWindow", 0), 0)
                    if "TextGeneration" in variant.get("features", []):
                        self.assertGreater(variant.get("maxNumSeqs", 0), 0)
                    if engine == "VLLM":
                        self.assertTrue(variant["url"].startswith("hf://"))
                    else:
                        self.assertEqual(engine, "OLlama")
                        self.assertTrue(variant["url"].startswith("ollama://"))
                        self.assertNotIn("args", variant)
                        self.assertNotEqual(target, "intel-gpu")
                    if target == "cpu":
                        self.assertNotIn("vram", variant)
                        self.assertNotIn("vramMi", variant)
                        self.assertGreater(variant["memoryRequiredMi"], 0)
                    else:
                        self.assertGreater(variant["vramMi"], 0)
                        self.assertEqual(memory_to_mib(variant["vram"]), variant["vramMi"])

    def test_backend_specific_quantized_artifacts_are_explicitly_pinned(self):
        expected = {
            "qwen3508b": "ollama://qwen3.5:0.8b-q8_0",
            "qwen352b": "ollama://qwen3.5:2b-q4_K_M",
            "qwen354b": "ollama://qwen3.5:4b-q4_K_M",
            "qwen359b": "ollama://qwen3.5:9b-q4_K_M",
            "qwen3527b": "ollama://qwen3.5:27b-q4_K_M",
            "qwen3535b": "ollama://qwen3.5:35b-a3b-q4_K_M",
            "qwen3627b": "ollama://qwen3.6:27b-q4_K_M",
            "qwen3635b": "ollama://qwen3.6:35b-a3b-q4_K_M",
            "qwen3827b": "ollama://qwen3.8:27b-q4_K_M",
        }
        for preset_id, url in expected.items():
            with self.subTest(preset=preset_id):
                ollama_urls = {
                    variant["url"]
                    for variant in self.presets[preset_id]["variants"]
                    if variant["engine"] == "OLlama"
                }
                self.assertEqual(ollama_urls, {url})

        variants_35_27 = self.presets["qwen3527b"]["variants"]
        for target in ("nvidia-gpu", "intel-gpu"):
            variant = next(item for item in variants_35_27 if item["engine"] == "VLLM" and item["computeTarget"] == target)
            self.assertEqual(variant["url"], "hf://Qwen/Qwen3.5-27B-GPTQ-Int4")

        variants_36_27 = self.presets["qwen3627b"]["variants"]
        nvidia = next(item for item in variants_36_27 if item["engine"] == "VLLM" and item["computeTarget"] == "nvidia-gpu")
        self.assertEqual(nvidia["url"], "hf://Qwen/Qwen3.6-27B-FP8")

    def test_official_huggingface_sources_cover_every_requested_base_model(self):
        expected = {
            "hf://Qwen/Qwen3.8-27B",
            "hf://Qwen/Qwen3.6-27B",
            "hf://Qwen/Qwen3.6-35B-A3B",
            "hf://Qwen/Qwen3.5-0.8B",
            "hf://Qwen/Qwen3.5-2B",
            "hf://Qwen/Qwen3.5-4B",
            "hf://Qwen/Qwen3.5-9B",
            "hf://Qwen/Qwen3.5-27B",
            "hf://Qwen/Qwen3.5-35B-A3B",
        }
        actual = {
            variant["url"]
            for preset_id in PORTABLE_PRESETS
            for variant in self.presets[preset_id]["variants"]
            if variant["url"].startswith("hf://Qwen/")
        }
        self.assertTrue(expected.issubset(actual))


if __name__ == "__main__":
    unittest.main()
