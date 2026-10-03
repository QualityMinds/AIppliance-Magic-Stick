# SPDX-License-Identifier: BUSL-1.1
"""Pi AppInstance routing, lifecycle and rendered runtime contracts."""
import copy
import importlib.util
import json
import pathlib
import shutil
import subprocess
import unittest
from unittest.mock import Mock, patch

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
OPERATOR = ROOT / "magic-cluster/platform/magicstick-operator"
CHART = ROOT / "magic-cluster/apps/instances/pi-coding"


def load_controller():
    spec = importlib.util.spec_from_file_location("pi_controller_tests", OPERATOR / "controller/test_controller.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_controller()


class PiCodingTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()
        self.catalog = json.loads(yaml.safe_load((OPERATOR / "app-catalog.yaml").read_text())["data"]["applications.json"])
        self.definition = self.catalog["applications"]["pi-coding"]
        self.instance = {"metadata": {"name": "pi-coding-example", "uid": "fixture-uid", "generation": 2},
                         "spec": {"application": "pi-coding", "targetNamespace": "ai",
                                  "values": {"name": "example", "model": "local-coder", "storage": {"size": "5Gi"}}}}
        self.source = {"kind": "GitRepository", "name": "magicstick-public", "namespace": "flux-system"}

    def test_catalog_connects_optional_service_to_existing_dependencies(self):
        modules = json.loads(yaml.safe_load((OPERATOR / "module-catalog.yaml").read_text())["data"]["modules.json"])["modules"]
        definition = modules["pi-coding"]
        self.assertFalse(definition["default"])
        self.assertEqual(definition["activationMode"], "moduleactivation")
        self.assertEqual(self.definition["requiredModules"], ["pi-coding", "litellm", "model-catalog"])
        self.assertEqual(definition["requires"], ["basis", "litellm", "model-catalog"])
        self.assertTrue((ROOT / definition["path"] / "kustomization.yaml").is_file())

    def test_pi_release_and_sso_routes_use_generated_hostnames_and_terminal_port(self):
        release, url = self.controller["app_instance_helmrelease"](self.instance, self.definition, self.source)
        self.assertEqual(release["spec"]["chart"]["spec"]["chart"], "./magic-cluster/apps/instances/pi-coding")
        self.assertEqual(release["spec"]["values"]["instance"]["values"]["model"], "local-coder")
        self.assertEqual(url, "https://example.pi-coding.magicstick.local/")
        resources, access = self.controller["app_instance_access_resources"](self.instance, self.definition)
        routes = [r for r in resources if r["kind"] == "HTTPRoute" and not r["metadata"]["name"].endswith("-callback")]
        self.assertEqual(len(routes), 2)
        self.assertEqual({r["spec"]["hostnames"][0] for r in routes}, {
            "example.pi-coding.magicstick.local", "example.pi-coding.magicstick.example.com"})
        for route in routes:
            self.assertEqual(route["spec"]["rules"][0]["backendRefs"][0], {"name": "pi-coding-example", "namespace": "ai", "port": 7681})
            self.assertEqual(route["spec"]["rules"][0]["timeouts"], {"request": "0s"})
        self.assertEqual(access["authentication"], "sso")
        self.assertEqual(len([r for r in resources if r["kind"] == "SecurityPolicy"]), 2)

    def test_pi_waits_for_dependencies_and_is_ready_only_after_helm_and_access_guard(self):
        applied, statuses = Mock(), Mock()
        dependencies = Mock()
        fakes = {"ensure_module_activation": dependencies, "module_ready": lambda name, catalog: name != "litellm",
                 "patch_instance_status": statuses, "crd_exists": lambda name: True,
                 "ensure_app_instance_finalizer": Mock(), "apply_resource": applied,
                 "sync_app_instance_access": Mock(return_value={"accessGuardReady": False}),
                 "get_applied_resource": Mock(return_value={"status": {"conditions": [{"type": "Ready", "status": "True"}]}})}
        with patch.dict(self.controller, fakes):
            phase, _ = self.controller["reconcile_instance"](self.instance, {}, self.catalog, self.source)
            self.assertEqual(phase, "WaitingForModules")
            applied.assert_not_called()
            self.controller["module_ready"] = lambda name, catalog: True
            phase, _ = self.controller["reconcile_instance"](self.instance, {}, self.catalog, self.source)
            self.assertEqual(phase, "Reconciling")
            self.controller["sync_app_instance_access"].return_value = {"accessGuardReady": True}
            for _ in range(2):
                phase, _ = self.controller["reconcile_instance"](self.instance, {}, self.catalog, self.source)
                self.assertEqual(phase, "Ready")
            releases = [call.args[0] for call in applied.call_args_list]
            self.assertTrue(all(r == releases[0] for r in releases))
            self.assertEqual(statuses.call_args.kwargs["generation"], 2)

    def test_removal_closes_access_before_deleting_the_helm_release(self):
        instance = copy.deepcopy(self.instance)
        instance["metadata"]["deletionTimestamp"] = "2026-10-03T00:00:00Z"
        calls = []
        with patch.dict(self.controller, {
            "sync_app_instance_access": lambda *args, **kwargs: calls.append(("access", kwargs)),
            "get_applied_resource": lambda ref: {"kind": "HelmRelease"},
            "delete_applied_resource": lambda ref: calls.append(("delete", ref)),
            "patch_instance_status": Mock(),
        }):
            phase, _ = self.controller["reconcile_instance"](instance, {}, self.catalog, self.source)
        self.assertEqual(phase, "Removing")
        self.assertEqual(calls[0], ("access", {"enabled": False}))
        self.assertEqual(calls[1][0], "delete")

    def test_dashboard_api_requires_operator_and_csrf_and_persists_only_runtime_intent(self):
        spec = importlib.util.spec_from_file_location("pi_api_tests", ROOT / "magic-cluster/apps/dashboard/test_dashboard_api.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        api = module.load_server()
        handler = api["Handler"].__new__(api["Handler"])
        handler.path = "/api/instances/pi-coding"
        handler.headers = {}
        handler.handle_edge_guard = lambda: False
        roles, writes, checks, responses = [], [], [], []
        handler.require_access = lambda role: roles.append(role) or {"subject": "operator-fixture"}
        handler.send_json = lambda value, status=200: responses.append(value)
        handler.send_error_json = lambda status, message: self.fail(f"{status}: {message}")
        handler.send_auth_error = self.fail
        payload = {"name": "example", "model": "local-coder", "storage": {"size": "10Gi"}}
        with patch.dict(api, {
            "app_catalog_json": lambda: self.catalog,
            "app_instance": lambda name: None,
            "read_body": lambda request: payload,
            "validate_dashboard_mutation_request": lambda request: checks.append("csrf"),
            "prepare_instance_sharing": Mock(),
            "request_json": lambda method, path, body: writes.append((method, path, body)) or body,
        }):
            handler.do_POST()
        self.assertEqual(roles, ["operator"])
        self.assertEqual(checks, ["csrf"])
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][:2], ("POST", "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/appinstances"))
        resource = writes[0][2]
        self.assertEqual(resource["kind"], "AppInstance")
        self.assertEqual(resource["metadata"]["name"], "pi-coding-example")
        self.assertEqual(resource["spec"]["application"], "pi-coding")
        self.assertEqual(resource["spec"]["values"]["storage"], {"size": "10Gi"})
        self.assertEqual(resource["spec"]["values"]["model"], "local-coder")
        self.assertEqual(resource["spec"]["access"]["authentication"], "sso")
        self.assertEqual(responses, [resource])

    @unittest.skipUnless(shutil.which("helm"), "Helm is needed for instance rendering")
    def test_chart_runs_nonroot_with_persistent_data_and_secret_reference(self):
        release, _ = self.controller["app_instance_helmrelease"](self.instance, self.definition, self.source)
        result = subprocess.run(["helm", "template", "fixture", str(CHART), "-f", "-"],
                                input=yaml.safe_dump(release["spec"]["values"]), text=True, capture_output=True, check=True)
        objects = {r["kind"]: r for r in yaml.safe_load_all(result.stdout)}
        self.assertEqual(set(objects), {"ConfigMap", "Deployment", "PersistentVolumeClaim", "Service"})
        pod = objects["Deployment"]["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 1000)
        container = pod["containers"][0]
        environment = {item["name"]: item for item in container["env"]}
        self.assertEqual(environment["PI_MODEL"]["value"], "local-coder")
        self.assertEqual(environment["LITELLM_API_KEY"]["valueFrom"]["secretKeyRef"],
                         {"name": "litellm-masterkey-secret", "key": "LITELLM_MASTER_KEY"})
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(objects["Service"]["spec"]["type"], "ClusterIP")
        self.assertEqual(objects["Service"]["spec"]["ports"][0]["port"], 7681)
        self.assertEqual(objects["PersistentVolumeClaim"]["metadata"]["annotations"]["helm.sh/resource-policy"], "keep")
        self.assertEqual(objects["PersistentVolumeClaim"]["spec"]["resources"]["requests"]["storage"], "5Gi")
        self.assertTrue(all("hostPath" not in volume for volume in pod["volumes"]))
        self.assertIn("@sha256:", container["image"])

    @unittest.skipUnless(shutil.which("helm"), "Helm is needed for schema validation")
    def test_chart_rejects_missing_model_and_invalid_storage(self):
        release, _ = self.controller["app_instance_helmrelease"](self.instance, self.definition, self.source)
        for changes in ({"model": ""}, {"model": "CHANGEME_MODEL"}, {"storage": {"size": "not-a-size"}}):
            with self.subTest(changes=changes):
                values = copy.deepcopy(release["spec"]["values"])
                values["instance"]["values"].update(changes)
                result = subprocess.run(["helm", "template", "fixture", str(CHART), "-f", "-"],
                                        input=yaml.safe_dump(values), text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    @unittest.skipUnless(shutil.which("node"), "Node is needed for runtime tests")
    def test_runtime_bootstrap_behaviors(self):
        subprocess.run(["node", "--test", str(ROOT / "magic-cluster/apps/ai/tests/pi_coding_runtime.test.mjs")],
                       check=True, capture_output=True, text=True)
