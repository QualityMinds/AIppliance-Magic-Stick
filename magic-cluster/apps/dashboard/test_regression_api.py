import base64
import copy
import json
import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).parent))
from regression_api import RegressionApi, RUNS, CORE, OWNER, LEASE
from test_dashboard_api import load_server

UID = "11111111-2222-3333-4444-555555555555"
NODE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ACTOR = {"subject": "fixture-admin", "roles": ["magicstick-admin"]}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class RegressionApiTests(unittest.TestCase):
    def setUp(self):
        self.objects = {"/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/appliances/local": {"metadata": {"uid": UID}},
            "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/moduleactivations/regression": {"spec": {"enabled": True}},
            "/apis/apps/v1/namespaces/magicstick-regression/deployments/regression-reports": {"metadata": {"generation": 1},
                "spec": {"replicas": 1}, "status": {"observedGeneration": 1, "availableReplicas": 1, "updatedReplicas": 1}},
            CORE + "/configmaps/magicstick-regression-runtime": {"data": {"image": "ghcr.io/qualityminds/magicstick-regression:sha-" + "b"*40 + "@sha256:" + "a"*64, "sourceRevision": "b"*40}}}
        self.users, self.writes = {}, []
        self.identity_without_location = False
        self.identity_without_attribute = False
        self.functions = {"RequestError": RequestError, "get_resource": lambda path: copy.deepcopy(self.objects.get(path)),
            "list_resource": self.list, "request_json": self.write, "patch_json": self.patch,
            "settings_response": lambda: {"mdnsDomain": "example.local"}, "live_admin_actor": lambda _: None,
            "keycloak_admin_request": self.identity, "_realm_path": lambda p: "/realm" + p,
            "_user_path": lambda uid: "/user/" + uid, "_replace_managed_roles": lambda *_: None,
            "ACCESS_LEVEL_ROLES": {"admin": ["magicstick-admin"], "viewer": ["magicstick-viewer"]}, "kubernetes_access_info": lambda **_: {"oidcCa": "PUBLIC-CA-NOT-A-KEY"},
            "_exact_user_matches": lambda field, value: [copy.deepcopy(u) for u in self.users.values() if u.get(field) == value],
            "regression_report_bytes": lambda uid, name: b"sanitized-report"}
        self.service = RegressionApi(self.functions)
        self.service.register(ACTOR, {"confirmation": "DISPOSABLE TEST SERVER", "acknowledgeDisruption": True})
        self.objects["/apis/gateway.networking.k8s.io/v1/namespaces/identity-system/gateways/pilot"] = {"status": {"addresses": [{"type": "IPAddress", "value": "192.0.2.10"}]}}
        self.writes.clear()

    def list(self, path):
        if path == "/api/v1/nodes":
            return [{"metadata": {"uid": NODE}}]
        if path == RUNS:
            return [copy.deepcopy(value) for key, value in self.objects.items() if key.startswith(RUNS + "/")]
        if "httproutes" in path:
            return [{"metadata": {"namespace": "identity-system"}, "spec": {"hostnames": ["example.local"], "parentRefs": [{"name": "pilot"}]}}]
        if "/pods" in path:
            return getattr(self, "pods", [])
        return []

    def write(self, method, path, data):
        self.writes.append((method, path, copy.deepcopy(data)))
        if method == "DELETE":
            del self.objects[path]
            return {}
        value = copy.deepcopy(data)
        value["metadata"].update(uid=UID, resourceVersion="1", creationTimestamp="2026-10-13T12:00:00Z")
        if path == RUNS and value["metadata"]["name"] != "regression-" + "1"*32:
            value["metadata"]["uid"] = "66666666-7777-8888-9999-" + value["metadata"]["name"][-12:]
        if "stringData" in value:
            value["data"] = {k: base64.b64encode(v.encode()).decode() for k, v in value.pop("stringData").items()}
        key = path + "/" + value["metadata"]["name"]
        if key in self.objects:
            raise RequestError(409, "Already exists")
        self.objects[key] = value
        return copy.deepcopy(value)

    def patch(self, path, data):
        self.writes.append(("PATCH", path, copy.deepcopy(data)))
        if path.endswith("/status"):
            obj = self.objects[path.removesuffix("/status")]
        else:
            obj = self.objects[path]
        for key, value in data.items():
            if key == "stringData":
                obj.setdefault("data", {}).update({k: base64.b64encode(v.encode()).decode() for k, v in value.items()})
            else:
                obj.setdefault(key, {}).update(value)
        return copy.deepcopy(obj)

    def identity(self, method, path, data=None):
        if method == "POST":
            created = copy.deepcopy(data)
            if self.identity_without_attribute:
                created.pop("attributes", None)
            self.users["fixture-user"] = {**created, "id": "fixture-user"}
            return {}, ({} if self.identity_without_location else {"Location": "/user/fixture-user"})
        if method == "DELETE":
            del self.users[path.split("/")[-1]]
            return {}, {}
        return {}, {}

    def start(self, request="1"*32):
        return self.service.start(ACTOR, {"requestId": request, "acknowledgeDisruption": True})

    def test_non_destructive_mode_is_saved_uses_only_viewer_and_distinct_readiness(self):
        roles = Mock()
        self.functions["_replace_managed_roles"] = roles
        payload = {"requestId": "1"*32, "acknowledgeDisruption": True, "phases": [3], "testMode": "non-destructive"}
        run = self.service.start(ACTOR, payload)
        self.assertEqual(run["testMode"], "non-destructive")
        saved = self.objects[RUNS + "/" + run["id"]]
        self.assertEqual(saved["spec"]["testMode"], "non-destructive")
        self.assertEqual(saved["metadata"]["annotations"], {"regression.magicstick.dev/non-destructive-credentials-ready": UID})
        roles.assert_called_once_with("fixture-user", ["magicstick-viewer"])
        account = json.loads(base64.b64decode(self.objects[CORE + "/secrets/" + run["id"]]["data"]["account.json"]))
        self.assertEqual(account["testMode"], "non-destructive")
        self.writes.clear()
        self.assertEqual(run, self.service.start(ACTOR, payload))
        self.assertEqual(self.writes, [])
        with self.assertRaisesRegex(RequestError, "different test mode"):
            self.service.start(ACTOR, {**payload, "testMode": "full"})
        self.assertEqual(self.writes, [])

    def test_invalid_mode_never_creates_an_account_or_run(self):
        for mode in (None, "readonly", "", True, [], {}):
            with self.subTest(mode=mode), self.assertRaises(RequestError):
                self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, "testMode": mode})
            self.assertEqual(self.writes, [])
            self.assertEqual(self.users, {})

    def test_non_destructive_start_never_recovers_or_reuses_previous_destructive_access(self):
        self.stale_run()
        before = copy.deepcopy(self.objects)
        with self.assertRaisesRegex(RequestError, "Clean up the previous run separately"):
            self.service.start(ACTOR, {"requestId": "2"*32, "acknowledgeDisruption": True, "testMode": "non-destructive"})
        self.assertEqual(self.objects, before)
        self.assertEqual(self.writes, [])

    def test_non_destructive_start_never_clears_an_external_or_expired_lock(self):
        self.objects[LEASE] = {"metadata": {}, "spec": {"holderIdentity": "external-owner"}}
        with self.assertRaisesRegex(RequestError, "never recover or clear"):
            self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, "testMode": "non-destructive"})
        self.assertEqual(self.writes, [])
        self.assertEqual(self.users, {})

    def test_pruning_by_an_old_schema_cannot_downgrade_safe_mode_to_an_admin_account(self):
        original = self.functions["request_json"]
        def old_schema(method, path, value):
            if path == RUNS:
                value = copy.deepcopy(value)
                value["spec"].pop("testMode", None)
            return original(method, path, value)
        self.functions["request_json"] = old_schema
        with self.assertRaises(RequestError):
            self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, "testMode": "non-destructive"})
        self.assertEqual(self.users, {})
        self.assertFalse(any("/secrets" in path for _, path, _ in self.writes))

    def test_non_destructive_terminated_account_cleanup_needs_no_setup_recovery(self):
        run = self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, "testMode": "non-destructive"})
        saved = self.objects[RUNS + "/" + run["id"]]
        saved["metadata"]["annotations"]["regression.magicstick.dev/credentials-used"] = UID
        saved["status"] = {"phase": "Cancelled", "credentialRecoveryRequired": False}
        self.service.cleanup(saved)
        self.assertEqual(self.users, {})
        self.assertTrue(saved["status"]["credentialsCleaned"])

    def stale_run(self):
        run = self.start()
        self.objects[RUNS + "/" + run["id"]]["status"] = {"phase": "Failed", "credentialRecoveryRequired": True,
            "progress": {"ownedRunIds": ["reg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]}}
        self.objects[LEASE] = {"metadata": {"uid": UID, "resourceVersion": "42",
            "labels": {"regression.magicstick.dev/appliance-uid": UID},
            "annotations": {"regression.magicstick.dev/kubernetes-run-uid": UID,
                "regression.magicstick.dev/run-id": "reg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}},
            "spec": {"holderIdentity": "reg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "renewTime": "2026-10-08T00:00:00Z", "leaseDurationSeconds": 120}}
        self.writes.clear()
        return run

    def recover(self, revision=None, request="2"*32):
        return self.service.recover_lock(ACTOR, {"requestId": request, "expectedLockRevision": revision or UID + ":42", "acknowledgeCleanup": True})

    def test_stale_lock_status_is_read_only_and_external_journals_are_not_guessed(self):
        self.stale_run()
        self.assertTrue(self.service.list()["lock"]["canRecover"])
        self.assertEqual(self.writes, [])
        del self.objects[LEASE]["metadata"]["annotations"]
        self.objects[LEASE]["spec"]["holderIdentity"] = "reg-12345678-1234-1234-1234-123456789abc"
        status = self.service.list()["lock"]
        self.assertEqual(status["state"], "stale")
        self.assertFalse(status["canRecover"])
        self.assertIn("external runner", status["message"])
        with self.assertRaisesRegex(RequestError, "external runner"):
            self.recover()
        self.assertEqual(self.writes, [])

    def test_recovery_creates_only_zero_phase_intent_reuses_identity_and_is_idempotent(self):
        original = self.stale_run()
        lock_before = copy.deepcopy(self.objects[LEASE])
        recovered = self.recover()
        self.assertEqual(recovered, self.recover())
        self.assertEqual(recovered["operation"], "recover-lock")
        self.assertEqual(recovered["phases"], [])
        saved = self.objects[RUNS + "/" + recovered["id"]]
        self.assertEqual(saved["spec"]["lockRecovery"], {"uid": UID, "resourceVersion": "42", "runId": "reg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"})
        self.assertEqual(saved["spec"]["accountRunName"], original["id"])
        self.assertEqual(saved["metadata"]["annotations"]["regression.magicstick.dev/recovery-credentials-ready"], saved["metadata"]["uid"])
        self.assertNotIn("regression.magicstick.dev/credentials-ready", saved["metadata"]["annotations"])
        self.assertEqual(len(self.users), 1)
        self.assertEqual(self.objects[LEASE], lock_before)
        self.assertFalse(any("/jobs" in path or path == LEASE for _, path, _ in self.writes))
        with self.assertRaises(RequestError):
            self.start("2"*32)

    def test_recovery_refuses_changed_snapshot_missing_confirmation_and_browser_commands(self):
        self.stale_run()
        with self.assertRaisesRegex(RequestError, "changed after review"):
            self.recover(UID + ":41")
        for extra in ({"command": "arbitrary"}, {"acknowledgeCleanup": False}, {"expectedLockRevision": ""}):
            payload = {"requestId": "2"*32, "expectedLockRevision": UID + ":42", "acknowledgeCleanup": True, **extra}
            with self.assertRaises(RequestError):
                self.service.recover_lock(ACTOR, payload)
        self.assertEqual(self.writes, [])

    def test_active_owner_active_pods_foreign_identity_and_unknown_expiry_are_not_recovered(self):
        self.stale_run()
        original = copy.deepcopy(self.objects[LEASE])
        for replacement in ({"spec": {"renewTime": "2999-01-01T00:00:00Z"}}, {"spec": {"leaseDurationSeconds": True}},
                            {"metadata": {"labels": {"regression.magicstick.dev/appliance-uid": "foreign"}}}):
            with self.subTest(replacement=replacement):
                self.objects[LEASE] = copy.deepcopy(original)
                for key, value in replacement.items():
                    self.objects[LEASE][key].update(value)
                self.assertFalse(self.service.list()["lock"]["canRecover"])
                with self.assertRaises(RequestError):
                    self.recover()
        self.objects[LEASE] = original
        self.pods = [{"metadata": {"labels": {OWNER: UID}}, "status": {"phase": "Running"}}]
        self.assertFalse(self.service.list()["lock"]["canRecover"])
        with self.assertRaisesRegex(RequestError, "active Pods"):
            self.recover()
        self.assertEqual(self.writes, [])

    def test_recovery_is_admin_only_even_without_a_license(self):
        self.stale_run()
        self.functions["live_admin_actor"] = Mock(side_effect=RequestError(403, "Administrator required"))
        self.functions["license_service"] = Mock(side_effect=AssertionError("Recovery must not consult licensing"))
        with self.assertRaises(RequestError) as error:
            self.recover()
        self.assertEqual(error.exception.status, 403)
        self.functions["license_service"].assert_not_called()
        self.assertEqual(self.writes, [])

    def test_free_lock_disables_recovery_and_start_remains_a_separate_action(self):
        self.stale_run()
        self.objects[RUNS + "/regression-" + "1"*32]["status"].update(credentialsCleaned=True, credentialRecoveryRequired=False)
        self.objects[LEASE]["spec"]["holderIdentity"] = ""
        self.assertEqual(self.service.list()["lock"]["state"], "free")
        with self.assertRaisesRegex(RequestError, "No previous test run"):
            self.recover()
        self.assertEqual(self.writes, [])

    def test_free_lock_with_retained_access_offers_zero_phase_cleanup_not_a_new_suite(self):
        original = self.stale_run()
        self.objects[LEASE]["spec"]["holderIdentity"] = ""
        before = copy.deepcopy(self.objects[LEASE])
        status = self.service.list()
        self.assertFalse(status["lock"]["canRecover"])
        self.assertTrue(status["cleanup"]["available"])
        self.assertTrue(status["cleanup"]["released"])
        self.assertEqual(self.writes, [])
        cleaned = self.recover()
        spec = self.objects[RUNS + "/" + cleaned["id"]]["spec"]
        self.assertEqual(spec["phases"], [])
        self.assertTrue(spec["lockRecovery"]["released"])
        self.assertEqual(spec["accountRunName"], original["id"])
        self.assertEqual(len(self.users), 1)
        self.assertEqual(self.objects[LEASE], before)
        self.assertEqual(cleaned, self.recover())

    def test_free_lock_cleanup_rejects_changed_revision_and_unlinked_journal(self):
        self.stale_run()
        self.objects[LEASE]["spec"]["holderIdentity"] = ""
        with self.assertRaisesRegex(RequestError, "changed after review"):
            self.recover(UID + ":41")
        self.objects[LEASE]["metadata"]["annotations"]["regression.magicstick.dev/run-id"] = "reg-12345678-1234-1234-1234-123456789abc"
        status = self.service.list()["cleanup"]
        self.assertFalse(status["available"])
        self.assertIn("exact journal", status["message"])
        with self.assertRaises(RequestError):
            self.recover()
        self.assertEqual(self.writes, [])

    def test_host_maintenance_and_a_new_owner_never_become_test_cleanup_targets(self):
        self.stale_run()
        self.objects[LEASE]["metadata"]["annotations"]["regression.magicstick.dev/host-maintenance"] = "true"
        self.assertIn("Host software", self.service.list()["cleanup"]["message"])
        self.assertFalse(self.service.list()["cleanup"]["available"])
        with self.assertRaises(RequestError):
            self.recover()
        runs = self.list(RUNS)
        status = self.service.cleanup_status(runs, self.service.registration(), {"state": "free"})
        self.assertFalse(status["available"])
        self.assertIn("reservation changed", status["message"])
        self.assertEqual(self.writes, [])

    def test_read_and_reload_never_start_jobs_or_create_credentials(self):
        for _ in range(3):
            status = self.service.list()
            self.assertTrue(status["registered"])
            self.assertTrue(status["runtimeAvailable"])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.users, {})

    def test_first_status_without_optional_runner_never_reads_its_unavailable_lease(self):
        initial = copy.deepcopy(self.objects)
        activation_path = "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/moduleactivations/regression"
        for activation in (None, {"spec": {"enabled": False}}, {"spec": {"enabled": True}}):
            with self.subTest(activation=activation):
                self.objects = {path: copy.deepcopy(value) for path, value in initial.items()
                                if not path.startswith(CORE + "/") and path != activation_path}
                if activation is not None:
                    self.objects[activation_path] = activation
                reads = []

                def get_resource(path):
                    reads.append(path)
                    if path == LEASE:
                        raise urllib.error.HTTPError(path, 403, "Optional namespace RBAC is not installed", {}, None)
                    return copy.deepcopy(self.objects.get(path))

                self.functions["get_resource"] = get_resource
                self.functions["license_service"] = Mock(side_effect=AssertionError("First status is not licensed"))
                for _ in range(2):
                    status = self.service.list()
                    self.assertFalse(status["registered"])
                    self.assertFalse(status["runtimeAvailable"])
                    self.assertEqual(status["sourceRevision"], "")
                    self.assertEqual(status["runs"], [])
                    self.assertEqual(status["lock"]["state"], "blocked")
                    self.assertFalse(status["lock"]["canRecover"])
                    self.assertFalse(status["cleanup"]["available"])
                    self.assertIn("Enable", status["message"])
                self.assertNotIn(LEASE, reads)
                self.assertEqual(self.writes, [])
                self.assertEqual(self.users, {})
                self.functions["license_service"].assert_not_called()
                server = load_server()
                handler = server["Handler"].__new__(server["Handler"])
                handler.route = lambda: "/api/regression"
                handler.require_access = Mock(return_value=ACTOR)
                handler.send_json, handler.send_error_json, handler.send_auth_error = Mock(), Mock(), Mock()
                with patch("regression_api.RegressionApi", return_value=self.service):
                    handler.handle_regression()
                handler.send_json.assert_called_once_with(status)
                handler.send_error_json.assert_not_called()
                handler.send_auth_error.assert_not_called()

    def test_retained_registration_run_or_runtime_never_hides_forbidden_lock_reads(self):
        initial = copy.deepcopy(self.objects)
        for retained in ("registration", "run", "runtime"):
            with self.subTest(retained=retained):
                self.objects = {path: copy.deepcopy(value) for path, value in initial.items()
                                if not path.startswith(CORE + "/")}
                if retained == "registration":
                    self.objects[CORE + "/configmaps/registered-lab"] = initial[CORE + "/configmaps/registered-lab"]
                elif retained == "runtime":
                    self.objects[CORE + "/configmaps/magicstick-regression-runtime"] = initial[CORE + "/configmaps/magicstick-regression-runtime"]
                else:
                    self.objects[RUNS + "/regression-" + "1" * 32] = {
                        "metadata": {"name": "regression-" + "1" * 32, "uid": UID},
                        "status": {"phase": "Passed", "credentialsCleaned": True}}

                def get_resource(path):
                    if path == LEASE:
                        raise urllib.error.HTTPError(path, 403, "Lease access denied", {}, None)
                    return copy.deepcopy(self.objects.get(path))

                self.functions["get_resource"] = get_resource
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.service.list()
                self.assertEqual(error.exception.code, 403)
                self.assertEqual(self.writes, [])

    def test_runner_lifecycle_and_all_reports_do_not_require_or_activate_a_license(self):
        for index, state in enumerate(("missing", "expired", "invalid", "storage_unavailable"), 1):
            with self.subTest(state=state):
                license_service = Mock()
                license_service.status.return_value = {"state": state, "valid": False, "features": []}
                license_service.require_capability.side_effect = AssertionError("Regression is not license-gated")
                self.functions["license_service"] = Mock(return_value=license_service)
                self.service.register(ACTOR, {"confirmation": "DISPOSABLE TEST SERVER", "acknowledgeDisruption": True})
                self.assertTrue(self.service.list()["runtimeAvailable"])
                run = self.start(f"{index:032x}")
                self.service.cancel(ACTOR, run["id"], {"acknowledgeDisruption": True})
                saved = self.objects[RUNS + "/" + run["id"]]
                saved["status"] = {"phase": "Cancelled", "reportAvailable": True}
                for kind in ("archive", "html", "junit"):
                    self.assertEqual(self.service.artifact(run["id"], kind)[0], b"sanitized-report")
                self.service.cleanup(saved)
                self.functions["license_service"].assert_not_called()
                self.assertEqual(self.users, {})
        self.assertFalse(any("license" in path for _, path, _ in self.writes))

    def test_start_waits_for_report_store_readiness_and_enabled_module(self):
        self.objects["/apis/apps/v1/namespaces/magicstick-regression/deployments/regression-reports"]["status"]["updatedReplicas"] = 0
        self.assertFalse(self.service.list()["runtimeAvailable"])
        with self.assertRaises(RequestError):
            self.start()
        self.assertEqual(self.users, {})

    def test_explicit_registration_is_immutable_and_installation_bound(self):
        self.objects[CORE + "/configmaps/registered-lab"]["data"]["nodeUids"] = "replacement-node"
        with self.assertRaisesRegex(RequestError, "different Appliance"):
            self.service.list()
        self.assertEqual(self.writes, [])

    def test_registration_requires_exact_warning_and_never_accepts_urls(self):
        for payload in ({"confirmation": "test", "acknowledgeDisruption": True},
                        {"confirmation": "DISPOSABLE TEST SERVER", "acknowledgeDisruption": False},
                        {"confirmation": "DISPOSABLE TEST SERVER", "acknowledgeDisruption": True, "url": "https://foreign.local"}):
            with self.assertRaises(RequestError):
                self.service.register(ACTOR, payload)
        self.assertEqual(self.writes, [])

    def test_run_is_idempotent_and_creates_only_intent_and_private_generated_account(self):
        run = self.start()
        self.assertEqual(run, self.start())
        self.assertEqual(run["phases"], list(range(9)))
        self.assertNotIn("password", json.dumps(run))
        self.assertNotIn("PUBLIC-CA", json.dumps(run))
        self.assertFalse(any("/jobs" in path for _, path, _ in self.writes))
        self.assertEqual(len(self.users), 1)
        secret = self.objects[CORE + "/secrets/" + run["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        self.assertEqual(account["registration"]["applianceUid"], UID)
        self.assertEqual(account["caPem"], "PUBLIC-CA-NOT-A-KEY")
        self.assertEqual(account["gatewayIp"], "192.0.2.10")

    def test_start_recovers_created_identity_when_keycloak_omits_location_or_custom_attributes(self):
        self.identity_without_location = True
        self.identity_without_attribute = True
        run = self.start()
        secret = self.objects[CORE + "/secrets/" + run["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        self.assertEqual(account["userId"], "fixture-user")
        self.assertEqual(self.users["fixture-user"]["username"], "regression-" + UID.replace("-", ""))
        saved = self.objects[RUNS + "/" + run["id"]]
        self.assertEqual(saved["metadata"]["annotations"]["regression.magicstick.dev/credentials-ready"], UID)

    def test_selected_phases_are_canonical_immutable_and_idempotent(self):
        payload = {"requestId": "1"*32, "acknowledgeDisruption": True, "phases": [5, 3]}
        run = self.service.start(ACTOR, payload)
        self.assertEqual(run["phases"], [3, 5])
        self.assertEqual(self.objects[RUNS + "/" + run["id"]]["spec"]["phases"], [3, 5])
        writes = copy.deepcopy(self.writes)
        self.assertEqual(run, self.service.start(ACTOR, {**payload, "phases": [3, 5]}))
        self.assertEqual(self.writes, writes)
        for phases in ([3], list(range(9))):
            with self.subTest(phases=phases), self.assertRaisesRegex(RequestError, "different phases") as error:
                self.service.start(ACTOR, {**payload, "phases": phases})
            self.assertEqual(error.exception.status, 409)
        with self.assertRaisesRegex(RequestError, "different phases"):
            self.start()
        self.assertEqual(self.writes, writes)

    def test_phase_three_start_retains_the_previous_run_cleanup_reference(self):
        previous = self.stale_run()
        run = self.service.start(ACTOR, {"requestId": "2"*32, "acknowledgeDisruption": True, "phases": [3]})
        spec = self.objects[RUNS + "/" + run["id"]]["spec"]
        self.assertEqual(run["phases"], [3])
        self.assertEqual(spec["phases"], [3])
        self.assertEqual(spec["accountRunName"], previous["id"])
        self.assertEqual(spec["accountRunUid"], previous["uid"])
        self.assertEqual(self.objects[RUNS + "/" + previous["id"]]["status"]["phase"], "Failed")

    def test_invalid_phase_selection_is_rejected_before_any_writes_or_account_creation(self):
        for phases in ([], [3, 3], [-1], [9], [True], [False], [3.0], ["3"], [None], [[3]], {}, None, "3", 3, list(range(10))):
            with self.subTest(phases=phases), self.assertRaises(RequestError) as error:
                self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, "phases": phases})
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.users, {})

    def test_no_parallel_ui_or_external_lease_owner_or_unknown_image(self):
        self.start()
        with self.assertRaisesRegex(RequestError, "Another regression"):
            self.start("2"*32)
        self.objects[RUNS + "/regression-" + "1"*32]["status"] = {"phase": "Passed", "credentialsCleaned": True}
        self.objects["/apis/coordination.k8s.io/v1/namespaces/magicstick-regression/leases/lab-lock"] = {"spec": {"holderIdentity": "external-owner"}}
        with self.assertRaisesRegex(RequestError, "external or interrupted"):
            self.start("2"*32)

    def test_image_commands_and_target_are_not_browser_inputs(self):
        for key in ("image", "command", "url", "nodeUids", "sourceRevision", "phases"):
            with self.assertRaises(RequestError):
                self.service.start(ACTOR, {"requestId": "1"*32, "acknowledgeDisruption": True, key: "arbitrary"})
        self.objects[CORE + "/configmaps/magicstick-regression-runtime"]["data"]["image"] = "image:latest"
        with self.assertRaises(RequestError):
            self.start()
        self.assertEqual(self.users, {})

    def test_cancel_is_an_intent_not_a_job_delete_and_download_is_bounded(self):
        run = self.start()
        self.service.cancel(ACTOR, run["id"], {"acknowledgeDisruption": True})
        self.assertTrue(self.objects[RUNS + "/" + run["id"]]["spec"]["cancelRequested"])
        with self.assertRaises(RequestError):
            self.service.artifact(run["id"], "archive")
        self.objects[RUNS + "/" + run["id"]]["status"] = {"phase": "Blocked", "reportAvailable": True}
        self.assertEqual(self.service.artifact(run["id"], "archive")[0], b"sanitized-report")
        for kind in ("../account.json", "journal.json", "password.txt", "status.json"):
            with self.assertRaises(RequestError):
                self.service.artifact(run["id"], kind)

    def test_cleanup_binds_user_and_secret_uid_and_never_revokes_running_job(self):
        run = self.start()
        self.pods = [{"metadata": {"labels": {OWNER: UID}}, "status": {"phase": "Running"}}]
        with self.assertRaises(RequestError):
            self.service.cleanup(self.objects[RUNS + "/" + run["id"]])
        self.assertEqual(len(self.users), 1)
        self.pods = []
        secret = self.objects[CORE + "/secrets/" + run["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        account["userId"] = "foreign-user-id"
        secret["data"]["account.json"] = base64.b64encode(json.dumps(account).encode()).decode()
        with self.assertRaises(RequestError):
            self.service.cleanup(self.objects[RUNS + "/" + run["id"]])
        account["userId"] = "fixture-user"
        secret["data"]["account.json"] = base64.b64encode(json.dumps(account).encode()).decode()
        self.service.cleanup(self.objects[RUNS + "/" + run["id"]])
        self.assertEqual(self.users, {})
        self.assertTrue(self.objects[RUNS + "/" + run["id"]]["status"]["credentialsCleaned"])

    def test_cleanup_recovers_only_an_empty_persisted_identity_id(self):
        run = self.start()
        self.objects[RUNS + "/" + run["id"]]["status"] = {"phase": "Cancelled"}
        secret = self.objects[CORE + "/secrets/" + run["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        account["userId"] = ""
        secret["data"]["account.json"] = base64.b64encode(json.dumps(account).encode()).decode()
        self.service.cleanup(self.objects[RUNS + "/" + run["id"]])
        self.assertEqual(self.users, {})
        self.assertTrue(self.objects[RUNS + "/" + run["id"]]["status"]["credentialsCleaned"])

        replacement = self.start("2" * 32)
        secret = self.objects[CORE + "/secrets/" + replacement["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        account["userId"] = "foreign-user-id"
        secret["data"]["account.json"] = base64.b64encode(json.dumps(account).encode()).decode()
        with self.assertRaisesRegex(RequestError, "identity was replaced"):
            self.service.cleanup(self.objects[RUNS + "/" + replacement["id"]])
        self.assertIn("fixture-user", self.users)

    def test_non_admin_writes_are_denied_before_any_provisioning(self):
        self.functions["live_admin_actor"] = lambda _: (_ for _ in ()).throw(RequestError(403, "Administrator required"))
        with self.assertRaises(RequestError):
            self.start()
        self.assertEqual(self.writes, [])

    def test_shared_handler_routes_require_admin_and_both_http_methods_are_wired(self):
        server = load_server()
        self.assertEqual(server["required_get_access"](["api", "regression", "runs", "id", "archive"]), "admin")
        self.assertIn("handle_regression", server["Handler"].do_GET.__code__.co_names)
        self.assertIn("handle_regression", server["Handler"].do_POST.__code__.co_names)
        self.assertTrue(callable(server.get("patch_json")), "RegressionApi must receive its status-patch transport in production")

    def test_active_module_cannot_be_disabled_and_requires_admin(self):
        server = load_server()
        with patch.dict(server, {"list_resource": lambda _: [{"status": {"phase": "Running"}}]}):
            with self.assertRaises(server["RequestError"]):
                server["module_activation_payload"]("regression", False)
        self.assertEqual(server["module_mutation_access"]("regression", {}), "admin")

    def test_expired_internal_holder_allows_journal_checked_recovery_without_clearing_lease(self):
        run = self.start()
        self.objects[RUNS + "/" + run["id"]]["status"] = {"phase": "Cancelled", "credentialsCleaned": True}
        lease_path = "/apis/coordination.k8s.io/v1/namespaces/magicstick-regression/leases/lab-lock"
        lease = {"metadata": {"annotations": {"regression.magicstick.dev/kubernetes-run-uid": UID}}, "spec": {
            "holderIdentity": "reg-11111111-2222-3333-4444-555555555555", "renewTime": "2026-01-01T00:00:00Z", "leaseDurationSeconds": 60}}
        self.objects[lease_path] = lease
        self.start("2"*32)
        self.assertEqual(self.objects[lease_path], lease)
        self.assertFalse(any(path == lease_path for _, path, _ in self.writes))

    def test_interrupted_setup_retains_and_reuses_exact_identity_then_cleans_whole_family(self):
        original = self.start()
        obj = self.objects[RUNS + "/" + original["id"]]
        obj["metadata"]["annotations"]["regression.magicstick.dev/credentials-used"] = UID
        obj["status"] = {"phase": "Cancelled"}
        secret = copy.deepcopy(self.objects[CORE + "/secrets/" + original["id"]])
        self.service.cleanup_finished()
        self.assertTrue(self.service.list()["recoveryAvailable"])
        self.assertFalse(obj["status"].get("credentialsCleaned", False))
        self.assertEqual(len(self.users), 1)
        recovered = self.start("2"*32)
        successor = self.objects[RUNS + "/" + recovered["id"]]
        self.assertEqual(successor["spec"]["accountRunName"], original["id"])
        self.assertEqual(successor["spec"]["accountRunUid"], UID)
        self.assertNotIn(CORE + "/secrets/" + recovered["id"], self.objects)
        self.assertEqual(self.objects[CORE + "/secrets/" + original["id"]], secret)
        self.service.cleanup_finished()
        self.assertEqual(len(self.users), 1, "A queued recovery job still owns the original identity")
        successor["status"] = {"phase": "Passed", "credentialRecoveryRequired": False}
        self.service.cleanup_finished()
        self.assertEqual(self.users, {})
        self.assertTrue(obj["status"]["credentialsCleaned"])
        self.assertTrue(successor["status"]["credentialsCleaned"])

    def test_recovery_never_adopts_a_replaced_identity_or_running_predecessor(self):
        original = self.start()
        obj = self.objects[RUNS + "/" + original["id"]]
        obj["status"] = {"phase": "Cancelled", "credentialRecoveryRequired": True}
        self.pods = [{"metadata": {"labels": {OWNER: UID}}, "status": {"phase": "Running"}}]
        with self.assertRaisesRegex(RequestError, "not terminated"):
            self.start("2"*32)
        self.pods = []
        secret = self.objects[CORE + "/secrets/" + original["id"]]
        account = json.loads(base64.b64decode(secret["data"]["account.json"]))
        account["userId"] = "foreign-user-id"
        secret["data"]["account.json"] = base64.b64encode(json.dumps(account).encode()).decode()
        with self.assertRaisesRegex(RequestError, "identity was replaced"):
            self.start("2"*32)
        self.assertEqual(len(self.users), 1)
        self.assertIn(CORE + "/secrets/" + original["id"], self.objects)

    def test_http_routes_reject_non_admin_and_cross_origin_mutations_before_service_calls(self):
        server = load_server()
        handler = server["Handler"].__new__(server["Handler"])
        handler.route = lambda: "/api/regression/runs"
        handler.require_access = Mock(side_effect=server["AuthError"](403, "Administrator required"))
        handler.send_auth_error, handler.send_error_json = Mock(), Mock()
        with patch("regression_api.RegressionApi") as service:
            handler.handle_regression()
            handler.require_access.assert_called_once_with("admin")
            handler.send_auth_error.assert_called_once()
            service.assert_not_called()
        handler.require_access = Mock(return_value=ACTOR)
        for headers in ({}, {"X-MagicStick-CSRF": "dashboard", "Sec-Fetch-Site": "cross-site"}):
            handler.headers = headers
            handler.send_auth_error.reset_mock()
            with patch("regression_api.RegressionApi") as service:
                handler.handle_regression(mutate=True)
                handler.send_auth_error.assert_called_once()
                service.return_value.start.assert_not_called()
                service.return_value.register.assert_not_called()

    def test_http_report_download_is_an_authenticated_attachment_not_executable_inline_html(self):
        server = load_server()
        handler = server["Handler"].__new__(server["Handler"])
        name = "regression-" + "1"*32
        handler.route = lambda: "/api/regression/runs/" + name + "/html"
        handler.require_access = Mock(return_value=ACTOR)
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        handler.wfile = io.BytesIO()
        handler.send_auth_error, handler.send_error_json = Mock(), Mock()
        with patch("regression_api.RegressionApi") as service:
            service.return_value.artifact.return_value = (b"sanitized-report", "fixture.html", "text/html")
            handler.handle_regression()
            service.return_value.artifact.assert_called_once_with(name, "html")
        handler.require_access.assert_called_once_with("admin")
        handler.send_header.assert_any_call("Content-Disposition", 'attachment; filename="fixture.html"')
        handler.send_header.assert_any_call("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        self.assertEqual(handler.wfile.getvalue(), b"sanitized-report")
