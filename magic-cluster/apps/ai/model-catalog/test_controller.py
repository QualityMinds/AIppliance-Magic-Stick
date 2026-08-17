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


if __name__ == "__main__":
    unittest.main()
