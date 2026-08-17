import pathlib
import unittest

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
        }

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

    def test_local_model_runtime_requires_gpu_and_kubeai_ready(self):
        requirements = self.server["local_model_runtime_requirements"]({
            "modules": {
                "gpu": {"enabled": True, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Ready"}},
                "kubeai": {"enabled": True, "displayName": "KubeAI", "status": {"phase": "Ready"}},
            }
        })

        self.assertTrue(requirements["ready"])
        self.assertEqual(requirements["missing"], [])

    def test_local_model_runtime_reports_disabled_or_pending_modules(self):
        requirements = self.server["local_model_runtime_requirements"]({
            "modules": {
                "gpu": {"enabled": False, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Disabled"}},
                "kubeai": {"enabled": True, "displayName": "KubeAI", "status": {"phase": "Reconciling"}},
            }
        })

        self.assertFalse(requirements["ready"])
        self.assertEqual([item["name"] for item in requirements["missing"]], ["gpu", "kubeai"])

    def test_local_model_creation_guard_returns_conflict(self):
        self.server["summarized_modules"] = lambda: {
            "modules": {
                "gpu": {"enabled": True, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Ready"}},
                "kubeai": {"enabled": False, "displayName": "KubeAI", "status": {"phase": "Disabled"}},
            }
        }

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_local_model_runtime"]()

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("KubeAI", str(raised.exception))

    def test_dashboard_renders_starting_model_phase_as_progress(self):
        source = (ROOT / "configmap.yaml").read_text(encoding="utf-8")

        self.assertIn("normalized === 'starting'", source)
        self.assertIn("label: 'Starting model runtime'", source)
        self.assertIn("'starting', 'reconciling'", source)


if __name__ == "__main__":
    unittest.main()
