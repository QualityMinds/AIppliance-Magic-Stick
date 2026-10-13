import base64
import copy
import json
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).parent))
from regression_api import RegressionApi, RUNS, CORE, OWNER
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
            "ACCESS_LEVEL_ROLES": {"admin": ["magicstick-admin"]}, "kubernetes_access_info": lambda **_: {"oidcCa": "PUBLIC-CA-NOT-A-KEY"},
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

    def test_read_and_reload_never_start_jobs_or_create_credentials(self):
        for _ in range(3):
            status = self.service.list()
            self.assertTrue(status["registered"])
            self.assertTrue(status["runtimeAvailable"])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.users, {})

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
