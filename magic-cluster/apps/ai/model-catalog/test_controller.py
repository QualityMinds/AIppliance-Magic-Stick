import hashlib
import importlib.util
import json
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("controller.py")
SPEC = importlib.util.spec_from_file_location("model_catalog_controller", MODULE_PATH)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class AisixRendererTests(unittest.TestCase):
    def setUp(self):
        self.original_master_key = controller.LITELLM_MASTER_KEY
        controller.LITELLM_MASTER_KEY = "unit-test-client-key"

    def tearDown(self):
        controller.LITELLM_MASTER_KEY = self.original_master_key

    def test_kubeai_model_becomes_openai_compatible_aisix_resource(self):
        deployment = {
            "model_name": "local-chat",
            "litellm_params": {
                "model": "openai/local-chat",
                "api_base": "http://kubeai.ai.svc.cluster.local/openai/v1",
                "api_key": "none",
            },
            "model_info": {
                "ai_appliance_source": "kubeai",
                "ai_appliance_type": "chat",
            },
        }

        document, credentials, summary = controller.aisix_document({"local-chat": deployment})

        self.assertEqual(document["models"][0]["display_name"], "local-chat")
        self.assertEqual(document["models"][0]["model_name"], "local-chat")
        self.assertEqual(document["provider_keys"][0]["adapter"], "openai")
        self.assertEqual(summary["compatibleModels"], ["local-chat"])
        self.assertEqual(list(credentials.values()), ["none"])

    def test_external_openai_credential_is_kept_out_of_resources_document(self):
        deployment = {
            "model_name": "external-chat",
            "litellm_params": {
                "model": "openai/example-model",
                "api_base": "https://models.example.com/v1",
                "api_key": "provider-secret-value",
            },
            "model_info": {"ai_appliance_source": "external"},
        }

        document, credentials, _ = controller.aisix_document({"external-chat": deployment})
        rendered = json.dumps(document)

        self.assertNotIn("provider-secret-value", rendered)
        self.assertIn("${AISIX_PROVIDER_KEY_", rendered)
        self.assertEqual(list(credentials.values()), ["provider-secret-value"])
        self.assertNotIn("unit-test-client-key", rendered)
        self.assertEqual(
            document["api_keys"][0]["key_hash"],
            hashlib.sha256(b"unit-test-client-key").hexdigest(),
        )

    def test_unsupported_provider_is_reported_without_breaking_litellm(self):
        deployment = {
            "model_name": "claude-example",
            "litellm_params": {
                "model": "anthropic/claude-example",
                "api_key": "provider-secret-value",
            },
            "model_info": {"ai_appliance_source": "external"},
        }

        document, credentials, summary = controller.aisix_document({"claude-example": deployment})

        self.assertEqual(document["models"], [])
        self.assertEqual(credentials, {})
        self.assertEqual(summary["skippedModels"][0]["id"], "claude-example")
        self.assertIn("unsupported provider adapter", summary["skippedModels"][0]["reason"])

    def test_generated_secrets_are_written_only_to_isolated_namespace(self):
        existing = {
            "metadata": {
                "resourceVersion": "7",
                "annotations": {"kustomize.toolkit.fluxcd.io/ssa": "IfNotPresent"},
            },
            "data": {},
        }
        with mock.patch.object(controller, "get_secret", return_value=existing), mock.patch.object(
            controller, "k8s_request", return_value={}
        ) as request:
            controller.write_generated_secret("aisix-runtime-resources", {"resources.yaml": "{}"}, "hash")

        method, path, payload = request.call_args.args[:3]
        self.assertEqual(method, "PUT")
        self.assertEqual(path, "/api/v1/namespaces/aisix-system/secrets/aisix-runtime-resources")
        self.assertEqual(payload["metadata"]["namespace"], "aisix-system")
        self.assertEqual(payload["metadata"]["resourceVersion"], "7")
        self.assertEqual(payload["metadata"]["annotations"]["kustomize.toolkit.fluxcd.io/ssa"], "IfNotPresent")


if __name__ == "__main__":
    unittest.main()
