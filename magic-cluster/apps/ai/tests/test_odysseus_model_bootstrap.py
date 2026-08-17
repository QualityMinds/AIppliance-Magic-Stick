import importlib.util
import os
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock


REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
SCRIPT_PATH = (
    REPO_ROOT
    / "magic-cluster"
    / "apps"
    / "instances"
    / "odysseus"
    / "files"
    / "model-bootstrap.py"
)
TEMPLATE_PATH = SCRIPT_PATH.parents[1] / "templates" / "resources.yaml"

SPEC = importlib.util.spec_from_file_location("odysseus_model_bootstrap", SCRIPT_PATH)
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BOOTSTRAP
SPEC.loader.exec_module(BOOTSTRAP)


class OdysseusModelBootstrapTests(unittest.TestCase):
    def config(self):
        return BOOTSTRAP.Config(
            odysseus_url="http://127.0.0.1:7000",
            litellm_url="http://litellm.ai.svc.cluster.local:4000/v1",
            api_key="test-secret-value",
            model="qwen3827b",
            endpoint_name="Magic Stick LiteLLM",
            ready_file=pathlib.Path("/tmp/test-ready"),
            request_timeout=45,
            reconcile_interval=300,
        )

    def test_load_config_requires_a_real_model_and_key(self):
        with mock.patch.dict(
            os.environ,
            {
                "ODYSSEUS_DEFAULT_MODEL": "qwen3827b",
                "LITELLM_API_KEY": "test-secret-value",
            },
            clear=True,
        ):
            config = BOOTSTRAP.load_config()
        self.assertEqual(config.model, "qwen3827b")
        self.assertEqual(
            config.litellm_url,
            "http://litellm.ai.svc.cluster.local:4000/v1",
        )

        for environment in (
            {"LITELLM_API_KEY": "test-secret-value"},
            {"ODYSSEUS_DEFAULT_MODEL": "qwen3827b"},
        ):
            with self.subTest(environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaises(ValueError):
                        BOOTSTRAP.load_config()

    def test_register_endpoint_uses_odysseus_api_and_pins_selected_model(self):
        response = {
            "id": "endpoint-1",
            "models": ["qwen3827b"],
            "pinned_models": ["qwen3827b"],
            "existing": False,
        }
        with mock.patch.object(
            BOOTSTRAP, "request_json", return_value=response
        ) as request_json:
            result = BOOTSTRAP.register_endpoint(self.config())

        self.assertEqual(result, response)
        request_json.assert_called_once()
        args, kwargs = request_json.call_args
        self.assertEqual(
            args[0], "http://127.0.0.1:7000/api/model-endpoints"
        )
        self.assertEqual(kwargs["timeout"], 45)
        self.assertEqual(
            kwargs["form"],
            {
                "name": "Magic Stick LiteLLM",
                "base_url": "http://litellm.ai.svc.cluster.local:4000/v1",
                "api_key": "test-secret-value",
                "require_models": "true",
                "endpoint_kind": "proxy",
                "pinned_models": "qwen3827b",
                "shared": "true",
            },
        )

    def test_register_endpoint_fails_until_selected_model_is_available(self):
        with mock.patch.object(
            BOOTSTRAP,
            "request_json",
            return_value={"id": "endpoint-1", "models": []},
        ):
            with self.assertRaisesRegex(RuntimeError, "selected model"):
                BOOTSTRAP.register_endpoint(self.config())

    def test_http_errors_do_not_copy_response_body_into_error(self):
        error = urllib.error.HTTPError(
            "http://127.0.0.1:7000/api/model-endpoints",
            400,
            "Bad Request",
            {},
            None,
        )
        with mock.patch.object(BOOTSTRAP.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400") as raised:
                BOOTSTRAP.request_json(
                    "http://127.0.0.1:7000/api/model-endpoints",
                    timeout=45,
                    form={"api_key": "test-secret-value"},
                )
        self.assertNotIn("test-secret-value", str(raised.exception))

    def test_chart_runs_bootstrap_without_exposing_key_in_configmap(self):
        template = TEMPLATE_PATH.read_text(encoding="utf-8")
        self.assertIn('.Files.Get "files/model-bootstrap.py"', template)
        self.assertIn("- name: model-bootstrap", template)
        self.assertIn("command: [python, /bootstrap/model-bootstrap.py]", template)
        self.assertIn("key: LITELLM_MASTER_KEY", template)
        self.assertIn("command: [test, -f, /tmp/ready]", template)
        self.assertNotIn("test-secret-value", template)


if __name__ == "__main__":
    unittest.main()
