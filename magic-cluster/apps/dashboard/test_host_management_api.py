import copy
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import unittest
import urllib.error

import yaml
from test_dashboard_api import load_server


class HostManagementApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.admin = {"subject": "test-admin", "roles": ["magicstick-admin"]}
        self.plan = {"id": "f" * 64, "state": "available", "experimental": True, "packages": {"linux-generic-hwe-24.04": "1.0"}}
        self.host = {"name": "example-node", "nodeUid": "node-uid", "bootId": "boot-a", "available": True, "plan": self.plan}
        self.api["host_management_status"] = lambda: {"nodes": [self.host]}
        self.requests = []
        self.existing = None

        def request(method, path, body=None):
            self.requests.append((method, path, body))
            if method == "GET":
                if self.existing:
                    return self.existing
                raise urllib.error.HTTPError(path, 404, "not found", {}, io.BytesIO())
            return body
        self.api["request_json"] = request

    def payload(self, action="prepare-gpu", **changes):
        return {"action": action, "nodeName": "example-node", "nodeUid": "node-uid", "bootId": "boot-a",
                "requestId": "a" * 32, "confirmation": "example-node", "acknowledgeDisruption": True,
                "allowExperimental": action == "prepare-gpu", "experimentMode": False,
                "planId": self.plan["id"] if action == "prepare-gpu" else "", **changes}

    def create(self, **changes):
        return self.api["create_host_operation"](self.admin, self.payload(**changes))

    def test_preparation_creates_only_immutable_bounded_request(self):
        self.create()
        body = self.requests[-1][2]
        self.assertEqual(body["kind"], "HostOperation")
        self.assertEqual(body["metadata"]["namespace"], "ai-system")
        self.assertNotIn("packages", body["spec"])
        self.assertNotIn("confirmation", body["spec"])
        self.assertNotIn("test-admin", json.dumps(body))
        self.assertEqual(body["spec"]["planId"], self.plan["id"])

    def test_viewer_operator_and_user_cannot_request_host_actions(self):
        for role in ("magicstick-user", "magicstick-viewer", "magicstick-operator"):
            with self.subTest(role=role), self.assertRaises(self.api["AuthError"]):
                self.api["create_host_operation"]({"roles": [role]}, self.payload("poweroff"))
        self.assertEqual(self.requests, [])

    def test_rejects_missing_confirmation_and_stale_identity(self):
        for changes in ({"confirmation": "wrong"}, {"acknowledgeDisruption": False}, {"acknowledgeDisruption": 1},
                        {"nodeUid": "old"}, {"bootId": "old"}, {"planId": "old"}, {"requestId": "invalid"}, {"nodeName": "wrong"}):
            with self.subTest(changes=changes), self.assertRaises(self.api["RequestError"]):
                self.create(**changes)
        self.assertEqual(self.requests, [])

    def test_unavailable_host_cannot_receive_power_request(self):
        self.host["available"] = False
        with self.assertRaises(self.api["RequestError"]):
            self.create(action="poweroff")

    def test_rejects_arbitrary_fields_actions_and_non_boolean_mode(self):
        for changes in ({"packages": {"any": "latest"}}, {"command": "reboot"}, {"action": "execute"},
                        {"allowExperimental": "true"}, {"experimentMode": 1}):
            with self.subTest(changes=changes), self.assertRaises(self.api["RequestError"]):
                self.create(**changes)

    def test_power_requests_have_no_preparation_overrides(self):
        self.create(action="reboot")
        body = self.requests[-1][2]
        self.assertFalse(body["spec"]["allowExperimental"])
        self.assertFalse(body["spec"]["experimentMode"])
        self.assertEqual(body["spec"]["planId"], "")
        for changes in ({"planId": self.plan["id"]}, {"allowExperimental": True}, {"experimentMode": True}):
            with self.assertRaises(self.api["RequestError"]):
                self.create(action="poweroff", **changes)

    def test_blocked_plan_requires_explicit_experiment_and_candidate_id(self):
        self.plan["experiment"] = {**self.plan, "id": "e" * 64}
        self.plan["state"] = "blocked"
        with self.assertRaises(self.api["RequestError"]):
            self.create(planId="e" * 64)
        self.create(experimentMode=True, planId="e" * 64)
        self.assertTrue(self.requests[-1][2]["spec"]["experimentMode"])
        with self.assertRaises(self.api["RequestError"]):
            self.create(experimentMode=True, planId="e" * 64, allowExperimental=False)

    def test_active_operation_is_not_replaced(self):
        self.existing = {"metadata": {"uid": "operation-1"}, "spec": {"requestId": "b" * 32}, "status": {"phase": "Preparing"}}
        with self.assertRaises(self.api["RequestError"]):
            self.create(action="reboot")
        self.assertEqual([r[0] for r in self.requests], ["GET"])

    def test_same_request_identity_is_idempotent(self):
        self.create(action="reboot")
        self.existing = {**self.requests[-1][2], "status": {"phase": "RebootScheduled"}}
        self.requests.clear()
        self.assertTrue(self.create(action="reboot")["accepted"])
        self.assertEqual([r[0] for r in self.requests], ["GET"])

    def test_request_identity_cannot_be_reused_for_different_action(self):
        self.create(action="reboot")
        self.existing = self.requests[-1][2]
        self.requests.clear()
        with self.assertRaises(self.api["RequestError"]):
            self.create(action="poweroff")
        self.assertEqual([r[0] for r in self.requests], ["GET"])

    def test_terminal_replacement_is_guarded_by_resource_uid(self):
        self.existing = {"metadata": {"uid": "operation-1"}, "spec": {"requestId": "b" * 32}, "status": {"phase": "Failed"}}
        self.create(action="reboot")
        self.assertEqual([r[0] for r in self.requests], ["GET", "DELETE", "POST"])
        self.assertEqual(self.requests[1][2]["preconditions"], {"uid": "operation-1"})

    def test_mutation_handler_requires_admin_and_csrf_before_request(self):
        handler = self.api["Handler"].__new__(self.api["Handler"])
        roles, errors = [], []
        handler.require_access = lambda role: (roles.append(role) or self.admin)
        handler.headers = {}
        handler.send_auth_error = lambda error: errors.append(error.status)
        handler.send_error_json = lambda status, message: errors.append(status)
        handler.handle_host_management(mutate=True)
        self.assertEqual(roles, ["admin"])
        self.assertEqual(errors, [403])
        self.assertFalse(self.requests)


class HostStatusTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.report = {"schemaVersion": 1, "observedAt": datetime.now(timezone.utc).isoformat(), "nodeUid": "node-uid",
                       "bootId": "boot-a", "kernel": "7.0-test", "plan": {"id": "f" * 64}}
        self.node = {"metadata": {"name": "example-node", "uid": "node-uid", "annotations": {}},
                     "status": {"nodeInfo": {"kernelVersion": "7.0-test", "bootID": "boot-a"}}}
        self.api["request_json"] = lambda method, path: {"items": [self.node] if path == "/api/v1/nodes" else []}

    def status(self):
        self.node["metadata"]["annotations"][self.api["HOST_MANAGEMENT_ANNOTATION"]] = json.dumps(self.report)
        return self.api["host_management_status"]()["nodes"][0]

    def test_fresh_local_worker_enables_host_controls(self):
        self.assertTrue(self.status()["available"])

    def test_wrong_node_boot_kernel_and_stale_reports_disable_controls(self):
        initial = copy.deepcopy(self.report)
        for changes in ({"nodeUid": "wrong"}, {"bootId": "wrong"}, {"kernel": "wrong"}, {"schemaVersion": 2},
                        {"observedAt": (datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()}, {"observedAt": "bad"}):
            self.report = {**initial, **changes}
            self.assertFalse(self.status()["available"])
            self.assertIsNone(self.status()["plan"])

    def test_missing_worker_is_not_an_actionable_host(self):
        self.assertFalse(self.api["host_management_status"]()["nodes"][0]["available"])


class HostRbacTests(unittest.TestCase):
    def test_dashboard_never_receives_host_privileges_or_status_writes(self):
        role = list(yaml.safe_load_all((Path(__file__).parent / "host-management-rbac.yaml").read_text()))[0]
        self.assertEqual(role["kind"], "Role")
        self.assertEqual(role["rules"], [{"apiGroups": ["appliance.magicstick.dev"], "resources": ["hostoperations"], "verbs": ["get", "list", "create", "delete"]}])


if __name__ == "__main__":
    unittest.main()
