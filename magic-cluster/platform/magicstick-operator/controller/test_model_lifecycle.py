import copy
import unittest
from unittest.mock import Mock, patch

from test_controller import load_controller


class ModelLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def test_stop_removes_each_local_backend_without_deleting_its_saved_activation(self):
        for engine in ("OLlama", "VLLM", "FreeToken"):
            for target in (("nvidia-gpu",) if engine == "FreeToken" else ("cpu", "amd-gpu", "nvidia-gpu")):
                with self.subTest(engine=engine, target=target):
                    activation = {
                        "metadata": {"name": "example-model", "generation": 3},
                        "spec": {"type": "local", "enabled": False, "targetNamespace": "ai", "local": {
                            "engine": engine, "computeTarget": target, "url": "hf://Qwen/Qwen3-8B",
                            "contextWindow": 4096, "maxNumSeqs": 2,
                        }},
                    }
                    saved = copy.deepcopy(activation)
                    delete_runtime = Mock(side_effect=[True, False])
                    remove_finalizer = Mock()
                    start_modules = Mock()
                    with patch.dict(self.controller, {
                        "ensure_model_finalizer": Mock(), "remove_model_finalizer": remove_finalizer,
                        "patch_model_status": Mock(), "delete_local_runtime": delete_runtime,
                        "ensure_model_module_activations": start_modules,
                    }):
                        phase, status = self.controller["reconcile_model_activation"](activation, {}, {})
                        self.assertEqual(phase, "Removing")
                        phase, status = self.controller["reconcile_model_activation"](activation, {}, {})
                        self.assertEqual(phase, "Disabled")
                        self.assertEqual(status["engine"], engine)
                        self.assertEqual(status["computeTarget"], target)
                    self.assertEqual(delete_runtime.call_count, 2)
                    delete_runtime.assert_called_with("example-model", "ai", engine)
                    remove_finalizer.assert_not_called()
                    start_modules.assert_not_called()
                    self.assertEqual(activation, saved)

    def test_runtime_deletion_is_scoped_to_the_engine_backend(self):
        for engine in ("OLlama", "VLLM", "FreeToken"):
            with self.subTest(engine=engine):
                get_resource = Mock(return_value={"metadata": {"name": "example-model"}})
                get_service = Mock(return_value={"metadata": {"name": "example-model-freetoken"}})
                delete_resource = Mock()
                delete_json = Mock()
                with patch.dict(self.controller, {
                    "get_resource": get_resource, "get_core_resource": get_service,
                    "delete_resource": delete_resource, "delete_json": delete_json,
                }):
                    self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", engine))
                if engine == "FreeToken":
                    delete_resource.assert_called_once_with("apps", "v1", "deployments", "ai", "example-model-freetoken")
                    delete_json.assert_called_once_with("/api/v1/namespaces/ai/services/example-model-freetoken")
                else:
                    delete_resource.assert_called_once_with("kubeai.org", "v1", "models", "ai", "example-model")
                    get_service.assert_not_called()
                    delete_json.assert_not_called()

    def test_external_stop_preserves_provider_configuration_and_does_not_delete_a_local_runtime(self):
        activation = {
            "metadata": {"name": "example-provider"},
            "spec": {"type": "external", "enabled": False, "external": {
                "model": "provider/model", "apiBase": "https://api.example.com/v1",
                "apiKeySecretRef": {"name": "example-provider-key", "key": "api-key"},
            }},
        }
        saved = copy.deepcopy(activation)
        delete_runtime = Mock()
        with patch.dict(self.controller, {
            "ensure_model_finalizer": Mock(), "patch_model_status": Mock(),
            "delete_local_runtime": delete_runtime,
        }):
            phase, _ = self.controller["reconcile_model_activation"](activation, {}, {})
        self.assertEqual(phase, "Disabled")
        delete_runtime.assert_not_called()
        self.assertEqual(activation, saved)


if __name__ == "__main__":
    unittest.main()
