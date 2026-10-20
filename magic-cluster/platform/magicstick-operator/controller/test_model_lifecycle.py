import copy
import unittest
import urllib.error
from unittest.mock import Mock, patch

from test_controller import load_controller


class ModelLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def model(self, **metadata):
        return {"metadata": {"name": "example-model", "namespace": "ai", "uid": "model-uid",
            "resourceVersion": "42", "labels": {"app.kubernetes.io/managed-by": "magicstick-operator",
                "appliance.magicstick.dev/modelactivation": "example-model",
                "appliance.magicstick.dev/activation-uid": "activation-uid"}, **metadata}}

    def test_stop_deletes_the_observed_model_foreground_with_identity_preconditions(self):
        delete = Mock()
        with patch.dict(self.controller, {"get_resource": Mock(return_value=self.model()), "delete_json": delete}):
            self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
        delete.assert_called_once_with("/apis/kubeai.org/v1/namespaces/ai/models/example-model", {
            "apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Foreground",
            "preconditions": {"uid": "model-uid", "resourceVersion": "42"}})

    def test_repeated_stop_waits_for_terminating_model_without_another_delete(self):
        delete = Mock()
        with patch.dict(self.controller, {"get_resource": Mock(return_value=self.model(deletionTimestamp="2026-10-16T08:00:00Z")),
                                         "delete_json": delete}):
            self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", "OLlama", "activation-uid"))
        delete.assert_not_called()

    def test_stop_does_not_report_drained_while_terminal_or_terminating_pods_still_exist(self):
        for status in ({"phase": "Running"}, {"phase": "Succeeded"}, {"phase": "Failed"}):
            pod = {"metadata": {"name": "remaining-pod", "namespace": "ai", "uid": "pod-uid",
                "deletionTimestamp": "2026-10-16T08:00:00Z", "labels": {"app": "model", "model": "example-model"}},
                "status": status}
            listing, delete = Mock(side_effect=[[pod], []]), Mock()
            with patch.dict(self.controller, {"get_resource": Mock(return_value=None), "list_items": listing, "delete_json": delete}):
                with self.subTest(status=status):
                    self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
                    self.assertFalse(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
            self.assertIn("app%3Dmodel%2Cmodel%3Dexample-model", listing.call_args.args[0])
            delete.assert_not_called()

    def test_stop_never_deletes_a_foreign_or_replaced_model(self):
        for labels in ({}, {"app.kubernetes.io/managed-by": "another-controller",
                             "appliance.magicstick.dev/modelactivation": "example-model"},
                       {"app.kubernetes.io/managed-by": "magicstick-operator",
                        "appliance.magicstick.dev/modelactivation": "example-model",
                        "appliance.magicstick.dev/activation-uid": "replaced-activation"}):
            delete = Mock()
            with self.subTest(labels=labels), patch.dict(self.controller, {
                    "get_resource": Mock(return_value=self.model(labels=labels)), "delete_json": delete}):
                with self.assertRaisesRegex(ValueError, "foreign|identity"):
                    self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid")
            delete.assert_not_called()

    def test_stop_does_not_turn_a_delete_conflict_into_a_successful_drain(self):
        delete = Mock(side_effect=urllib.error.HTTPError("https://kubernetes.example.local", 409, "Conflict", {}, None))
        with patch.dict(self.controller, {"get_resource": Mock(return_value=self.model()), "delete_json": delete}):
            with self.assertRaises(urllib.error.HTTPError):
                self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid")
        self.assertEqual(delete.call_count, 1)

    def test_stop_rechecks_identity_after_a_lost_delete_response(self):
        delete = Mock(side_effect=TimeoutError("response lost"))
        observed = Mock(side_effect=[self.model(), self.model(deletionTimestamp="2026-10-16T08:00:00Z"), None])
        with patch.dict(self.controller, {"get_resource": observed, "delete_json": delete, "list_items": Mock(return_value=[])}):
            with self.assertRaises(TimeoutError):
                self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid")
            self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
            self.assertFalse(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
        self.assertEqual(delete.call_count, 1)

    def test_unrelated_pods_do_not_block_stop_or_get_deleted(self):
        unrelated = [{"metadata": {"namespace": "other", "labels": {"app": "model", "model": "example-model"}}},
                     {"metadata": {"namespace": "ai", "labels": {"app": "model", "model": "another-model"}}}]
        delete = Mock()
        with patch.dict(self.controller, {"get_resource": Mock(return_value=None), "list_items": Mock(return_value=unrelated), "delete_json": delete}):
            self.assertFalse(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
        delete.assert_not_called()

    def test_new_single_runtime_carries_the_saved_activation_uid(self):
        activation = {"metadata": {"name": "example-model", "uid": "activation-uid"}, "spec": {
            "type": "local", "local": {"engine": "OLlama", "computeTarget": "cpu",
                "url": "ollama://qwen2.5:0.5b", "memoryRequiredMi": 2048}}}
        model, _ = self.controller["kubeai_model_resource"](activation, {})
        self.assertEqual(model["metadata"]["labels"]["appliance.magicstick.dev/activation-uid"], "activation-uid")

    def test_stop_supports_owned_legacy_models_but_refuses_missing_kubernetes_identity(self):
        legacy = self.model()
        legacy["metadata"]["labels"].pop("appliance.magicstick.dev/activation-uid")
        delete = Mock()
        with patch.dict(self.controller, {"get_resource": Mock(return_value=legacy), "delete_json": delete}):
            self.assertTrue(self.controller["delete_local_runtime"]("example-model", "ai", "VLLM", "activation-uid"))
        self.assertEqual(delete.call_args.args[1]["preconditions"], {"uid": "model-uid", "resourceVersion": "42"})
        for field in ("uid", "resourceVersion"):
            model = copy.deepcopy(legacy)
            model["metadata"].pop(field)
            with self.subTest(field=field), patch.dict(self.controller, {"get_resource": Mock(return_value=model), "delete_json": Mock()}):
                with self.assertRaisesRegex(ValueError, "identity"):
                    self.controller["delete_local_runtime"]("example-model", "ai", "OLlama", "activation-uid")

    def test_disabled_status_and_activation_finalizer_wait_for_pods_to_disappear(self):
        for deleting in (False, True):
            activation = {"metadata": {"name": "example-model", "namespace": "ai-system", "uid": "activation-uid", "generation": 3},
                "spec": {"type": "local", "enabled": False, "local": {"engine": "VLLM", "computeTarget": "nvidia-gpu"}}}
            if deleting:
                activation["metadata"]["deletionTimestamp"] = "2026-10-16T08:00:00Z"
            pod = {"metadata": {"namespace": "ai", "labels": {"app": "model", "model": "example-model"}},
                "status": {"phase": "Succeeded"}}
            finalize, delete = Mock(), Mock()
            with self.subTest(deleting=deleting), patch.dict(self.controller, {
                    "get_resource": Mock(return_value=None), "crd_exists": Mock(return_value=False),
                    "list_items": Mock(side_effect=[[pod], []]), "delete_json": delete,
                    "ensure_model_finalizer": Mock(), "remove_model_finalizer": finalize, "patch_model_status": Mock()}):
                self.assertEqual(self.controller["reconcile_model_activation"](activation, {}, {})[0], "Removing")
                finalize.assert_not_called()
                self.assertEqual(self.controller["reconcile_model_activation"](activation, {}, {})[0], "Disabled")
            self.assertEqual(finalize.call_count, int(deleting))
            delete.assert_not_called()

    def test_retired_engine_never_recreates_a_runtime_or_installs_modules(self):
        activation = {"metadata": {"name": "retired", "generation": 2}, "spec": {
            "type": "local", "enabled": True, "local": {"engine": "FreeToken"},
        }}
        saved = copy.deepcopy(activation)
        apply = Mock()
        modules = Mock()
        with patch.dict(self.controller, {
            "ensure_model_finalizer": Mock(), "patch_model_status": Mock(),
            "apply_resource": apply, "ensure_model_module_activations": modules,
        }):
            phase, status = self.controller["reconcile_model_activation"](activation, {}, {})
        self.assertEqual(phase, "Degraded")
        self.assertIn("no longer supported", status["message"])
        apply.assert_not_called()
        modules.assert_not_called()
        self.assertEqual(activation, saved)

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
                get_resource = Mock(return_value=self.model())
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
                    delete_resource.assert_not_called()
                    get_service.assert_not_called()
                    self.assertEqual(delete_json.call_args.args[0], "/apis/kubeai.org/v1/namespaces/ai/models/example-model")
                    self.assertEqual(delete_json.call_args.args[1]["preconditions"]["uid"], "model-uid")

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
