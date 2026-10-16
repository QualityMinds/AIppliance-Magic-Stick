import copy
import json
import unittest
from unittest.mock import Mock, patch

import yaml
from test_controller import ROOT, load_controller


class AppInstanceModelContextTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()
        self.instance = {"metadata": {"name": "hermes-test"}, "spec": {
            "application": "hermes", "targetNamespace": "ai", "values": {"model": "litellm/selected-chat"}}}
        self.definition = json.loads(yaml.safe_load((ROOT / "app-catalog.yaml").read_text())[
            "data"]["applications.json"])["applications"]["hermes"]
        self.source = {"name": "public", "namespace": "flux-system"}

    def render(self, models, *, suspend=False):
        with patch.dict(self.controller, {"model_catalog_models": lambda namespace: models}):
            return self.controller["app_instance_helmrelease"](
                self.instance, self.definition, self.source, suspend=suspend)[0]

    def test_selected_context_is_forwarded_without_changing_saved_intent(self):
        original = copy.deepcopy(self.instance)
        release = self.render([{"id": "other-chat", "contextWindow": 64000},
                               {"id": "selected-chat", "contextWindow": 131072}])
        values = release["spec"]["values"]["instance"]["values"]
        self.assertEqual(values["modelContextTokens"], 131072)
        self.assertEqual(values["model"], "litellm/selected-chat")
        self.assertEqual(self.instance, original)

    def test_unknown_and_small_contexts_are_rejected_without_inflation(self):
        for context in (None, 8192, 63999, True):
            with self.subTest(context=context), self.assertRaisesRegex(ValueError, "64,000 context tokens"):
                self.render([{"id": "selected-chat", "contextWindow": context}])

    def test_explicit_supported_context_is_preserved(self):
        self.instance["spec"]["values"]["modelContextTokens"] = 96000
        release = self.render([])
        self.assertEqual(release["spec"]["values"]["instance"]["values"]["modelContextTokens"], 96000)

    def test_context_change_updates_release_for_same_instance_and_model(self):
        old = self.render([{"id": "selected-chat", "contextWindow": 64000}])
        new = self.render([{"id": "selected-chat", "contextWindow": 128000}])
        self.assertNotEqual(old["spec"]["values"], new["spec"]["values"])
        self.assertEqual(old["metadata"]["name"], new["metadata"]["name"])

    def test_suspension_remains_possible_without_a_known_model_context(self):
        release = self.render([], suspend=True)
        self.assertTrue(release["spec"]["suspend"])

    def test_incompatible_instance_reports_current_generation_without_blocking_next_instance(self):
        self.instance["metadata"].update(uid="owned-instance", generation=7)
        original = copy.deepcopy(self.instance)
        status, apply, key, access = Mock(), Mock(), Mock(), Mock(return_value={"accessGuardReady": True})
        with patch.dict(self.controller, {
            "model_catalog_models": lambda namespace: [{"id": "selected-chat", "contextWindow": 2048}],
            "ensure_module_activation": Mock(), "module_ready": lambda *args: True,
            "crd_exists": lambda *args: True, "patch_instance_status": status,
            "ensure_app_instance_finalizer": Mock(), "apply_resource": apply,
            "reconcile_service_key": key, "sync_app_instance_access": access,
            "get_applied_resource": lambda *args: {},
        }):
            catalog = {"applications": {"hermes": self.definition}}
            phase, target = self.controller["reconcile_instance"](self.instance, {}, catalog, self.source)
            self.assertEqual(phase, "Degraded")
            self.assertEqual(target, {"kind": "HelmRelease", "name": "hermes-test", "namespace": "ai-system"})
            self.assertEqual(status.call_args.args[3], "InvalidModelContext")
            self.assertIn("64,000", status.call_args.args[4])
            self.assertEqual(status.call_args.kwargs["generation"], 7)
            apply.assert_not_called()
            key.assert_not_called()
            access.assert_not_called()
            # The invalid item must not throw out the controller's entire loop.
            healthy = copy.deepcopy(self.instance)
            healthy["metadata"]["name"] = "hermes-healthy"
            healthy["spec"]["values"]["modelContextTokens"] = 64000
            self.assertEqual(self.controller["reconcile_instance"](healthy, {}, catalog, self.source)[0], "Reconciling")
            self.assertEqual(apply.call_count, 1)
        self.assertEqual(self.instance, original)

    def test_unexpected_controller_error_is_not_labelled_invalid_configuration(self):
        with patch.dict(self.controller, {"ensure_module_activation": Mock(), "module_ready": lambda *args: True,
            "crd_exists": lambda *args: True, "reconcile_helm_app_instance": Mock(side_effect=RuntimeError("bug"))}):
            with self.assertRaisesRegex(RuntimeError, "bug"):
                self.controller["reconcile_instance"](self.instance, {}, {"applications": {"hermes": self.definition}}, self.source)

    def test_selected_capabilities_are_managed_without_changing_saved_values(self):
        self.instance['spec']['values']['modelCapabilities'] = {'vision':False}
        original = copy.deepcopy(self.instance)
        release = self.render([{'id':'selected-chat','contextWindow':64000,
                               'capabilities':{'tools':False,'vision':True,'reasoning':None}}])
        values = release['spec']['values']['instance']['values']
        self.assertEqual(values['modelCapabilities'],{'tools':False,'vision':True})
        self.assertEqual(self.instance,original)

    def test_local_declaration_survives_kubeai_resource_conversion(self):
        activation = {'metadata':{'name':'local-chat'},'spec':{'type':'local','targetNamespace':'ai',
            'local':{'url':'ollama://fixture','engine':'OLlama','computeTarget':'cpu',
                     'capabilities':{'tools':False,'vision':True,'reasoning':False}}}}
        catalog = json.loads(yaml.safe_load((ROOT/'compute-target-catalog.yaml').read_text())['data']['targets.json'])
        resource = self.controller['kubeai_model_resource'](activation,{},catalog)[0]
        self.assertEqual(json.loads(resource['metadata']['annotations']['ai-appliance.io/capabilities']),
                         activation['spec']['local']['capabilities'])


if __name__ == "__main__":
    unittest.main()
