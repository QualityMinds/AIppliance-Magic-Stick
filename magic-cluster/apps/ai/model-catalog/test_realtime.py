import copy
import json
import unittest
from unittest.mock import patch
from test_controller import load_controller


def activation():
    return {"metadata": {"name": "qwen-realtime", "generation": 1}, "spec": {
        "type": "local", "enabled": True, "targetNamespace": "ai", "local": {
            "engine": "VLLM", "realtime": {"profile": "qwen3-omni"}, "contextWindow": 8192}},
        "status": {"phase": "Ready", "observedGeneration": 1, "runtimeEndpoint": "http://qwen-realtime-realtime.ai.svc.cluster.local:8000/v1"}}


class RealtimeCatalogTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()

    def test_routes_directly_to_omni_and_appears_in_realtime_playground(self):
        result = self.c["direct_runtime_deployment"](activation())
        self.assertEqual(result["model_info"]["mode"], "realtime")
        self.assertEqual(result["model_info"]["ai_appliance_type"], "realtime")
        self.assertTrue(result["model_info"]["supports_audio_output"])
        self.assertEqual(result["litellm_params"]["model"], "openai/qwen-realtime")
        self.assertEqual(result["litellm_params"]["api_base"], activation()["status"]["runtimeEndpoint"])
        self.assertNotIn("kubeai", result["litellm_params"]["api_base"])
        data, _ = self.c["build_catalog"]([result])
        self.assertEqual(json.loads(data["chat-models.json"])["models"], [])

    def test_disabled_failed_starting_and_external_endpoints_are_not_published(self):
        for changes in ({"phase": "Starting"}, {"phase": "Degraded"}, {"runtimeEndpoint": "https://example.com/v1"}):
            item = activation()
            item["status"].update(changes)
            self.assertIsNone(self.c["direct_runtime_deployment"](item))
        item = activation()
        item["spec"]["enabled"] = False
        self.assertIsNone(self.c["direct_runtime_deployment"](item))

    def test_route_is_withdrawn_when_stopped_without_removing_other_models(self):
        item = activation()
        item["spec"]["enabled"] = False
        existing = self.c["direct_runtime_deployment"](activation())
        writes = []
        with patch.dict(self.c, {"list_kubeai_models": lambda: [], "read_external_models": lambda: [],
                                "read_model_activations": lambda: [item], "fetch_litellm_models": lambda: [existing],
                                "litellm_request": lambda *args: writes.append(args) or {}}):
            self.c["sync_litellm"]()
        self.assertIn(("POST", "/model/delete", {"id": existing["model_info"]["id"]}), writes)

    def test_old_readiness_cannot_publish_new_configuration(self):
        item = activation()
        item["metadata"]["generation"] = 2
        self.assertIsNone(self.c["direct_runtime_deployment"](item))
        item["status"]["observedGeneration"] = 2
        self.assertIsNotNone(self.c["direct_runtime_deployment"](item))


if __name__ == "__main__":
    unittest.main()
