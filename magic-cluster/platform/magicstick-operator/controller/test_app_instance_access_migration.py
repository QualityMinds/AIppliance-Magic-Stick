import copy
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

import yaml
from test_controller import ROOT, load_controller


class AppInstanceAccessMigrationTests(unittest.TestCase):
    """Migrate a deployed instance's access, never provision an invalid app."""

    def setUp(self):
        self.controller = load_controller()
        self.instance = {
            "apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "AppInstance",
            "metadata": {"name": "hermes-example", "namespace": "ai-system",
                         "uid": "instance-uid", "resourceVersion": "10", "generation": 2,
                         "finalizers": [self.controller["APPINSTANCE_FINALIZER"]]},
            "spec": {"application": "hermes", "enabled": True, "targetNamespace": "ai",
                     "values": {"name": "example", "model": "litellm/stopped-model"}},
        }
        self.parent = copy.deepcopy(self.instance)
        self.definition = json.loads(yaml.safe_load((ROOT / "app-catalog.yaml").read_text())[
            "data"]["applications.json"])["applications"]["hermes"]
        desired, _ = self.controller["app_instance_access_resources"](self.instance, self.definition)
        self.desired = {self.key(item): copy.deepcopy(item) for item in desired}
        self.resources = {}
        for index, item in enumerate(desired):
            if item["kind"] == "EnvoyExtensionPolicy":
                continue  # These guards did not exist before the cookie migration.
            item = copy.deepcopy(item)
            metadata = item["metadata"]
            metadata.update(uid="resource-" + str(index), resourceVersion=str(100 + index), generation=1)
            metadata["labels"].pop("appliance.magicstick.dev/owner-uid", None)
            if item["kind"] == "HTTPRoute" and metadata["name"].endswith("-callback"):
                local = "-local-" in metadata["name"]
                item["spec"]["hostnames"] = ["magicstick.local" if local else "magicstick.example.com"]
            if item["kind"] == "SecurityPolicy":
                local = "-local-" in metadata["name"]
                root = "magicstick.local" if local else "magicstick.example.com"
                item["spec"]["oidc"]["redirectURL"] = "https://" + root + "/oauth2/callback/" + metadata["name"].removesuffix("-sso")
                item["spec"]["oidc"]["cookieDomain"] = root
                item["spec"]["oidc"].pop("cookieNames")
                item["spec"]["extAuth"]["headersToExtAuth"] = ["Cookie", "Authorization"]
                item["spec"]["jwt"]["providers"][0]["extractFrom"]["cookies"] = ["AccessToken-legacy"]
                # Kubernetes defaults the guard's Service reference.
                item["spec"]["extAuth"]["http"]["backendRefs"][0].update(group="", kind="Service", weight=1)
            self.resources[self.key(item)] = item
        self.writes = []
        self.applied, self.keys, self.finalizer, self.status = Mock(), Mock(), Mock(), Mock()
        self.reads = 0
        self.before_parent_read = None
        self.before_patch = None
        self.before_create = None

    @staticmethod
    def key(item):
        metadata = item["metadata"]
        return item["apiVersion"], item["kind"], metadata["namespace"], metadata["name"]

    def first(self, kind, suffix=""):
        return next(item for item in self.resources.values()
                    if item["kind"] == kind and item["metadata"]["name"].endswith(suffix))

    def read_parent(self, path):
        self.assertEqual(path, self.controller["app_instance_path"](self.instance))
        self.reads += 1
        if self.before_parent_read:
            self.before_parent_read(self.reads)
        return copy.deepcopy(self.parent)

    def read_resource(self, item):
        return copy.deepcopy(self.resources.get(self.key(item)))

    def patch_resource(self, path, operations, content_type):
        self.assertEqual(content_type, "application/json-patch+json")
        item = next(item for item in self.resources.values() if path == self.controller["resource_path"](
            item["apiVersion"], item["kind"], item["metadata"]["namespace"], item["metadata"]["name"]))
        if self.before_patch:
            self.before_patch(item)
        updated = copy.deepcopy(item)
        self.assertEqual([(op["op"], op["path"]) for op in operations[:2]],
                         [("test", "/metadata/uid"), ("test", "/metadata/resourceVersion")])
        for operation in operations:
            parts = [part.replace("~1", "/").replace("~0", "~") for part in operation["path"].strip("/").split("/")]
            target = updated
            for part in parts[:-1]:
                target = target[part]
            if operation["op"] == "test":
                if target.get(parts[-1]) != operation["value"]:
                    raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            else:
                self.assertIn(operation["op"], ("add", "replace"))
                target[parts[-1]] = copy.deepcopy(operation["value"])
        updated["metadata"]["resourceVersion"] = str(int(updated["metadata"]["resourceVersion"]) + 1)
        self.resources[self.key(item)] = updated
        self.writes.append(("PATCH", copy.deepcopy(updated)))
        return copy.deepcopy(updated)

    def create_resource(self, method, path, item):
        self.assertEqual(method, "POST")
        self.assertEqual(item["kind"], "EnvoyExtensionPolicy")
        expected = self.controller["resource_path"](item["apiVersion"], item["kind"],
            item["metadata"]["namespace"], item["metadata"]["name"]).rsplit("/", 1)[0]
        self.assertEqual(path, expected)
        if self.before_create:
            self.before_create(item)
        if self.key(item) in self.resources:
            raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
        created = copy.deepcopy(item)
        created["metadata"].update(uid="new-gate-" + item["metadata"]["name"], resourceVersion="200", generation=1)
        self.resources[self.key(item)] = created
        self.writes.append(("POST", copy.deepcopy(created)))
        return copy.deepcopy(created)

    def bindings(self):
        return patch.dict(self.controller, {
            "get_json": self.read_parent, "get_applied_resource": self.read_resource,
            "patch_json": self.patch_resource, "request_json": self.create_resource,
            "model_catalog_models": lambda namespace: [],
            "ensure_module_activation": Mock(), "module_ready": lambda *args: True,
            "crd_exists": lambda *args: True, "patch_instance_status": self.status,
            "ensure_app_instance_finalizer": self.finalizer, "apply_resource": self.applied,
            "reconcile_service_key": self.keys,
        })

    def reconcile(self):
        with self.bindings():
            result = self.controller["reconcile_instance"](self.instance, {},
                {"applications": {"hermes": self.definition}}, {"name": "public", "namespace": "flux-system"})
        self.applied.assert_not_called()
        self.keys.assert_not_called()
        self.finalizer.assert_not_called()
        return result

    def test_stopped_model_does_not_block_existing_uid_bound_sso_migration(self):
        original = copy.deepcopy(self.instance)
        identities = {key: item["metadata"]["uid"] for key, item in self.resources.items()}
        self.assertEqual(self.reconcile()[0], "Degraded")
        self.assertEqual(self.status.call_args.args[3], "InvalidModelContext")
        self.assertTrue(self.writes, "the old model precheck prevented all access migration")
        for key, item in self.resources.items():
            if item["kind"] in ("HTTPRoute", "SecurityPolicy", "EnvoyExtensionPolicy"):
                self.assertEqual(item["metadata"]["labels"]["appliance.magicstick.dev/owner-uid"], "instance-uid")
                self.assertEqual(item["spec"], self.desired[key]["spec"] if item["kind"] != "HTTPRoute"
                                 else {**self.desired[key]["spec"], "rules": [
                                     {**rule, "backendRefs": []} for rule in self.desired[key]["spec"]["rules"]]})
            if key in identities:
                self.assertEqual(item["metadata"]["uid"], identities[key])
        self.assertFalse(self.status.call_args.kwargs["access"]["accessGuardReady"])
        self.assertEqual(self.instance, original)

    def test_all_existing_routes_are_fenced_before_any_policy_migration(self):
        self.reconcile()
        self.assertTrue(self.writes)
        first_guard = next(index for index, (_, item) in enumerate(self.writes) if item["kind"] != "HTTPRoute")
        routes = [item for item in self.resources.values() if item["kind"] == "HTTPRoute"]
        self.assertEqual(first_guard, len(routes))
        self.assertTrue(all(not rule["backendRefs"] for _, item in self.writes[:first_guard] for rule in item["spec"]["rules"]))

    def test_catalog_host_label_migrates_only_exact_previous_instance_hosts(self):
        # The generic migration must work even with a stopped model. The
        # native workload and instance identity are never recreated here.
        self.definition["route"]["hostnameLabel"] = "oc"
        desired, _ = self.controller["app_instance_access_resources"](self.instance, self.definition)
        self.desired = {self.key(item): copy.deepcopy(item) for item in desired}
        original = copy.deepcopy(self.instance)
        self.reconcile()
        self.assertEqual(self.instance, original)
        for item in self.resources.values():
            if item["kind"] == "HTTPRoute":
                self.assertIn(".oc.", item["spec"]["hostnames"][0])
                self.assertTrue(all(not rule["backendRefs"] for rule in item["spec"]["rules"]))
        self.assertEqual(self.status.call_args.kwargs["access"]["localURL"], "https://example.oc.magicstick.local/")

    def test_catalog_host_label_does_not_adopt_a_neighbouring_instance_route(self):
        self.definition["route"]["hostnameLabel"] = "oc"
        route = self.first("HTTPRoute", "-local")
        route["spec"]["hostnames"] = ["other.hermes.magicstick.local"]
        self.reconcile()
        self.assertEqual(self.writes, [])

    def test_new_invalid_instance_provisions_nothing(self):
        self.resources.clear()
        self.reconcile()
        self.assertFalse(self.writes)
        self.assertEqual(self.status.call_args.args[3], "InvalidModelContext")

    def test_unowned_or_partial_existing_resources_are_never_adopted(self):
        mutations = (
            lambda: self.first("SecurityPolicy")["spec"]["extAuth"]["http"].update(path="/internal/instance-access/hermes-example/foreign-uid"),
            lambda: self.first("SecurityPolicy")["spec"]["extAuth"].update(failOpen=True),
            lambda: self.first("SecurityPolicy")["spec"]["extAuth"].update(headersToExtAuth=["*"]),
            lambda: self.first("SecurityPolicy")["spec"]["extAuth"]["headersToExtAuth"].append("X-Unowned-Header"),
            lambda: self.first("SecurityPolicy")["spec"]["extAuth"]["http"]["backendRefs"][0].update(name="other-api"),
            lambda: self.first("SecurityPolicy")["metadata"]["labels"].update({"appliance.magicstick.dev/owner-uid": "foreign-uid"}),
            lambda: self.first("SecurityPolicy")["metadata"]["labels"].update({"app.kubernetes.io/managed-by": "another-controller"}),
            lambda: self.first("SecurityPolicy")["spec"]["targetRefs"].append({"kind": "HTTPRoute", "name": "foreign-route"}),
            lambda: self.first("HTTPRoute")["metadata"]["labels"].update({"appliance.magicstick.dev/appinstance": "another-instance"}),
            lambda: self.first("HTTPRoute")["spec"]["rules"][0]["backendRefs"][0].update(name="other-service"),
            lambda: self.first("HTTPRoute")["spec"].update(hostnames=["other.example.local"]),
            lambda: self.first("HTTPRoute")["spec"]["parentRefs"][0].update(name="other-gateway"),
            lambda: self.first("HTTPRoute")["metadata"].update(deletionTimestamp="2026-11-01T00:00:00Z"),
            lambda: self.first("HTTPRoute")["metadata"].pop("resourceVersion"),
            lambda: self.resources.pop(self.key(self.first("HTTPRoute"))),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.setUp()
                mutate()
                self.reconcile()
                self.assertFalse(self.writes)
                self.assertEqual(self.status.call_args.args[3], "AccessMigrationBlocked")

    def test_parent_identity_intent_revision_and_deletion_are_rechecked(self):
        mutations = (
            lambda: self.parent["metadata"].update(uid="replacement-uid"),
            lambda: self.parent["metadata"].update(generation=3),
            lambda: self.parent["metadata"].update(resourceVersion="11"),
            lambda: self.parent["metadata"].update(deletionTimestamp="2026-11-01T00:00:00Z"),
            lambda: self.parent["spec"].update(enabled=False),
            lambda: self.parent["spec"].update(access={"authentication": "none"}),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.setUp()
                self.before_parent_read = lambda count: mutate() if count == 2 else None
                self.reconcile()
                self.assertFalse(self.writes)
                self.status.assert_not_called()

    def test_migration_is_idempotent_and_does_not_duplicate_guards(self):
        self.reconcile()
        self.assertTrue(self.writes)
        first = copy.deepcopy(self.resources)
        self.writes.clear()
        self.reconcile()
        self.assertEqual(self.resources, first)
        self.assertFalse(self.writes)

    def test_no_finalizer_or_missing_snapshot_identity_cannot_authorize_migration(self):
        for field in ("uid", "resourceVersion", "generation", "namespace", "finalizers"):
            with self.subTest(field=field):
                self.setUp()
                self.instance["metadata"].pop(field)
                with self.bindings():
                    self.assertIsNone(self.controller["migrate_existing_app_instance_access"](self.instance, self.definition))
                self.assertFalse(self.writes)

    def test_disabled_deleting_or_public_instance_cannot_use_sso_migration(self):
        for mode in ("disabled", "deleting", "public"):
            with self.subTest(mode=mode):
                self.setUp()
                if mode == "disabled":
                    self.instance["spec"]["enabled"] = False
                elif mode == "deleting":
                    self.instance["metadata"]["deletionTimestamp"] = "2026-11-01T00:00:00Z"
                else:
                    self.instance["spec"]["access"] = {"authentication": "none"}
                with self.bindings():
                    self.assertIsNone(self.controller["migrate_existing_app_instance_access"](self.instance, self.definition))
                self.assertFalse(self.writes)

    def test_child_uid_or_revision_race_is_rejected_atomically_without_retry(self):
        for field, value in (("uid", "same-name-replacement"), ("resourceVersion", "999")):
            with self.subTest(field=field):
                self.setUp()
                calls = []
                def replace(item):
                    calls.append(item["kind"])
                    item["metadata"][field] = value
                self.before_patch = replace
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.reconcile()
                self.assertEqual(caught.exception.code, 409)
                self.assertEqual(calls, ["HTTPRoute"])
                self.assertFalse(self.writes)

    def test_parent_change_between_mutations_stops_further_writes(self):
        self.before_parent_read = lambda count: self.parent["spec"].update(enabled=False) if count == 3 else None
        self.reconcile()
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(self.writes[0][1]["kind"], "HTTPRoute")
        self.status.assert_not_called()
        self.assertTrue(all("cookieDomain" in item["spec"]["oidc"] for item in self.resources.values()
                            if item["kind"] == "SecurityPolicy"))

    def test_created_guard_collision_does_not_adopt_or_overwrite(self):
        def collide(item):
            foreign = copy.deepcopy(item)
            foreign["metadata"]["labels"]["appliance.magicstick.dev/owner-uid"] = "foreign-uid"
            self.resources[self.key(item)] = foreign
        self.before_create = collide
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.reconcile()
        self.assertEqual(caught.exception.code, 409)
        self.assertTrue(all(item["kind"] == "HTTPRoute" for _, item in self.writes))
        self.assertTrue(all("cookieDomain" in item["spec"]["oidc"] for item in self.resources.values()
                            if item["kind"] == "SecurityPolicy"))

    def test_existing_foreign_callback_gate_blocks_before_fencing(self):
        gate = next(copy.deepcopy(item) for item in self.desired.values() if item["kind"] == "EnvoyExtensionPolicy")
        gate["metadata"].update(uid="foreign-gate", resourceVersion="44")
        gate["metadata"]["labels"]["appliance.magicstick.dev/owner-uid"] = "foreign-uid"
        self.resources[self.key(gate)] = gate
        self.reconcile()
        self.assertFalse(self.writes)
        self.assertEqual(self.status.call_args.args[3], "AccessMigrationBlocked")

    def test_parent_read_authorization_or_transport_failure_is_not_swallowed(self):
        for error in (urllib.error.HTTPError("fixture", 403, "Forbidden", {}, None), OSError("fixture transport")):
            with self.subTest(error=type(error).__name__):
                self.setUp()
                with self.bindings(), patch.dict(self.controller, {"get_json": Mock(side_effect=error)}):
                    with self.assertRaises(type(error)):
                        self.controller["migrate_existing_app_instance_access"](self.instance, self.definition)
                self.assertFalse(self.writes)

    def test_route_admission_stays_closed_even_with_verified_callbacks(self):
        with patch.dict(self.controller, {"CALLBACK_REGISTRY_READY": True, "CALLBACK_ADMITTED_UIDS": {"instance-uid"}}):
            self.reconcile()
        self.assertTrue(self.writes)
        self.assertTrue(all(not rule["backendRefs"] for item in self.resources.values()
                            if item["kind"] == "HTTPRoute" for rule in item["spec"]["rules"]))
        self.assertFalse(self.status.call_args.kwargs["access"]["accessGuardReady"])

    def test_validated_model_returns_to_the_normal_guarded_reconcile_path(self):
        self.reconcile()
        self.instance["spec"]["values"]["modelContextTokens"] = 64000
        applied = []
        def accepted(item):
            current = copy.deepcopy(item)
            current["metadata"].update(uid="guard-uid", resourceVersion="22", generation=2)
            current["status"] = {"ancestors": [{"conditions": [
                {"type": "Accepted", "status": "True", "observedGeneration": 2}]}]}
            return current
        with self.bindings(), patch.dict(self.controller, {
            "CALLBACK_REGISTRY_READY": True, "CALLBACK_ADMITTED_UIDS": {"instance-uid"},
            "get_applied_resource": accepted, "apply_resource": lambda item: applied.append(copy.deepcopy(item)),
        }):
            self.controller["reconcile_helm_app_instance"](self.instance, self.definition, {"name": "public"})
        self.assertTrue(any(item["kind"] == "HelmRelease" for item in applied))
        self.assertTrue(all(rule["backendRefs"] for item in applied if item["kind"] == "HTTPRoute"
                            for rule in item["spec"]["rules"]))

    def test_local_word_in_instance_name_does_not_change_public_callback_scope(self):
        def renamed(value):
            return json.loads(json.dumps(value).replace("hermes-example", "hermes-local-example"))
        self.instance, self.parent = renamed(self.instance), renamed(self.parent)
        self.desired = {self.key(item): item for item in (renamed(item) for item in self.desired.values())}
        self.resources = {self.key(item): item for item in (renamed(item) for item in self.resources.values())}
        self.reconcile()
        self.assertTrue(self.writes)
        self.assertEqual(self.status.call_args.args[3], "InvalidModelContext")
        public = self.first("HTTPRoute", "public-callback")
        self.assertEqual(public["spec"]["hostnames"], ["example.hermes.magicstick.example.com"])

    def test_migration_status_tests_parent_uid_and_revision_and_preserves_other_fields(self):
        self.instance["status"] = {"unrelated": "retained", "phase": "Reconciling"}
        with patch.dict(self.controller, {"patch_json": Mock()}) as binding:
            self.controller["patch_instance_status"](self.instance, "Degraded", {}, "InvalidModelContext",
                "synthetic context error", generation=2, guarded=True)
            args = binding["patch_json"].call_args.args
        self.assertTrue(args[0].endswith("/hermes-example/status"))
        self.assertEqual(args[1][:2], [
            {"op": "test", "path": "/metadata/uid", "value": "instance-uid"},
            {"op": "test", "path": "/metadata/resourceVersion", "value": "10"},
        ])
        self.assertEqual(args[1][2]["value"]["unrelated"], "retained")
        self.assertEqual(args[1][2]["value"]["phase"], "Degraded")
        self.assertEqual(args[2], "application/json-patch+json")

    def test_status_only_route_revision_can_advance_after_confirmed_fencing(self):
        advanced = []
        def gateway_status_update(_gate):
            if advanced:
                return
            route = self.first("HTTPRoute", "local-callback")
            route["metadata"]["resourceVersion"] = str(int(route["metadata"]["resourceVersion"]) + 1)
            route["status"] = {"parents": [{"conditions": [{"type": "Accepted", "status": "True"}]}]}
            advanced.append(True)
        self.before_create = gateway_status_update
        self.reconcile()
        self.assertTrue(advanced)
        self.assertEqual(self.status.call_args.args[3], "InvalidModelContext")
        self.assertTrue(all(not rule["backendRefs"] for item in self.resources.values()
                            if item["kind"] == "HTTPRoute" for rule in item["spec"]["rules"]))

    def test_post_fence_refresh_rejects_changed_identity_intent_or_metadata(self):
        changes = (
            lambda item: item["metadata"].update(uid="replacement-uid"),
            lambda item: item["metadata"].update(generation=2),
            lambda item: item["metadata"].update(annotations={"foreign": "change"}),
            lambda item: item["metadata"].update(finalizers=["foreign.example/finalizer"]),
            lambda item: item["metadata"]["labels"].update({"foreign": "change"}),
            lambda item: item["spec"].update(hostnames=["foreign.example.local"]),
        )
        for index, mutate in enumerate(changes):
            with self.subTest(index=index):
                self.setUp()
                done = []
                def changed_after_fence(_gate):
                    if not done:
                        route = self.first("HTTPRoute", "local-callback")
                        mutate(route)
                        route["metadata"]["resourceVersion"] = str(int(route["metadata"]["resourceVersion"]) + 1)
                        done.append(True)
                self.before_create = changed_after_fence
                self.reconcile()
                self.assertEqual(self.status.call_args.args[3], "AccessMigrationBlocked")
                self.assertTrue(all(not rule["backendRefs"] for item in self.resources.values()
                                    if item["kind"] == "HTTPRoute" for rule in item["spec"]["rules"]))


if __name__ == "__main__":
    unittest.main()
