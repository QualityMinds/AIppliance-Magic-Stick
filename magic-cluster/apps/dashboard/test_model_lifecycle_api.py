import copy
import unittest
from unittest.mock import patch

from test_dashboard_api import load_server


def freetoken_activation(revision="17", enabled=False):
    return {
        "metadata": {"name": "freetoken-chat", "resourceVersion": revision},
        "spec": {
            "type": "local",
            "enabled": enabled,
            "targetNamespace": "ai",
            "local": {
                "engine": "FreeToken",
                "computeTarget": "nvidia-gpu",
                "url": "hf://Qwen/Qwen3-8B",
                "freetoken": {
                    "gpuDevice": "node:gpu-node",
                    "gpuMemoryMi": 16384,
                    "systemMemoryMi": 8192,
                    "memoryStrategy": "auto",
                    "advanced": {"cacheType": "radix"},
                },
            },
        },
    }


def vllm_activation():
    return {
        "metadata": {"name": "vllm-chat", "resourceVersion": "17"},
        "spec": {
            "type": "local",
            "enabled": True,
            "local": {"engine": "VLLM", "url": "hf://Qwen/Qwen3-8B"},
        },
    }


class ModelLifecycleApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def setUp(self):
        self.writes = []

    def patch_action(self, activation):
        return patch.dict(self.api, {
            "model_activation": lambda _name: activation,
            "request_json": lambda *args: self.writes.append(args) or args[2],
        })

    def test_retired_engine_cannot_be_created_discovered_or_estimated(self):
        for engine in ("FreeToken", "freetoken", "FREETOKEN"):
            local = {"engine": engine, "computeTarget": "nvidia-gpu", "url": "hf://example/model"}
            for operation in (
                lambda: self.api["model_activation_payload"]("local", {"name": "retired", "local": local}),
                lambda: self.api["estimate_model_memory"](local),
                lambda: self.api["hf_discovery_context"]({"engine": [engine]}),
            ):
                with self.subTest(engine=engine), self.assertRaises(self.api["RequestError"]) as raised:
                    operation()
                self.assertEqual(raised.exception.status, 400)

    def test_retired_settings_cannot_be_inherited_by_supported_engines(self):
        for engine in ("VLLM", "OLlama"):
            with self.subTest(engine=engine), self.assertRaisesRegex(self.api["RequestError"], "removed"):
                self.api["model_activation_payload"]("local", {"name": "example", "local": {
                    "engine": engine, "freetoken": {"gpuMemoryMi": 16384},
                }})

    def test_retired_model_can_stop_but_cannot_start_or_restart(self):
        current = freetoken_activation(enabled=True)
        saved = copy.deepcopy(current)
        with self.patch_action(current):
            for action in ("start", "restart"):
                with self.subTest(action=action), self.assertRaisesRegex(self.api["RequestError"], "unsupported local engine"):
                    self.api["model_lifecycle_action"]("freetoken-chat", action, {"expectedRevision": "17"})
            self.assertEqual(self.writes, [])
            self.api["model_lifecycle_action"]("freetoken-chat", "stop", {"expectedRevision": "17"})
        self.assertEqual(self.writes[0][2]["spec"], {"enabled": False})
        self.assertEqual(current, saved)

    def test_restart_rejects_ordinary_models_without_writing(self):
        with self.patch_action(vllm_activation()):
            with self.assertRaisesRegex(self.api["RequestError"], "Realtime") as raised:
                self.api["model_lifecycle_action"]("vllm-chat", "restart", {"expectedRevision": "17"})

        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.writes, [])

    def test_stop_and_start_toggle_only_the_durable_enabled_flag(self):
        activations = []
        for engine in ("VLLM", "OLlama"):
            for target in ("cpu", "nvidia-gpu", "amd-gpu"):
                activation = vllm_activation()
                activation["spec"]["local"].update(
                    engine=engine, computeTarget=target, contextWindow=4096,
                    maxNumSeqs=2, vramMi=8192,
                    cpuResources={"requestMillicores": 1000, "limitMillicores": 2000},
                )
                activations.append(activation)
        activations.append({
            "metadata": {"name": "external-chat", "resourceVersion": "17"},
            "spec": {"type": "external", "enabled": True, "external": {
                "provider": "openai-compatible", "model": "provider/model",
                "apiBase": "https://api.example.com/v1",
                "apiKeySecretRef": {"name": "example-provider-key", "key": "api-key"},
            }},
        })
        for activation in activations:
            for action, expected_enabled in (("stop", False), ("start", True)):
                activation["spec"]["enabled"] = not expected_enabled
                original = copy.deepcopy(activation)
                name = activation["metadata"]["name"]
                with self.subTest(spec=activation["spec"], action=action), self.patch_action(activation):
                    result = self.api["model_lifecycle_action"](
                        name, action, {"expectedRevision": "17"}
                    )

                self.assertEqual(result["action"], action)
                method, path, body, content_type = self.writes[-1]
                self.assertEqual(method, "PATCH")
                self.assertTrue(path.endswith("/modelactivations/" + name))
                self.assertEqual(content_type, "application/merge-patch+json")
                self.assertEqual(body["metadata"]["resourceVersion"], "17")
                self.assertEqual(body["spec"], {"enabled": expected_enabled})
                self.assertEqual(activation, original)

    def test_start_and_stop_reject_deleting_or_missing_activations(self):
        deleting = vllm_activation()
        deleting["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
        for action in ("start", "stop"):
            for activation, status in ((None, 404), (deleting, 409)):
                with self.subTest(action=action, status=status), self.patch_action(activation):
                    with self.assertRaises(self.api["RequestError"]) as raised:
                        self.api["model_lifecycle_action"]("vllm-chat", action, {"expectedRevision": "17"})
                    self.assertEqual(raised.exception.status, status)
        self.assertEqual(self.writes, [])

    def test_stale_revision_is_rejected_for_every_lifecycle_action(self):
        for action in ("start", "stop", "restart"):
            with self.subTest(action=action), self.patch_action(freetoken_activation()):
                with self.assertRaisesRegex(self.api["RequestError"], "changed after") as raised:
                    self.api["model_lifecycle_action"](
                        "freetoken-chat", action, {"expectedRevision": "old"}
                    )

            self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.writes, [])

    def test_lifecycle_uses_configuration_generation_not_background_status_revision(self):
        current = vllm_activation()
        current["metadata"]["resourceVersion"] = "29"
        current["metadata"].update(uid="example-model-uid", generation=3)
        for action in ("start", "stop"):
            with self.subTest(action=action), self.patch_action(current):
                self.api["model_lifecycle_action"]("vllm-chat", action, {
                    "expectedRevision": "generation:example-model-uid:3",
                })
                self.assertEqual(self.writes[-1][2]["metadata"]["resourceVersion"], "29")
                with self.assertRaisesRegex(self.api["RequestError"], "changed after"):
                    self.api["model_lifecycle_action"]("vllm-chat", action, {
                        "expectedRevision": "generation:example-model-uid:2",
                    })


if __name__ == "__main__":
    unittest.main()
