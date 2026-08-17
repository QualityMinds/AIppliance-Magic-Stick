import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent


def load_controller():
    source = (ROOT / "controller.py").read_text(encoding="utf-8").replace(
        "K8S_SSL = ssl.create_default_context(cafile=SA_CA_PATH)",
        "K8S_SSL = None",
    )
    namespace = {"__name__": "model_catalog_controller_test"}
    exec(compile(source, "controller.py", "exec"), namespace)
    return namespace


class KubeAIReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def setUp(self):
        self.originals = {
            "list_kubeai_models": self.controller["list_kubeai_models"],
            "read_external_models": self.controller["read_external_models"],
            "read_model_activations": self.controller["read_model_activations"],
            "fetch_litellm_models": self.controller["fetch_litellm_models"],
            "litellm_request": self.controller["litellm_request"],
        }
        self.controller["read_external_models"] = lambda: []
        self.controller["read_model_activations"] = lambda: []

    def tearDown(self):
        self.controller.update(self.originals)

    @staticmethod
    def kubeai_model(ready):
        return {
            "metadata": {"name": "local-chat"},
            "spec": {"features": ["TextGeneration"]},
            "status": {"replicas": {"all": 1, "ready": ready}},
        }

    def test_unready_kubeai_model_is_not_published_to_litellm(self):
        self.controller["list_kubeai_models"] = lambda: [self.kubeai_model(0)]

        deployments = self.controller["desired_deployments"]()

        self.assertNotIn("local-chat", deployments)

    def test_ready_kubeai_model_is_published_to_litellm(self):
        self.controller["list_kubeai_models"] = lambda: [self.kubeai_model(1)]

        deployments = self.controller["desired_deployments"]()

        self.assertIn("local-chat", deployments)
        self.assertEqual(deployments["local-chat"]["litellm_params"]["model"], "openai/local-chat")

    def test_external_activation_is_unchanged_while_local_model_starts(self):
        self.controller["list_kubeai_models"] = lambda: [self.kubeai_model(0)]
        self.controller["read_model_activations"] = lambda: [
            {
                "metadata": {"name": "remote-chat"},
                "spec": {
                    "type": "external",
                    "enabled": True,
                    "external": {"model": "openai/example"},
                },
            }
        ]

        deployments = self.controller["desired_deployments"]()

        self.assertNotIn("local-chat", deployments)
        self.assertIn("remote-chat", deployments)

    def test_unready_kubeai_model_is_withdrawn_from_litellm(self):
        deleted = []
        existing = [
            {
                "model_name": "local-chat",
                "model_info": {
                    "id": "ai-appliance-kubeai-local-chat",
                    "ai_appliance_managed": True,
                },
            }
        ]
        self.controller["list_kubeai_models"] = lambda: [self.kubeai_model(0)]
        self.controller["fetch_litellm_models"] = lambda: [] if deleted else existing

        def litellm_request(method, path, body=None, ok=(200, 201, 202)):
            self.assertEqual((method, path), ("POST", "/model/delete"))
            deleted.append(body)
            return {}

        self.controller["litellm_request"] = litellm_request

        synchronized = self.controller["sync_litellm"]()

        self.assertEqual(deleted, [{"id": "ai-appliance-kubeai-local-chat"}])
        self.assertEqual(synchronized, [])


class OpenCodeModelLimitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def test_opencode_model_uses_catalog_output_limit(self):
        model = {
            "id": "qwen3827b",
            "name": "Qwen3.8 27B AWQ INT4",
            "contextWindow": 20000,
            "maxOutputTokens": 8192,
        }

        generated = self.controller["opencode_model"](model)

        self.assertEqual(
            generated,
            {
                "name": "Qwen3.8 27B AWQ INT4",
                "limit": {"context": 20000, "output": 8192},
            },
        )
        self.assertEqual(self.controller["agent_template_model"](model), generated)

    def test_opencode_output_never_exceeds_context_limit(self):
        generated = self.controller["opencode_model"](
            {
                "id": "small-context",
                "contextWindow": 4096,
                "maxOutputTokens": 32000,
            }
        )

        self.assertEqual(generated["limit"], {"context": 4096, "output": 4096})

    def test_sync_updates_named_and_magicstick_managed_agent_templates(self):
        original_request = self.controller["k8s_request"]
        original_names = self.controller["AGENT_TEMPLATE_NAMES"]
        writes = {}

        def k8s_request(method, path, body=None, ok=(200, 201, 202)):
            if method == "GET" and "?labelSelector=" in path:
                self.assertIn("appliance.magicstick.dev%2Fappinstance", path)
                return {
                    "items": [
                        {"metadata": {"name": "default-coder"}},
                    ]
                }
            if method == "GET" and path.endswith("/litellm-default"):
                return {"metadata": {"name": "litellm-default"}, "spec": {"config": {}}}
            if method == "GET" and path.endswith("/default-coder"):
                return {"metadata": {"name": "default-coder"}, "spec": {"config": {}}}
            if method == "PUT":
                writes[path] = body
                return body
            raise AssertionError((method, path))

        self.controller["k8s_request"] = k8s_request
        self.controller["AGENT_TEMPLATE_NAMES"] = ["litellm-default"]
        data = {
            "chat-models.json": json.dumps(
                {
                    "defaultModel": "qwen3827b",
                    "models": [
                        {
                            "id": "qwen3827b",
                            "name": "Qwen3.8 27B AWQ INT4",
                            "contextWindow": 20000,
                            "maxOutputTokens": 8192,
                        }
                    ],
                }
            )
        }
        try:
            self.controller["sync_agent_templates"](data)
        finally:
            self.controller["k8s_request"] = original_request
            self.controller["AGENT_TEMPLATE_NAMES"] = original_names

        self.assertEqual(len(writes), 2)
        for resource in writes.values():
            model = resource["spec"]["config"]["provider"]["litellm"]["models"]["qwen3827b"]
            self.assertEqual(model["limit"], {"context": 20000, "output": 8192})


if __name__ == "__main__":
    unittest.main()
