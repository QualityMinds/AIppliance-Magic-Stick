import base64
import io
import pathlib
import threading
import time
import unittest
import urllib.error

import yaml


ROOT = pathlib.Path(__file__).resolve().parent


def load_server():
    manifest = yaml.safe_load((ROOT / "dashboard-api.yaml").read_text(encoding="utf-8"))
    source = manifest["data"]["server.py"]
    source = source.replace(
        "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)",
        "SSL_CONTEXT = None",
    ).replace(
        "PUBLIC_SSL_CONTEXT = ssl.create_default_context()",
        "PUBLIC_SSL_CONTEXT = None",
    )
    namespace = {"__name__": "magicstick_dashboard_api_test"}
    exec(compile(source, "server.py", "exec"), namespace)
    return namespace


class LocalRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.originals = {
            "model_activations": self.server["model_activations"],
            "module_activation": self.server["module_activation"],
            "delete_json": self.server["delete_json"],
            "summarized_modules": self.server["summarized_modules"],
            "compute_target_catalog": self.server["compute_target_catalog"],
            "ready_schedulable_nodes": self.server["ready_schedulable_nodes"],
            "hf_metadata": self.server["hf_metadata"],
            "ollama_metadata": self.server["ollama_metadata"],
            "vram_summary": self.server["vram_summary"],
            "fetch_public_json": self.server["fetch_public_json"],
        }
        self.server["compute_target_catalog"] = lambda: {
            "schemaVersion": 1,
            "targets": {
                "cpu": {
                    "displayName": "CPU",
                    "kind": "cpu",
                    "vendor": "generic",
                    "architectures": ["amd64", "arm64"],
                    "nodeSelector": {"kubernetes.io/os": "linux"},
                    "requiredCapabilities": [],
                    "resourceNames": [],
                    "engines": ["VLLM", "OLlama"],
                    "engineProfiles": {
                        "VLLM": {"defaultResourceProfile": "magicstick-vllm-cpu:1"},
                        "OLlama": {"defaultResourceProfile": "magicstick-ollama-cpu:1"},
                    },
                    "defaultResourceProfile": "magicstick-vllm-cpu:1",
                },
                "nvidia-gpu": {
                    "displayName": "NVIDIA GPU",
                    "kind": "gpu",
                    "vendor": "nvidia",
                    "architectures": ["amd64", "arm64"],
                    "nodeSelector": {"kubernetes.io/os": "linux"},
                    "requiredCapabilities": ["compute.gpu.nvidia"],
                    "resourceNames": ["nvidia.com/gpu"],
                    "engines": ["VLLM", "OLlama"],
                    "engineProfiles": {
                        "VLLM": {"defaultResourceProfile": "magicstick-nvidia-gpu:1"},
                        "OLlama": {"defaultResourceProfile": "magicstick-ollama-nvidia-gpu:1"},
                    },
                    "defaultResourceProfile": "magicstick-nvidia-gpu:1",
                },
                "amd-gpu": {
                    "displayName": "AMD GPU (ROCm)",
                    "kind": "gpu",
                    "vendor": "amd",
                    "architectures": ["amd64"],
                    "nodeSelector": {"kubernetes.io/os": "linux"},
                    "requiredCapabilities": ["compute.gpu.amd"],
                    "resourceNames": ["amd.com/gpu"],
                    "resourceProfilesByResource": {"amd.com/gpu": "magicstick-amd-gpu:1"},
                    "engines": ["VLLM", "OLlama"],
                    "engineProfiles": {
                        "VLLM": {
                            "defaultResourceProfile": "magicstick-amd-gpu:1",
                            "resourceProfilesByResource": {"amd.com/gpu": "magicstick-amd-gpu:1"},
                        },
                        "OLlama": {
                            "defaultResourceProfile": "magicstick-ollama-amd-gpu:1",
                            "resourceProfilesByResource": {"amd.com/gpu": "magicstick-ollama-amd-gpu:1"},
                        },
                    },
                    "defaultResourceProfile": "magicstick-amd-gpu:1",
                },
                "intel-gpu": {
                    "displayName": "Intel GPU (XPU)",
                    "kind": "gpu",
                    "vendor": "intel",
                    "architectures": ["amd64"],
                    "nodeSelector": {"kubernetes.io/os": "linux"},
                    "requiredCapabilities": ["compute.gpu.intel"],
                    "resourceNames": ["gpu.intel.com/xe", "gpu.intel.com/i915"],
                    "resourceProfilesByResource": {
                        "gpu.intel.com/xe": "magicstick-intel-xe-gpu:1",
                        "gpu.intel.com/i915": "magicstick-intel-i915-gpu:1",
                    },
                    "engines": ["VLLM"],
                    "engineProfiles": {
                        "VLLM": {
                            "defaultResourceProfile": "magicstick-intel-i915-gpu:1",
                            "resourceProfilesByResource": {
                                "gpu.intel.com/xe": "magicstick-intel-xe-gpu:1",
                                "gpu.intel.com/i915": "magicstick-intel-i915-gpu:1",
                            },
                        },
                    },
                    "defaultResourceProfile": "magicstick-intel-i915-gpu:1",
                },
            },
        }
        self.server["ready_schedulable_nodes"] = lambda: [{
            "metadata": {"labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "nodeInfo": {"architecture": "arm64"},
                "allocatable": {},
            },
        }]

    def tearDown(self):
        self.server.update(self.originals)

    def test_remove_local_runtime_deletes_only_auto_enabled_modules(self):
        deleted = []
        self.server["model_activations"] = lambda: []
        self.server["module_activation"] = lambda name: {
            "metadata": {
                "name": name,
                "annotations": {"appliance.magicstick.dev/auto-enabled": "true"},
            }
        }
        self.server["delete_json"] = lambda path: deleted.append(path) or {}

        result = self.server["remove_local_model_runtime"]()

        self.assertEqual(result, {"removed": ["kubeai", "gpu"], "skipped": []})
        self.assertTrue(deleted[0].endswith("/moduleactivations/kubeai"))
        self.assertTrue(deleted[1].endswith("/moduleactivations/gpu"))

    def test_remove_local_runtime_is_blocked_by_local_model(self):
        self.server["model_activations"] = lambda: [
            {
                "metadata": {"name": "local-chat"},
                "spec": {"type": "local", "enabled": True},
                "status": {"phase": "Ready"},
            }
        ]

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["remove_local_model_runtime"]()

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("local-chat", str(raised.exception))

    def test_remove_local_runtime_preserves_manually_managed_module(self):
        self.server["model_activations"] = lambda: []
        self.server["module_activation"] = lambda name: {
            "metadata": {"name": name, "annotations": {}}
        }
        self.server["delete_json"] = lambda _path: self.fail("manual module must not be deleted")

        result = self.server["remove_local_model_runtime"]()

        self.assertEqual(result, {"removed": [], "skipped": ["kubeai", "gpu"]})

    def test_remove_local_runtime_preserves_hardware_detected_gpu_operator(self):
        deleted = []
        self.server["model_activations"] = lambda: []
        self.server["module_activation"] = lambda name: {
            "metadata": {
                "name": name,
                "annotations": {
                    "appliance.magicstick.dev/auto-enabled": "true",
                    "appliance.magicstick.dev/activation-source": (
                        "hardware-detection" if name == "gpu" else ""
                    ),
                },
            }
        }
        self.server["delete_json"] = lambda path: deleted.append(path) or {}

        result = self.server["remove_local_model_runtime"]()

        self.assertEqual(result, {"removed": ["kubeai"], "skipped": ["gpu"]})
        self.assertEqual(len(deleted), 1)
        self.assertTrue(deleted[0].endswith("/moduleactivations/kubeai"))

    def test_manual_gpu_activation_is_marked_user_managed(self):
        resource = self.server["module_activation_payload"]("gpu", True)
        patch = self.server["manual_module_activation_patch"](resource)

        self.assertTrue(resource["spec"]["enabled"])
        self.assertEqual(
            resource["metadata"]["annotations"]["appliance.magicstick.dev/activation-source"],
            "manual",
        )
        self.assertIsNone(
            patch["metadata"]["annotations"]["appliance.magicstick.dev/auto-enabled"]
        )

    def test_manual_kubeai_disable_is_supported(self):
        resource = self.server["module_activation_payload"]("kubeai", False)

        self.assertFalse(resource["spec"]["enabled"])
        self.assertEqual(resource["spec"]["module"], "kubeai")

    def test_local_model_policy_does_not_block_manual_control(self):
        supported = self.server["module_manual_control_enabled"]({
            "activationMode": "moduleactivation",
            "activationPolicy": "local-model",
        })

        self.assertTrue(supported)

    def test_cpu_is_available_without_gpu_or_kubeai_modules(self):
        availability = self.server["compute_target_availability"]({
            "modules": {
                "gpu": {
                    "enabled": False,
                    "status": {"phase": "Disabled"},
                    "catalog": {"providesCapabilities": ["compute.gpu.nvidia"]},
                },
                "kubeai": {"enabled": False, "status": {"phase": "Disabled"}},
            }
        })

        targets = {target["id"]: target for target in availability["targets"]}
        self.assertTrue(targets["cpu"]["available"])
        self.assertEqual(targets["cpu"]["reason"], "ready")
        self.assertFalse(targets["nvidia-gpu"]["available"])
        self.assertEqual(targets["nvidia-gpu"]["reason"], "capability-module-disabled")
        self.assertEqual(availability["default"], "cpu")

    def test_nvidia_requires_enabled_module_and_allocatable_gpu(self):
        modules = {
            "modules": {
                "gpu": {
                    "enabled": True,
                    "displayName": "NVIDIA GPU",
                    "status": {"phase": "Ready"},
                    "catalog": {"providesCapabilities": ["compute.gpu.nvidia"]},
                },
            }
        }

        targets = {
            target["id"]: target
            for target in self.server["compute_target_availability"](modules)["targets"]
        }
        self.assertFalse(targets["nvidia-gpu"]["available"])
        self.assertEqual(targets["nvidia-gpu"]["reason"], "no-allocatable-resource")

        self.server["ready_schedulable_nodes"] = lambda: [{
            "metadata": {"labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "nodeInfo": {"architecture": "arm64"},
                "allocatable": {"nvidia.com/gpu": "1"},
            },
        }]
        targets = {
            target["id"]: target
            for target in self.server["compute_target_availability"](modules)["targets"]
        }
        self.assertTrue(targets["nvidia-gpu"]["available"])
        self.assertEqual(targets["nvidia-gpu"]["reason"], "ready")

    def test_nvidia_is_available_while_flux_reconciles_when_resource_is_allocatable(self):
        modules = {
            "modules": {
                "gpu": {
                    "enabled": True,
                    "displayName": "NVIDIA GPU",
                    "status": {"phase": "Reconciling"},
                    "catalog": {"providesCapabilities": ["compute.gpu.nvidia"]},
                },
            }
        }
        self.server["ready_schedulable_nodes"] = lambda: [{
            "metadata": {"labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "nodeInfo": {"architecture": "amd64"},
                "allocatable": {"nvidia.com/gpu": "2"},
            },
        }]

        targets = {
            target["id"]: target
            for target in self.server["compute_target_availability"](modules)["targets"]
        }

        self.assertTrue(targets["nvidia-gpu"]["available"])
        self.assertEqual(targets["nvidia-gpu"]["reason"], "ready")
        self.assertEqual(targets["nvidia-gpu"]["selectedResourceName"], "nvidia.com/gpu")
        self.assertIn("2 allocatable", targets["nvidia-gpu"]["message"])

    def test_nvidia_waits_for_reconciling_module_without_allocatable_resource(self):
        modules = {
            "modules": {
                "gpu": {
                    "enabled": True,
                    "displayName": "NVIDIA GPU",
                    "status": {"phase": "Reconciling"},
                    "catalog": {"providesCapabilities": ["compute.gpu.nvidia"]},
                },
            }
        }

        targets = {
            target["id"]: target
            for target in self.server["compute_target_availability"](modules)["targets"]
        }

        self.assertFalse(targets["nvidia-gpu"]["available"])
        self.assertEqual(targets["nvidia-gpu"]["reason"], "capability-module-not-ready")
        self.assertIn("no allocatable resource yet", targets["nvidia-gpu"]["message"])

    def test_amd_and_intel_targets_require_vendor_resources_and_resolve_profile(self):
        modules = {
            "modules": {
                "amd-gpu": {
                    "enabled": True,
                    "displayName": "AMD GPU Operator",
                    "status": {"phase": "Ready"},
                    "catalog": {"providesCapabilities": ["compute.gpu.amd"]},
                },
                "intel-gpu": {
                    "enabled": True,
                    "displayName": "Intel GPU Operator",
                    "status": {"phase": "Ready"},
                    "catalog": {"providesCapabilities": ["compute.gpu.intel"]},
                },
            }
        }
        self.server["ready_schedulable_nodes"] = lambda: [{
            "metadata": {"labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "nodeInfo": {"architecture": "amd64"},
                "allocatable": {"amd.com/gpu": "1", "gpu.intel.com/xe": "2"},
            },
        }]

        targets = {
            target["id"]: target
            for target in self.server["compute_target_availability"](modules)["targets"]
        }

        self.assertTrue(targets["amd-gpu"]["available"])
        self.assertEqual(targets["amd-gpu"]["selectedResourceName"], "amd.com/gpu")
        self.assertEqual(targets["amd-gpu"]["resolvedResourceProfile"], "magicstick-amd-gpu:1")
        self.assertEqual(
            targets["amd-gpu"]["resolvedResourceProfiles"]["OLlama"],
            "magicstick-ollama-amd-gpu:1",
        )
        self.assertTrue(targets["intel-gpu"]["available"])
        self.assertEqual(targets["intel-gpu"]["selectedResourceName"], "gpu.intel.com/xe")
        self.assertEqual(targets["intel-gpu"]["resolvedResourceProfile"], "magicstick-intel-xe-gpu:1")

    def test_unavailable_nvidia_target_returns_conflict(self):
        self.server["summarized_modules"] = lambda: {
            "modules": {
                "gpu": {
                    "enabled": False,
                    "displayName": "NVIDIA GPU",
                    "status": {"phase": "Disabled"},
                    "catalog": {"providesCapabilities": ["compute.gpu.nvidia"]},
                },
            }
        }

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_compute_target_available"]("nvidia-gpu")

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("NVIDIA GPU module", str(raised.exception))

    def test_local_model_payload_is_compute_target_aware_and_sanitized(self):
        resource = self.server["model_activation_payload"]("local", {
            "name": "cpu-chat",
            "local": {
                "computeTarget": "cpu",
                "preset": "qwen2505bcpu",
                "vram": "99Gi",
                "memoryRequiredMi": 3072,
                "engine": "OLLAMA",
                "resourceProfile": "attacker-profile:1",
                "args": ["--trust-remote-code"],
                "env": {"DANGEROUS": "true"},
            },
        })

        local = resource["spec"]["local"]
        self.assertEqual(local["computeTarget"], "cpu")
        self.assertEqual(local["engine"], "OLlama")
        self.assertEqual(local["preset"], "qwen2505bcpu")
        self.assertEqual(local["memoryRequiredMi"], 3072)
        for forbidden in ("vram", "vramMi", "resourceProfile", "args", "env"):
            self.assertNotIn(forbidden, local)
        self.assertEqual(
            resource["metadata"]["labels"]["appliance.magicstick.dev/compute-target"],
            "cpu",
        )
        self.assertEqual(resource["metadata"]["labels"]["appliance.magicstick.dev/engine"], "ollama")

    def test_gpu_model_payload_drops_cpu_memory_reservation(self):
        resource = self.server["model_activation_payload"]("local", {
            "name": "gpu-chat",
            "local": {
                "computeTarget": "nvidia-gpu",
                "vram": "8Gi",
                "memoryRequiredMi": 32768,
            },
        })

        self.assertNotIn("memoryRequiredMi", resource["spec"]["local"])

    def test_cpu_model_payload_rejects_memory_reservations_below_one_unit(self):
        for value in (0, 15, True, "invalid"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as raised:
                    self.server["model_activation_payload"]("local", {
                        "name": "cpu-chat",
                        "local": {
                            "computeTarget": "cpu",
                            "memoryRequiredMi": value,
                        },
                    })

                self.assertIn("at least 16 MiB", str(raised.exception))

    def test_unknown_local_engine_is_rejected(self):
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["model_activation_payload"]("local", {
                "name": "invalid-engine",
                "local": {"computeTarget": "cpu", "engine": "future-engine"},
            })

        self.assertEqual(raised.exception.status, 400)

    def test_intel_target_rejects_ollama_until_an_official_profile_exists(self):
        modules = {
            "modules": {
                "intel-gpu": {
                    "enabled": True,
                    "displayName": "Intel GPU Operator",
                    "status": {"phase": "Ready"},
                    "catalog": {"providesCapabilities": ["compute.gpu.intel"]},
                },
            }
        }
        self.server["summarized_modules"] = lambda: modules
        self.server["ready_schedulable_nodes"] = lambda: [{
            "metadata": {"labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "nodeInfo": {"architecture": "amd64"},
                "allocatable": {"gpu.intel.com/i915": "1"},
            },
        }]

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_compute_target_available"]("intel-gpu", "OLlama")

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("does not support OLlama", str(raised.exception))

    def test_vllm_memory_estimate_supports_every_compute_target(self):
        self.server["hf_metadata"] = lambda repo: {
            "repo": repo,
            "config": {
                "num_hidden_layers": 4,
                "hidden_size": 16,
                "num_attention_heads": 4,
                "num_key_value_heads": 2,
                "vocab_size": 128,
                "torch_dtype": "float16",
            },
            "safetensorsIndex": {"metadata": {"total_size": 1024 * 1024 * 1024}},
            "modelApi": {},
        }
        self.server["vram_summary"] = lambda _activations: {"available": False}
        self.server["model_activations"] = lambda: []

        for target in ("cpu", "nvidia-gpu", "amd-gpu", "intel-gpu"):
            with self.subTest(target=target):
                estimate = self.server["estimate_model_memory"]({
                    "engine": "VLLM",
                    "computeTarget": target,
                    "url": "hf://example/model",
                    "contextWindow": 4096,
                    "maxNumSeqs": 2,
                    "modelType": "chat",
                })

                self.assertEqual(estimate["computeTarget"], target)
                self.assertEqual(estimate["memoryKind"], "ram" if target == "cpu" else "vram")
                self.assertEqual(estimate["calculationSource"], "huggingface-model-metadata")
                self.assertGreater(estimate["minimumMi"], estimate["weightsMi"])
                self.assertGreater(estimate["recommendedMi"], estimate["minimumMi"])

    def test_cpu_vllm_hybrid_estimate_includes_startup_and_compatibility_reserves(self):
        mib = 1024 * 1024
        self.server["hf_metadata"] = lambda repo: {
            "repo": repo,
            "config": {
                "model_type": "hybrid_test",
                "quantization_config": {
                    "quant_method": "compressed-tensors",
                    "config_groups": {
                        "group_0": {"weights": {"num_bits": 4}},
                    },
                },
                "text_config": {
                    "num_hidden_layers": 4,
                    "hidden_size": 64,
                    "num_attention_heads": 4,
                    "num_key_value_heads": 2,
                    "head_dim": 16,
                    "intermediate_size": 128,
                    "vocab_size": 256,
                    "dtype": "bfloat16",
                    "max_position_embeddings": 8192,
                    "layer_types": [
                        "linear_attention", "linear_attention",
                        "linear_attention", "full_attention",
                    ],
                },
                "vision_config": {"hidden_size": 64},
            },
            "safetensorsIndex": {"metadata": {}},
            "modelTree": [
                {"type": "file", "path": "model-1.safetensors", "size": 600 * mib},
                {"type": "file", "path": "model-2.safetensors", "size": 200 * mib},
            ],
            "modelApi": {"safetensors": {"total": 1_000_000_000}},
        }

        estimate = self.server["estimate_model_memory"]({
            "engine": "VLLM",
            "computeTarget": "cpu",
            "url": "hf://example/hybrid",
            "contextWindow": 8192,
            "maxNumSeqs": 1,
            "modelType": "chat",
        })

        self.assertEqual(estimate["weightsMi"], 800)
        self.assertEqual(estimate["kvCacheMi"], 4)
        self.assertEqual(estimate["reserveMi"], 8052)
        self.assertEqual(estimate["minimumMi"], 8856)
        self.assertEqual(estimate["recommendedMi"], 10904)
        self.assertEqual(estimate["confidence"], "estimated")
        self.assertTrue(any("4x compatibility factor" in item for item in estimate["warnings"]))

    def test_vllm_memory_estimate_rejects_context_above_model_limit(self):
        self.server["hf_metadata"] = lambda repo: {
            "repo": repo,
            "config": {
                "num_hidden_layers": 4,
                "hidden_size": 16,
                "num_attention_heads": 4,
                "max_position_embeddings": 8192,
            },
            "safetensorsIndex": {"metadata": {"total_size": 1024 * 1024}},
            "modelApi": {},
        }

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["estimate_model_memory"]({
                "engine": "VLLM",
                "computeTarget": "cpu",
                "url": "hf://example/model",
                "contextWindow": 8193,
                "maxNumSeqs": 1,
            })

        self.assertEqual(raised.exception.status, 400)
        self.assertIn("model maximum of 8192", str(raised.exception))

    def test_cpu_vllm_payload_derives_cache_server_side_and_enforces_minimum(self):
        mib = 1024 * 1024
        self.server["hf_metadata"] = lambda repo: {
            "repo": repo,
            "config": {
                "num_hidden_layers": 2,
                "hidden_size": 16,
                "num_attention_heads": 4,
                "num_key_value_heads": 2,
                "max_position_embeddings": 4096,
                "torch_dtype": "float16",
            },
            "safetensorsIndex": {"metadata": {"total_size": 1024 * mib}},
            "modelApi": {},
        }
        payload = {
            "name": "cpu-vllm",
            "local": {
                "computeTarget": "cpu",
                "engine": "VLLM",
                "url": "hf://example/model",
                "memoryRequiredMi": 5200,
                "contextWindow": 4096,
                "maxNumSeqs": 1,
            },
        }

        resource = self.server["model_activation_payload"]("local", payload)

        self.assertEqual(resource["spec"]["local"]["kvCacheMemoryBytes"], 100 * mib)
        payload["local"]["memoryRequiredMi"] = 3000
        with self.assertRaises(ValueError) as raised:
            self.server["model_activation_payload"]("local", payload)
        self.assertIn("must be at least", str(raised.exception))

    def test_ollama_memory_estimate_supports_cpu_nvidia_and_amd_without_huggingface(self):
        self.server["hf_metadata"] = lambda _repo: self.fail("Ollama estimation must not call HuggingFace")
        self.server["ollama_metadata"] = lambda reference: {
            "reference": reference,
            "modelBytes": 384 * 1024 * 1024,
        }
        self.server["vram_summary"] = lambda _activations: {"available": False}
        self.server["model_activations"] = lambda: []

        for target in ("cpu", "nvidia-gpu", "amd-gpu"):
            with self.subTest(target=target):
                estimate = self.server["estimate_model_memory"]({
                    "engine": "OLlama",
                    "computeTarget": target,
                    "url": "ollama://qwen2.5:0.5b",
                    "contextWindow": 2048,
                    "maxNumSeqs": 1,
                    "modelType": "chat",
                })

                self.assertEqual(estimate["repo"], "library/qwen2.5:0.5b")
                self.assertEqual(estimate["calculationSource"], "ollama-registry-manifest")
                self.assertEqual(estimate["weightsMi"], 384)
                self.assertGreater(estimate["minimumMi"], estimate["weightsMi"])
                self.assertGreater(estimate["recommendedMi"], estimate["minimumMi"])

    def test_ollama_memory_estimate_rejects_unsupported_intel_target(self):
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["estimate_model_memory"]({
                "engine": "OLlama",
                "computeTarget": "intel-gpu",
                "url": "ollama://qwen2.5:0.5b",
            })

        self.assertEqual(raised.exception.status, 400)
        self.assertIn("not supported", str(raised.exception))

    def test_ollama_registry_manifest_counts_only_runtime_model_layers(self):
        self.server["OLLAMA_METADATA_CACHE"].clear()
        requested = []

        def fake_fetch(url, required=True):
            requested.append(url)
            return {
                "layers": [
                    {"mediaType": "application/vnd.ollama.image.model", "size": 300},
                    {"mediaType": "application/vnd.ollama.image.adapter", "size": 50},
                    {"mediaType": "application/vnd.ollama.image.license", "size": 9999},
                ]
            }

        self.server["fetch_public_json"] = fake_fetch
        reference = self.server["ollama_model_reference"]("ollama://team/model:v1")
        metadata = self.server["ollama_metadata"](reference)

        self.assertEqual(reference["reference"], "team/model:v1")
        self.assertEqual(metadata["modelBytes"], 350)
        self.assertEqual(requested, ["https://registry.ollama.ai/v2/team/model/manifests/v1"])

    def test_dashboard_renders_starting_model_phase_as_progress(self):
        source = (ROOT / "configmap.yaml").read_text(encoding="utf-8")

        self.assertIn("normalized === 'starting'", source)
        self.assertIn("label: 'Starting model runtime'", source)
        self.assertIn("'starting', 'reconciling'", source)

    def test_status_payload_exposes_hardware_operator_state(self):
        originals = {
            "appliance": self.server["appliance"],
            "list_resource": self.server["list_resource"],
        }
        self.server["appliance"] = lambda: {
            "metadata": {"namespace": "ai-system", "name": "local"},
            "spec": {},
            "status": {
                "hardwareOperators": {
                    "gpu": {
                        "displayName": "NVIDIA GPU Operator",
                        "phase": "NotRequired",
                        "operatorActive": False,
                    }
                }
            },
        }
        self.server["list_resource"] = lambda _path: []
        try:
            payload = self.server["status_payload"]()
        finally:
            self.server.update(originals)

        self.assertEqual(
            payload["hardwareOperators"]["gpu"]["phase"],
            "NotRequired",
        )


class ComputeMemoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "ready_schedulable_nodes",
            "request_json",
            "request_text",
            "list_resource",
            "compute_target_catalog",
        )
        self.originals = {name: self.server[name] for name in names}

    def tearDown(self):
        self.server.update(self.originals)

    @staticmethod
    def node(memory="16Gi", gpu_capacity=None):
        capacity = {"memory": memory}
        capacity.update(gpu_capacity or {})
        return {
            "metadata": {"name": "node-a", "labels": {"kubernetes.io/os": "linux"}},
            "status": {
                "capacity": capacity,
                "allocatable": capacity,
                "nodeInfo": {"architecture": "amd64"},
            },
        }

    def test_cpu_gauge_uses_total_reserved_and_kubelet_available_memory(self):
        self.server["ready_schedulable_nodes"] = lambda: [self.node()]
        self.server["request_json"] = lambda _method, path, *_args, **_kwargs: {
            "node": {"memory": {"availableBytes": 10 * 1024 * 1024 * 1024}}
        } if path.endswith("/proxy/stats/summary") else {}
        self.server["compute_target_catalog"] = lambda: {"targets": {}}
        activations = [{
            "metadata": {"name": "cpu-chat"},
            "spec": {"type": "local", "enabled": True, "local": {"computeTarget": "cpu"}},
            "status": {"memoryRequiredMi": 4096},
        }]

        result = self.server["compute_memory_summary"](
            activations,
            {"available": False, "gpus": []},
        )

        self.assertEqual(result["deviceCount"], 1)
        cpu = result["devices"][0]
        self.assertEqual(cpu["name"], "CPU")
        self.assertEqual(cpu["totalMi"], 16384)
        self.assertEqual(cpu["reservedMi"], 4096)
        self.assertEqual(cpu["unreservedMi"], 12288)
        self.assertEqual(cpu["freeMi"], 10240)
        self.assertTrue(cpu["metricsAvailable"])
        self.assertEqual(cpu["metricsSource"], "kubelet")

    def test_cpu_gauge_falls_back_to_metrics_api_working_set(self):
        self.server["ready_schedulable_nodes"] = lambda: [self.node()]

        def deny_proxy(_method, path, *_args, **_kwargs):
            if path.endswith("/proxy/stats/summary"):
                raise urllib.error.HTTPError(path, 403, "Forbidden", None, None)
            return {}

        self.server["request_json"] = deny_proxy
        self.server["list_resource"] = lambda path: [{
            "metadata": {"name": "node-a"},
            "usage": {"memory": "6Gi"},
        }] if path == "/apis/metrics.k8s.io/v1beta1/nodes" else []
        self.server["compute_target_catalog"] = lambda: {"targets": {}}

        result = self.server["compute_memory_summary"]([], {"available": False, "gpus": []})

        cpu = result["devices"][0]
        self.assertEqual(cpu["freeMi"], 10240)
        self.assertEqual(cpu["metricsSource"], "metrics-api-estimate")

    def test_nvidia_gauge_is_per_device_and_applies_model_reservation(self):
        self.server["ready_schedulable_nodes"] = lambda: []
        self.server["compute_target_catalog"] = lambda: {"targets": {}}
        activations = [{
            "metadata": {"name": "gpu-chat"},
            "spec": {
                "type": "local",
                "enabled": True,
                "local": {"computeTarget": "nvidia-gpu", "vram": "8Gi"},
            },
            "status": {"vramRequiredMi": 8192},
        }]
        nvidia = {
            "available": True,
            "gpus": [{
                "id": "0",
                "uuid": "GPU-1",
                "modelName": "NVIDIA Test GPU",
                "hostname": "gpu-node",
                "totalMi": 24576,
                "freeMi": 18432,
                "usedMi": 6144,
            }],
        }

        result = self.server["compute_memory_summary"](activations, nvidia)

        self.assertEqual(result["deviceCount"], 1)
        gpu = result["devices"][0]
        self.assertEqual(gpu["name"], "NVIDIA Test GPU")
        self.assertEqual(gpu["reservedMi"], 8192)
        self.assertEqual(gpu["unreservedMi"], 16384)
        self.assertEqual(gpu["freeMi"], 18432)
        self.assertEqual(gpu["metricsSource"], "dcgm")

    def test_nvidia_unreserved_memory_uses_total_minus_model_reservations(self):
        self.server["request_text"] = lambda *_args, **_kwargs: "\n".join((
            'DCGM_FI_DEV_FB_FREE{gpu="0",UUID="GPU-1"} 18432',
            'DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-1"} 6144',
        ))
        activations = [{
            "metadata": {"name": "gpu-chat"},
            "spec": {
                "type": "local",
                "enabled": True,
                "local": {"computeTarget": "nvidia-gpu", "vram": "8Gi"},
            },
        }]

        result = self.server["vram_summary"](activations)

        self.assertEqual(result["totalMi"], 24576)
        self.assertEqual(result["freeMi"], 18432)
        self.assertEqual(result["plannedMi"], 8192)
        self.assertEqual(result["plannedRemainingMi"], 16384)

    def test_gpu_without_vendor_memory_exporter_is_visible_without_fake_values(self):
        nodes = [self.node(gpu_capacity={"amd.com/gpu": "1"})]
        catalog = {
            "targets": {
                "amd-gpu": {
                    "displayName": "AMD GPU (ROCm)",
                    "kind": "gpu",
                    "vendor": "amd",
                    "resourceNames": ["amd.com/gpu"],
                }
            }
        }
        placeholders = self.server["gpu_resource_placeholders"](nodes, catalog, [])
        devices = self.server["assign_gpu_reservations"](placeholders, {
            "amd-gpu": [{"model": "amd-chat", "reservedMi": 4096}],
        })

        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["name"], "AMD GPU (ROCm)")
        self.assertFalse(devices[0]["metricsAvailable"])
        self.assertIsNone(devices[0]["freeMi"])
        self.assertIsNone(devices[0]["unreservedMi"])
        self.assertEqual(devices[0]["reservedMi"], 4096)

    def test_dashboard_rbac_allows_read_only_node_memory_sources(self):
        role = yaml.safe_load((ROOT / "clusterrole.yaml").read_text(encoding="utf-8"))
        rules = role["rules"]
        self.assertTrue(any(
            rule.get("apiGroups") == [""]
            and "nodes/proxy" in rule.get("resources", [])
            and rule.get("verbs") == ["get"]
            for rule in rules
        ))
        self.assertTrue(any(
            rule.get("apiGroups") == ["metrics.k8s.io"]
            and "nodes" in rule.get("resources", [])
            and set(rule.get("verbs", [])) == {"get", "list"}
            for rule in rules
        ))


class SettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.originals = {
            "settings_configmap": self.server["settings_configmap"],
            "request_json": self.server["request_json"],
        }

    def tearDown(self):
        self.server.update(self.originals)

    def test_settings_response_derives_dashboard_host_from_public_domain(self):
        result = self.server["settings_response"]({
            "data": {
                "AI_APPLIANCE_DOMAIN": "appliance.example.com",
                "AI_APPLIANCE_DASHBOARD_HOST": "legacy-dashboard.example.com",
                "AI_APPLIANCE_MDNS_DOMAIN": "appliance.local",
            }
        })

        self.assertEqual(result["publicDomain"], "appliance.example.com")
        self.assertEqual(result["dashboardHost"], "appliance.example.com")
        self.assertEqual(
            result["data"]["AI_APPLIANCE_DASHBOARD_HOST"],
            "appliance.example.com",
        )

    def test_settings_patch_keeps_dashboard_host_equal_to_public_domain(self):
        existing = {
            "data": {
                "AI_APPLIANCE_DOMAIN": "old.example.com",
                "AI_APPLIANCE_DASHBOARD_HOST": "legacy.example.com",
                "AI_APPLIANCE_MDNS_DOMAIN": "old.local",
            }
        }
        captured = {}
        self.server["settings_configmap"] = lambda: existing

        def request_json(method, path, payload, content_type):
            captured.update({
                "method": method,
                "path": path,
                "payload": payload,
                "contentType": content_type,
            })
            return {"data": payload["data"]}

        self.server["request_json"] = request_json

        result = self.server["settings_patch"]({
            "publicDomain": "new.example.com",
            "mdnsDomain": "new.local",
            "dashboardHost": "ignored.example.com",
        })

        self.assertEqual(captured["method"], "PATCH")
        self.assertEqual(
            captured["payload"]["data"]["AI_APPLIANCE_DASHBOARD_HOST"],
            "new.example.com",
        )
        self.assertEqual(result["dashboardHost"], "new.example.com")


class ModuleCredentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "catalog_json",
            "module_activation",
            "read_secret",
            "settings_response",
        )
        self.originals = {name: self.server[name] for name in names}
        self.server["catalog_json"] = lambda: {
            "modules": {
                "litellm": {
                    "credentials": {
                        "provider": "litellm",
                        "secretName": "must-not-control-secret-selection",
                    }
                },
                "model-catalog": {},
            }
        }
        self.server["module_activation"] = lambda name: {
            "metadata": {"name": name},
            "spec": {"module": name, "enabled": True},
            "status": {"phase": "Ready"},
        }
        self.server["settings_response"] = lambda: {
            "mdnsDomain": "magicstick.local",
            "publicDomain": "magicstick.example.com",
        }

    def tearDown(self):
        self.server.update(self.originals)

    def test_litellm_credentials_use_only_the_fixed_master_key_secret(self):
        requested = []
        encoded_key = base64.b64encode(b"sk-CHANGEME").decode("ascii")

        def read_secret(namespace, name, label):
            requested.append((namespace, name, label))
            return {"data": {"LITELLM_MASTER_KEY": encoded_key}}

        self.server["read_secret"] = read_secret

        result = self.server["module_credentials"]("litellm")

        self.assertEqual(
            requested,
            [("ai", "litellm-masterkey-secret", "LiteLLM master key")],
        )
        self.assertEqual(result["module"], "litellm")
        self.assertEqual(result["secretName"], "litellm-masterkey-secret")
        fields = {item["key"]: item["value"] for item in result["credentials"]}
        self.assertEqual(fields["ui_username"], "admin")
        self.assertEqual(fields["ui_password"], "sk-CHANGEME")
        self.assertEqual(fields["master_key"], "sk-CHANGEME")
        self.assertEqual(fields["authorization"], "Bearer sk-CHANGEME")
        self.assertEqual(fields["local_ui_url"], "https://litellm.magicstick.local/ui/")
        self.assertEqual(fields["public_api_base"], "https://litellm.magicstick.example.com/v1")
        self.assertEqual(fields["service_api_base"], "http://litellm.ai.svc.cluster.local:4000/v1")

    def test_module_credentials_require_an_enabled_catalogued_provider(self):
        self.server["read_secret"] = lambda *_args: self.fail("secret must not be read")
        self.server["module_activation"] = lambda _name: {
            "spec": {"enabled": False},
        }

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["module_credentials"]("litellm")

        self.assertEqual(raised.exception.status, 409)

        with self.assertRaises(ValueError):
            self.server["module_credentials"]("model-catalog")

    def test_module_and_instance_credentials_require_operator_access(self):
        self.assertEqual(
            self.server["required_get_access"](["api", "modules", "litellm", "credentials"]),
            "operator",
        )
        self.assertEqual(
            self.server["required_get_access"](["api", "instances", "demo", "credentials"]),
            "operator",
        )
        self.assertEqual(
            self.server["required_get_access"](["api", "modules"]),
            "viewer",
        )


class ApiAccessManagementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "litellm_admin_request",
            "litellm_api_bases",
        )
        self.originals = {name: self.server[name] for name in names}
        self.server["litellm_api_bases"] = lambda settings=None: [
            {"scope": "local", "url": "https://litellm.magicstick.local/v1"},
            {"scope": "public", "url": "https://litellm.magicstick.example.com/v1"},
        ]

    def tearDown(self):
        self.server.update(self.originals)

    def test_api_access_requires_admin_access(self):
        self.assertEqual(
            self.server["required_get_access"](["api", "api-access"]),
            "admin",
        )
        self.assertEqual(
            self.server["required_get_access"](["api", "api-access", "key-id"]),
            "admin",
        )

    def test_list_filters_unmanaged_keys_and_never_returns_raw_secrets(self):
        managed_token = "a" * 64

        def request(method, path, body=None):
            self.assertEqual(method, "GET")
            self.assertTrue(path.startswith("/key/list?"))
            self.assertIsNone(body)
            return {
                "keys": [
                    {
                        "token": managed_token,
                        "key_alias": "magicstick-ci",
                        "metadata": {
                            "magicstick_source": "magicstick-dashboard",
                            "magicstick_name": "CI pipeline",
                        },
                        "created_at": "2026-09-02T10:00:00Z",
                    },
                    {
                        "token": "b" * 64,
                        "key_alias": "outside-dashboard",
                        "metadata": {"owner": "external"},
                    },
                    {
                        "key": "sk-MUST-NOT-LEAK",
                        "metadata": {"magicstick_source": "other"},
                    },
                ],
                "total_pages": 1,
            }

        self.server["litellm_admin_request"] = request

        result = self.server["list_api_access"]()

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["id"], managed_token)
        self.assertEqual(result["items"][0]["name"], "CI pipeline")
        self.assertNotIn("sk-MUST-NOT-LEAK", repr(result))
        self.assertEqual(result["apiBases"][0]["scope"], "local")

    def test_create_uses_named_dashboard_metadata_and_returns_secret_once(self):
        captured = {}
        token_id = "c" * 64

        def request(method, path, body=None):
            captured.update({"method": method, "path": path, "body": body})
            return {
                "key": "sk-ONE-TIME-CHANGEME",
                "token": token_id,
                "created_at": "2026-09-02T10:15:00Z",
            }

        self.server["litellm_admin_request"] = request

        result = self.server["create_api_access"]({"name": "Build Bot"})

        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["path"], "/key/generate")
        self.assertEqual(captured["body"]["models"], [])
        self.assertEqual(captured["body"]["key_type"], "llm_api")
        self.assertEqual(captured["body"]["metadata"], {
            "magicstick_source": "magicstick-dashboard",
            "magicstick_name": "Build Bot",
        })
        self.assertTrue(captured["body"]["key_alias"].startswith("magicstick-build-bot-"))
        self.assertEqual(result["key"], "sk-ONE-TIME-CHANGEME")
        self.assertEqual(result["item"]["id"], token_id)
        self.assertNotIn("key", result["item"])

    def test_delete_rejects_keys_not_created_by_the_dashboard(self):
        unmanaged_token = "d" * 64
        calls = []

        def request(method, path, body=None):
            calls.append((method, path, body))
            if method == "GET":
                return {
                    "keys": [{
                        "token": unmanaged_token,
                        "metadata": {"owner": "external"},
                    }],
                    "total_pages": 1,
                }
            self.fail("an unmanaged key must never be deleted")

        self.server["litellm_admin_request"] = request

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["delete_api_access"](unmanaged_token)

        self.assertEqual(raised.exception.status, 404)
        self.assertEqual([call[0] for call in calls], ["GET"])

    def test_delete_verifies_ownership_before_revoking(self):
        managed_token = "e" * 64
        calls = []

        def request(method, path, body=None):
            calls.append((method, path, body))
            if method == "GET":
                return {
                    "keys": [{
                        "token": managed_token,
                        "metadata": {
                            "magicstick_source": "magicstick-dashboard",
                            "magicstick_name": "Automation",
                        },
                    }],
                    "total_pages": 1,
                }
            return {"deleted_keys": [managed_token]}

        self.server["litellm_admin_request"] = request

        result = self.server["delete_api_access"](managed_token)

        self.assertEqual(result, {"deleted": managed_token, "name": "Automation"})
        self.assertEqual(calls[-1], ("POST", "/key/delete", {"keys": [managed_token]}))


class KubernetesAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "live_admin_actor",
            "keycloak_user",
            "keycloak_user_groups",
            "keycloak_admin_request",
            "identity_source",
            "protected_user",
            "_keycloak_user_page",
            "_keycloak_user_count",
            "_kubernetes_user_summary",
            "_direct_kubernetes_groups",
            "_kubernetes_access_group",
            "_replace_kubernetes_access_groups",
            "_logout_user",
            "kubernetes_access_info",
            "_base64_file",
            "request_json",
            "list_resource",
            "settings_response",
            "_safe_https_endpoint",
            "_appliance_api_server_endpoint",
        )
        self.originals = {name: self.server[name] for name in names}
        self.principal = {"subject": "admin-id", "username": "admin", "roles": ["magicstick-admin"]}
        self.user = {
            "id": "user-id",
            "username": "alice",
            "firstName": "Alice",
            "lastName": "Admin",
            "email": "alice@example.com",
            "enabled": True,
        }
        self.server["live_admin_actor"] = lambda _principal: {"id": "admin-id", "enabled": True}
        self.server["keycloak_user"] = lambda _user_id: dict(self.user)
        self.server["identity_source"] = lambda _user: ("local", "local")
        self.server["protected_user"] = lambda _user: False

    def tearDown(self):
        self.server.update(self.originals)

    def test_routes_require_appliance_administrator(self):
        for parts in (
            ["api", "kubernetes-access"],
            ["api", "kubernetes-access", "user-id", "kubeconfig"],
        ):
            self.assertEqual(self.server["required_get_access"](parts), "admin")

    def test_list_is_user_bound_and_reports_cluster_configuration(self):
        self.server["_keycloak_user_page"] = lambda first, maximum, search: [dict(self.user)]
        self.server["_keycloak_user_count"] = lambda search: 1
        self.server["_kubernetes_user_summary"] = lambda user: {
            "id": user["id"],
            "username": user["username"],
            "enabled": True,
            "accessLevel": "viewer",
        }
        self.server["kubernetes_access_info"] = lambda required=False: {
            "configured": True,
            "issuerUrl": "https://id.magicstick.local/realms/magicstick",
            "clientId": "magicstick-kubernetes",
            "apiServer": "https://magicstick.local:6443",
        }

        result = self.server["list_kubernetes_access"](
            self.principal,
            {"first": ["0"], "max": ["25"], "search": ["alice"]},
        )

        self.assertEqual(result["users"][0]["accessLevel"], "viewer")
        self.assertTrue(result["configuration"]["configured"])
        self.assertEqual(result["configuration"]["credentialPlugin"], "kubectl oidc-login")
        self.assertNotIn("token", repr(result).lower())
        self.assertNotIn("password", repr(result).lower())

    def test_cluster_configuration_is_rejected_after_mdns_domain_changes(self):
        self.server["request_json"] = lambda method, path: {
            "data": {
                "enabled": "true",
                "issuer-url": "https://id.magicstick.local/realms/magicstick",
                "client-id": "magicstick-kubernetes",
                "api-server": "https://magicstick.local:6443",
                "oidc-ca.crt": "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
            }
        }
        self.server["settings_response"] = lambda: {"mdnsDomain": "renamed.local"}
        self.server["kubernetes_access_info"] = self.originals["kubernetes_access_info"]

        self.assertEqual(self.server["kubernetes_access_info"](), {"configured": False})
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["kubernetes_access_info"](required=True)
        self.assertEqual(raised.exception.status, 409)

    def test_cluster_configuration_rewrites_appliance_mdns_endpoint_to_control_plane_ip(self):
        self.server["request_json"] = lambda method, path: {
            "data": {
                "enabled": "true",
                "issuer-url": "https://id.magicstick.local/realms/magicstick",
                "client-id": "magicstick-kubernetes",
                "api-server": "https://magicstick.local:6443",
                "oidc-ca.crt": "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
            }
        }
        self.server["list_resource"] = lambda path: [{
            "metadata": {
                "name": "appliance",
                "labels": {"node-role.kubernetes.io/control-plane": "true"},
            },
            "status": {
                "conditions": [{"type": "Ready", "status": "True"}],
                "addresses": [{"type": "InternalIP", "address": "192.0.2.44"}],
            },
        }]
        self.server["settings_response"] = lambda: {"mdnsDomain": "magicstick.local"}
        self.server["kubernetes_access_info"] = self.originals["kubernetes_access_info"]

        result = self.server["kubernetes_access_info"](required=True)

        self.assertEqual(result["apiServer"], "https://192.0.2.44:6443")

    def test_cluster_configuration_preserves_platform_managed_api_endpoint(self):
        self.server["request_json"] = lambda method, path: {
            "data": {
                "enabled": "true",
                "issuer-url": "https://id.magicstick.local/realms/magicstick",
                "client-id": "magicstick-kubernetes",
                "api-server": "https://kubernetes-api.example.com:6443",
                "oidc-ca.crt": "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
            }
        }
        self.server["list_resource"] = lambda path: self.fail("managed endpoints must not inspect nodes")
        self.server["settings_response"] = lambda: {"mdnsDomain": "magicstick.local"}
        self.server["kubernetes_access_info"] = self.originals["kubernetes_access_info"]

        result = self.server["kubernetes_access_info"](required=True)

        self.assertEqual(result["apiServer"], "https://kubernetes-api.example.com:6443")

    def test_cluster_configuration_rejects_unsafe_endpoint_and_private_key_material(self):
        self.server["request_json"] = lambda method, path: {
            "data": {
                "enabled": "true",
                "issuer-url": "https://id.magicstick.local/realms/magicstick",
                "client-id": "magicstick-kubernetes",
                "api-server": "https://user@example.com:6443",
                "oidc-ca.crt": "-----BEGIN CERTIFICATE-----\n" + "PRIVATE" + " KEY\nNOPE",
            }
        }
        self.server["settings_response"] = lambda: {"mdnsDomain": "magicstick.local"}
        self.server["kubernetes_access_info"] = self.originals["kubernetes_access_info"]

        self.assertEqual(self.server["kubernetes_access_info"](), {"configured": False})

    def test_group_replacement_removes_other_levels_and_is_reversible(self):
        ids = {
            "magicstick-kubernetes-viewer": "viewer-id",
            "magicstick-kubernetes-operator": "operator-id",
            "magicstick-kubernetes-admin": "admin-id",
        }
        memberships = {"magicstick-kubernetes-viewer"}
        self.server["_kubernetes_access_group"] = lambda name: {
            "id": ids[name],
            "name": name,
            "path": "/" + name,
        }
        self.server["keycloak_user_groups"] = lambda _user_id: [
            {"id": ids[name], "name": name, "path": "/" + name}
            for name in sorted(memberships)
        ]

        def request(method, path, body=None):
            group_id = path.rsplit("/", 1)[-1]
            name = next(name for name, candidate in ids.items() if candidate == group_id)
            if method == "PUT":
                memberships.add(name)
            elif method == "DELETE":
                memberships.discard(name)
            return {}, {}

        self.server["keycloak_admin_request"] = request
        self.server["_replace_kubernetes_access_groups"] = self.originals["_replace_kubernetes_access_groups"]

        self.server["_replace_kubernetes_access_groups"]("user-id", "operator")
        self.assertEqual(memberships, {"magicstick-kubernetes-operator"})
        self.server["_replace_kubernetes_access_groups"]("user-id", "none")
        self.assertEqual(memberships, set())

    def test_update_logs_out_changed_user_and_rejects_disabled_grants(self):
        replacements = []
        logouts = []
        self.server["_direct_kubernetes_groups"] = lambda _user_id: {
            "magicstick-kubernetes-viewer": {"id": "viewer-id"}
        }
        self.server["_replace_kubernetes_access_groups"] = lambda user_id, level: replacements.append((user_id, level))
        self.server["_logout_user"] = lambda user_id: logouts.append(user_id)
        self.server["_kubernetes_user_summary"] = lambda _user: {
            "id": "user-id", "username": "alice", "enabled": True, "accessLevel": "operator"
        }

        result = self.server["update_kubernetes_access"](
            self.principal,
            "user-id",
            {"accessLevel": "operator"},
            "request-id",
        )

        self.assertEqual(result["accessLevel"], "operator")
        self.assertEqual(replacements, [("user-id", "operator")])
        self.assertEqual(logouts, ["user-id"])

        self.user["enabled"] = False
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["update_kubernetes_access"](
                self.principal,
                "user-id",
                {"accessLevel": "viewer"},
            )
        self.assertEqual(raised.exception.status, 409)

    def test_downloaded_kubeconfig_has_oidc_exec_but_no_credential(self):
        self.server["_kubernetes_user_summary"] = lambda _user: {
            "id": "user-id", "username": "alice", "enabled": True, "accessLevel": "operator"
        }
        self.server["kubernetes_access_info"] = lambda required=False: {
            "configured": True,
            "issuerUrl": "https://id.magicstick.local/realms/magicstick",
            "clientId": "magicstick-kubernetes",
            "apiServer": "https://192.0.2.44:6443",
            "oidcCa": "-----BEGIN CERTIFICATE-----\nOIDC-CA\n-----END CERTIFICATE-----\n",
        }
        self.server["_base64_file"] = lambda _path: "S1VCRVJORVRFUy1DQQ=="

        result = self.server["kubernetes_access_kubeconfig"](self.principal, "user-id")
        content = result["content"]

        self.assertEqual(result["filename"], "magicstick-alice.kubeconfig")
        self.assertIn("client.authentication.k8s.io/v1", content)
        self.assertIn("kubectl", content)
        self.assertIn("oidc-login", content)
        self.assertIn("--oidc-client-id=magicstick-kubernetes", content)
        self.assertIn("--oidc-pkce-method=S256", content)
        self.assertIn("--token-cache-storage=keyring", content)
        self.assertIn("certificate-authority-data", content)
        self.assertNotIn("client-secret", content)
        self.assertNotIn("password", content.lower())
        self.assertNotIn("bearer", content.lower())
        parsed = yaml.safe_load(content)
        self.assertEqual(parsed["current-context"], "alice@magicstick@magicstick")
        self.assertEqual(parsed["clusters"][0]["cluster"]["server"], "https://192.0.2.44:6443")
        self.assertEqual(content.count("      server: "), 1)
        self.assertEqual(parsed["users"][0]["user"]["exec"]["interactiveMode"], "IfAvailable")


class UserAdministrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "keycloak_admin_token",
            "_keycloak_http_request",
            "keycloak_admin_request",
            "request_json",
            "authenticated_principal",
            "keycloak_user",
            "keycloak_user_roles",
            "keycloak_user_groups",
            "keycloak_federated_identities",
            "identity_source",
            "live_admin_actor",
            "_all_human_users",
            "_keycloak_raw_user_page",
            "_keycloak_user_page",
            "_keycloak_user_count",
            "user_summary",
            "_exact_user_matches",
            "_realm_role",
            "_replace_managed_roles",
            "_logout_user",
            "_enabled_admin_counts",
            "_ensure_admins_survive",
            "audit_user_action",
        )
        self.originals = {name: self.server[name] for name in names}
        self.original_mode = self.server["IDENTITY_MANAGEMENT_MODE"]
        self.original_origins = self.server["DASHBOARD_ALLOWED_ORIGINS"]
        self.server["audit_user_action"] = lambda *_args, **_kwargs: None
        self.principal = {"subject": "actor-id", "username": "admin", "roles": ["magicstick-admin"]}

    def tearDown(self):
        self.server.update(self.originals)
        self.server["IDENTITY_MANAGEMENT_MODE"] = self.original_mode
        self.server["DASHBOARD_ALLOWED_ORIGINS"] = self.original_origins

    @staticmethod
    def user(user_id="target-id", username="target", enabled=True, **extra):
        value = {
            "id": user_id,
            "username": username,
            "enabled": enabled,
            "firstName": "Target",
            "lastName": "User",
            "email": "target@example.com",
            "emailVerified": True,
            "createdTimestamp": 1234,
        }
        value.update(extra)
        return value

    def test_service_accounts_are_detected_by_field_and_username(self):
        self.assertTrue(self.server["is_service_account_user"]({"serviceAccountClientId": "client"}))
        self.assertTrue(self.server["is_service_account_user"]({"username": "service-account-client"}))
        self.assertFalse(self.server["is_service_account_user"]({"username": "regular-user"}))

        self.server["keycloak_admin_request"] = lambda *_args: (
            {"id": "service-id", "username": "service-account-hidden"},
            {},
        )
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["keycloak_user"]("service-id")
        self.assertEqual(raised.exception.status, 404)

    def test_admin_access_is_rejected_for_viewer_and_operator(self):
        for role in ("magicstick-viewer", "magicstick-operator"):
            self.server["authenticated_principal"] = lambda _authorization, role=role: {
                "subject": "non-admin",
                "username": "non-admin",
                "roles": [role],
            }
            with self.assertRaises(self.server["AuthError"]) as raised:
                self.server["authorize"]("Bearer token", "admin")
            self.assertEqual(raised.exception.status, 403)

        self.server["authenticated_principal"] = lambda _authorization: self.principal
        self.assertEqual(
            self.server["authorize"]("Bearer token", "admin")["subject"],
            "actor-id",
        )

    def test_keycloak_credentials_are_read_from_only_the_named_kubernetes_secret(self):
        requested = []
        encoded_client_id = base64.b64encode(b"magicstick-user-admin").decode("ascii")
        encoded_client_secret = base64.b64encode(b"test-value").decode("ascii")

        def request_json(method, path, body=None, content_type="application/json"):
            requested.append((method, path))
            return {
                "data": {
                    "client-id": encoded_client_id,
                    "client-secret": encoded_client_secret,
                }
            }

        self.server["request_json"] = request_json

        client_id, client_secret = self.server["keycloak_client_credentials"]()

        self.assertEqual(client_id, "magicstick-user-admin")
        self.assertEqual(client_secret, "test-value")
        self.assertEqual(
            requested,
            [("GET", "/api/v1/namespaces/identity-system/secrets/magicstick-user-admin-client")],
        )

    def test_keycloak_error_mapping_never_returns_upstream_body(self):
        upstream = urllib.error.HTTPError(
            "/admin/test",
            500,
            "upstream failed",
            {},
            io.BytesIO(b'{"client_secret":"must-not-leak"}'),
        )

        mapped = self.server["_mapped_keycloak_error"](upstream)

        self.assertEqual(mapped.status, 503)
        self.assertNotIn("must-not-leak", str(mapped))

    def test_list_users_forwards_pagination_and_search_to_keycloak(self):
        calls = []
        actor = self.user("actor-id", "admin")
        selected = self.user("user-2", "alice")
        self.server["live_admin_actor"] = lambda principal: actor
        self.server["_keycloak_user_page"] = lambda first, maximum, search: (
            calls.append((first, maximum, search)) or [selected]
        )
        self.server["_keycloak_user_count"] = lambda search: 7
        self.server["keycloak_user"] = lambda _user_id: selected
        self.server["user_summary"] = lambda user, actor_id: {"id": user["id"], "actor": actor_id}

        result = self.server["list_users"](
            self.principal,
            {"first": ["2"], "max": ["1"], "search": ["ali"]},
        )

        self.assertEqual(calls, [(2, 1, "ali")])
        self.assertEqual(result["total"], 7)
        self.assertEqual(result["users"], [{"id": "user-2", "actor": "actor-id"}])

    def test_user_pagination_uses_human_offsets_around_service_accounts(self):
        service_one = self.user("service-1", "service-account-first")
        service_two = self.user("service-2", "service-account-second")
        alice = self.user("alice-id", "alice")
        bob = self.user("bob-id", "bob")
        calls = []

        def raw_page(first, maximum, search=""):
            calls.append((first, maximum, search))
            return [service_one, alice, service_two, bob]

        self.server["_keycloak_raw_user_page"] = raw_page

        result = self.server["_keycloak_user_page"](1, 1, "")

        self.assertEqual([user["username"] for user in result], ["bob"])
        self.assertEqual(calls, [(0, 100, "")])

    def test_brokered_user_has_read_only_profile_and_no_password_or_delete(self):
        brokered = self.user(
            federatedIdentities=[{"identityProvider": "entra", "userId": "external-id"}],
        )
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "role-user", "name": "magicstick-user"},
            *([{"id": "role-viewer", "name": "magicstick-viewer"}] if effective else []),
        ]
        self.server["keycloak_user_groups"] = lambda _user_id: []

        result = self.server["user_summary"](brokered, "actor-id")

        self.assertEqual(result["source"], "brokered")
        self.assertEqual(result["provider"], "entra")
        self.assertEqual(result["directRoles"], ["magicstick-user"])
        self.assertEqual(result["effectiveAccessLevel"], "viewer")
        self.assertFalse(result["capabilities"]["canEditProfile"])
        self.assertFalse(result["capabilities"]["canResetPassword"])
        self.assertFalse(result["capabilities"]["canDelete"])
        self.assertTrue(result["capabilities"]["canManageRoles"])

    def test_exact_recovery_group_marks_user_protected_without_exposing_group(self):
        recovery = self.user("recovery-id", "recovery", enabled=False)
        self.server["identity_source"] = lambda _user: ("local", "local")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "user", "name": "magicstick-user"},
            {"id": "admin", "name": "magicstick-admin"},
        ]
        self.server["keycloak_user_groups"] = lambda _user_id: [{
            "id": "recovery-group",
            "name": "magicstick-recovery",
            "path": "/magicstick-recovery",
        }]

        result = self.server["user_summary"](recovery, "actor-id")

        self.assertTrue(result["capabilities"]["isProtected"])
        self.assertFalse(result["capabilities"]["canEditProfile"])
        self.assertFalse(result["capabilities"]["canManageRoles"])
        self.assertFalse(result["capabilities"]["canEnable"])
        self.assertFalse(result["capabilities"]["canResetPassword"])
        self.assertFalse(result["capabilities"]["canDelete"])
        self.assertNotIn("groups", result)
        self.assertNotIn("magicstick-recovery", str(result))

    def test_nested_group_with_same_name_does_not_mark_recovery_user(self):
        candidate = self.user("candidate-id", "candidate")

        protected = self.server["protected_user"](candidate, [{
            "id": "nested-group",
            "name": "magicstick-recovery",
            "path": "/other/magicstick-recovery",
        }])

        self.assertFalse(protected)

    def test_recovery_membership_uses_exact_direct_group_endpoint(self):
        requested = []

        def request(method, path, body=None):
            requested.append((method, path, body))
            return [{
                "id": "recovery-group",
                "name": "magicstick-recovery",
                "path": "/magicstick-recovery",
            }], {}

        self.server["keycloak_admin_request"] = request

        groups = self.server["keycloak_user_groups"]("target-id")

        self.assertEqual(groups[0]["path"], "/magicstick-recovery")
        self.assertEqual(requested, [(
            "GET",
            "/admin/realms/magicstick/users/target-id/groups?briefRepresentation=true&first=0&max=100",
            None,
        )])

    def test_recovery_group_lookup_failure_blocks_mutation_fail_closed(self):
        target = self.user("target-id", "target", enabled=True)
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target

        def unavailable(_user_id):
            raise self.server["RequestError"](503, "identity administration is unavailable")

        self.server["keycloak_user_groups"] = unavailable
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["set_user_enabled"](self.principal, "target-id", False)

        self.assertEqual(raised.exception.status, 503)

    def test_recovery_access_update_is_blocked_even_when_target_stays_admin(self):
        target = self.user("recovery-id", "recovery", enabled=True)
        observed = {"groupReads": 0, "roleWrites": []}
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "user", "name": "magicstick-user"},
            {"id": "admin", "name": "magicstick-admin"},
        ]

        def groups(_user_id):
            observed["groupReads"] += 1
            return [{
                "id": "recovery-group",
                "name": "magicstick-recovery",
                "path": "/magicstick-recovery",
            }]

        self.server["keycloak_user_groups"] = groups
        self.server["_replace_managed_roles"] = lambda _user_id, roles: observed["roleWrites"].append(set(roles))
        self.server["_logout_user"] = lambda _user_id: None
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["update_user_roles"](
                self.principal,
                "recovery-id",
                {"accessLevel": "admin"},
            )

        self.assertGreaterEqual(observed["groupReads"], 1)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(observed["roleWrites"], [])

    def test_live_actor_recheck_rejects_demoted_admin(self):
        self.server["keycloak_user"] = lambda _user_id: self.user("actor-id", "admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "role-user", "name": "magicstick-user"}
        ]

        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["live_admin_actor"](self.principal)

        self.assertEqual(raised.exception.status, 403)

    def test_keycloak_request_refreshes_token_once_after_unauthorized(self):
        forced = []
        attempts = []

        def admin_token(force_refresh=False):
            forced.append(force_refresh)
            return "new-token" if force_refresh else "old-token"

        def http_request(method, path, access_token=None, body=None):
            attempts.append(access_token)
            if access_token == "old-token":
                raise urllib.error.HTTPError(path, 401, "unauthorized", {}, io.BytesIO(b"secret details"))
            return {"ok": True}, {}

        self.server["keycloak_admin_token"] = admin_token
        self.server["_keycloak_http_request"] = http_request

        result, _ = self.server["keycloak_admin_request"]("GET", "/admin/test")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(forced, [False, True])
        self.assertEqual(attempts, ["old-token", "new-token"])

    def test_role_update_preserves_unmanaged_roles(self):
        assigned = {
            "magicstick-user": {"id": "user", "name": "magicstick-user"},
            "unmanaged": {"id": "foreign", "name": "unmanaged"},
        }
        requests = []

        def roles(_user_id, effective=False):
            return list(assigned.values())

        def role(name):
            return {"id": name, "name": name}

        def request(method, path, body=None):
            requests.append((method, path, body))
            if method == "POST":
                for item in body:
                    assigned[item["name"]] = item
            elif method == "DELETE":
                for item in body:
                    assigned.pop(item["name"], None)
            return {}, {}

        self.server["keycloak_user_roles"] = roles
        self.server["_realm_role"] = role
        self.server["keycloak_admin_request"] = request

        self.server["_replace_managed_roles"](
            "target-id",
            {"magicstick-user", "magicstick-admin"},
        )

        self.assertIn("unmanaged", assigned)
        self.assertIn("magicstick-admin", assigned)
        removed = [item["name"] for method, _path, body in requests if method == "DELETE" for item in body]
        self.assertNotIn("unmanaged", removed)

    def test_create_user_orders_disabled_password_roles_then_enable(self):
        calls = []
        created = self.user("new-id", "alice")
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["_exact_user_matches"] = lambda _field, _value: []

        def request(method, path, body=None):
            if method == "POST" and path.endswith("/users"):
                calls.append("create-disabled:" + str(body["enabled"]).lower())
                return {}, {"Location": "http://keycloak/admin/realms/magicstick/users/new-id"}
            if path.endswith("/reset-password"):
                calls.append("password-temporary:" + str(body["temporary"]).lower())
            elif method == "PUT" and path.endswith("/users/new-id"):
                calls.append("enable:" + str(body["enabled"]).lower())
            return {}, {}

        self.server["keycloak_admin_request"] = request
        self.server["_replace_managed_roles"] = lambda _user_id, roles: calls.append(
            "roles:" + ",".join(sorted(roles))
        )
        self.server["keycloak_user"] = lambda _user_id: created
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"], "username": user["username"]}

        result = self.server["create_user"](
            self.principal,
            {
                "username": "alice",
                "firstName": "Alice",
                "lastName": "Example",
                "email": "alice@example.com",
                "accessLevel": "operator",
                "password": "a-secure-temporary-password",
                "temporary": True,
                "enabled": True,
            },
        )

        self.assertEqual(
            calls,
            [
                "create-disabled:false",
                "password-temporary:true",
                "roles:magicstick-operator,magicstick-user",
                "enable:true",
            ],
        )
        self.assertEqual(result, {"id": "new-id", "username": "alice"})
        self.assertNotIn("password", result)

    def test_password_validation_preserves_leading_and_trailing_spaces(self):
        password = "  edge spaces stay  "

        validated = self.server["_validated_password"]({
            "password": password,
            "temporary": True,
        })

        self.assertEqual(validated, password)

    def test_create_user_rolls_back_after_partial_failure(self):
        calls = []
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["_exact_user_matches"] = lambda _field, _value: []

        def request(method, path, body=None):
            calls.append((method, path))
            if method == "POST" and path.endswith("/users"):
                return {}, {"Location": "http://keycloak/admin/realms/magicstick/users/new-id"}
            if path.endswith("/reset-password"):
                raise self.server["RequestError"](503, "identity administration is unavailable")
            return {}, {}

        self.server["keycloak_admin_request"] = request

        with self.assertRaises(self.server["RequestError"]):
            self.server["create_user"](
                self.principal,
                {
                    "username": "alice",
                    "email": "alice@example.com",
                    "accessLevel": "user",
                    "password": "a-secure-temporary-password",
                },
            )

        self.assertIn(("DELETE", "/admin/realms/magicstick/users/new-id"), calls)

    def test_self_disable_is_blocked_before_write(self):
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: self.user("actor-id", "admin")
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["set_user_enabled"](self.principal, "actor-id", False)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("own account", str(raised.exception))

    def test_disable_writes_disabled_state_before_logging_out_sessions(self):
        calls = []
        target = self.user("target-id", "target", enabled=True)
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: []
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["_ensure_admins_survive"] = lambda _target: None
        self.server["keycloak_admin_request"] = lambda method, path, body=None: (
            calls.append(("write", method, body)) or ({}, {})
        )
        self.server["_logout_user"] = lambda _user_id: calls.append(("logout",))
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        self.server["set_user_enabled"](self.principal, "target-id", False)

        self.assertEqual(calls[0], ("write", "PUT", {"enabled": False}))
        self.assertEqual(calls[1], ("logout",))

    def test_recovery_group_blocks_enable_and_disable_mutations(self):
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user_groups"] = lambda _user_id: [{
            "id": "recovery-group",
            "name": "magicstick-recovery",
            "path": "/magicstick-recovery",
        }]
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        for current, requested in ((True, False), (False, True)):
            with self.subTest(current=current, requested=requested):
                target = self.user("recovery-id", "recovery", enabled=current)
                self.server["keycloak_user"] = lambda _user_id, target=target: target
                with self.assertRaises(self.server["RequestError"]) as raised:
                    self.server["set_user_enabled"](self.principal, "recovery-id", requested)

                self.assertEqual(raised.exception.status, 409)
                self.assertIn("recovery", str(raised.exception))

    def test_last_local_administrator_is_protected(self):
        target = self.user("target-id", "last-admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "admin", "name": "magicstick-admin"}
        ]
        self.server["_enabled_admin_counts"] = lambda _excluding: (0, 0)

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["_ensure_admins_survive"](target)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("last enabled administrator", str(raised.exception))

    def test_local_break_glass_admin_is_required_even_with_external_admin(self):
        target = self.user("target-id", "last-local-admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "admin", "name": "magicstick-admin"}
        ]
        self.server["_enabled_admin_counts"] = lambda _excluding: (1, 0)
        self.server["identity_source"] = lambda _user: ("local", "local")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["_ensure_admins_survive"](target)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("last enabled local administrator", str(raised.exception))

    def test_user_mutations_are_serialized(self):
        state = {"active": 0, "maximum": 0}
        state_lock = threading.Lock()
        errors = []

        def live_actor(_principal):
            with state_lock:
                state["active"] += 1
                state["maximum"] = max(state["maximum"], state["active"])
            time.sleep(0.03)
            with state_lock:
                state["active"] -= 1
            return self.user("actor-id", "admin")

        self.server["live_admin_actor"] = live_actor
        self.server["keycloak_user"] = lambda user_id: self.user(user_id, user_id, enabled=False)
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: ({}, {})
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        def mutate(user_id):
            try:
                self.server["set_user_enabled"](self.principal, user_id, True)
            except Exception as error:  # pragma: no cover - assertion reports details below
                errors.append(error)

        threads = [threading.Thread(target=mutate, args=(user_id,)) for user_id in ("one", "two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(state["maximum"], 1)

    def test_external_password_reset_is_rejected_without_sending_password(self):
        target = self.user(
            "external-id",
            "external",
            federatedIdentities=[{"identityProvider": "entra"}],
        )
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["reset_user_password"](
                self.principal,
                "external-id",
                {"password": "a-secure-temporary-password", "temporary": True},
            )

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("external identity provider", str(raised.exception))

    def test_delete_requires_exact_username_confirmation(self):
        target = self.user("target-id", "alice")
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["delete_user"](
                self.principal,
                "target-id",
                {"usernameConfirmation": "bob"},
            )

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("confirmation", str(raised.exception))

    def test_request_body_is_limited_and_requires_json(self):
        class Handler:
            def __init__(self, headers, body=b""):
                self.headers = headers
                self.rfile = io.BytesIO(body)

        with self.assertRaises(self.server["RequestError"]) as too_large:
            self.server["read_body"](Handler({"Content-Length": str(64 * 1024 + 1)}))
        self.assertEqual(too_large.exception.status, 413)

        raw = b'{"enabled":true}'
        with self.assertRaises(self.server["RequestError"]) as wrong_type:
            self.server["read_body"](Handler({"Content-Length": str(len(raw)), "Content-Type": "text/plain"}, raw))
        self.assertEqual(wrong_type.exception.status, 415)

    def test_mutations_require_csrf_header_and_same_origin(self):
        class Handler:
            def __init__(self, headers):
                self.headers = headers

        with self.assertRaises(self.server["AuthError"]) as missing:
            self.server["validate_user_mutation_request"](Handler({"Host": "magicstick.local"}))
        self.assertEqual(missing.exception.status, 403)

        with self.assertRaises(self.server["AuthError"]) as cross_site:
            self.server["validate_user_mutation_request"](Handler({
                "X-MagicStick-CSRF": "dashboard",
                "Sec-Fetch-Site": "cross-site",
                "Origin": "https://attacker.example.com",
                "Host": "magicstick.local",
            }))
        self.assertEqual(cross_site.exception.status, 403)

        self.server["validate_user_mutation_request"](Handler({
            "X-MagicStick-CSRF": "dashboard",
            "Sec-Fetch-Site": "same-origin",
            "Origin": "https://magicstick.local",
            "Host": "magicstick.local",
        }))

    def test_mutations_accept_configured_local_and_public_origins_behind_http_nginx(self):
        class Handler:
            def __init__(self, origin, host):
                self.headers = {
                    "X-MagicStick-CSRF": "dashboard",
                    "Sec-Fetch-Site": "same-origin",
                    "Origin": origin,
                    "X-Forwarded-Host": host,
                    # Envoy terminates TLS before the dashboard nginx proxy, so
                    # nginx observes HTTP even though the browser origin is HTTPS.
                    "X-Forwarded-Proto": "http",
                }

        self.server["DASHBOARD_ALLOWED_ORIGINS"] = {
            "https://magicstick.local",
            "https://magicstick.example.com",
        }

        for origin in self.server["DASHBOARD_ALLOWED_ORIGINS"]:
            with self.subTest(origin=origin):
                self.server["validate_user_mutation_request"](
                    Handler(origin, origin.removeprefix("https://"))
                )

    def test_direct_external_mode_disables_identity_management(self):
        self.server["IDENTITY_MANAGEMENT_MODE"] = "direct-external"

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_identity_management"]()

        self.assertEqual(raised.exception.status, 503)


if __name__ == "__main__":
    unittest.main()
