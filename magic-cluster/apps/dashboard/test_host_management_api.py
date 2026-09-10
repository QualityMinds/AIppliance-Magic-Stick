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


class GpuMemoryApiTests(HostManagementApiTests):
    def setUp(self):
        super().setUp()
        self.capability = {"id": "d" * 64, "supported": True, "message": "Shared memory configuration available.",
                           "pciAddress": "0000:01:00.0", "systemMemoryMi": 65536,
                           "currentCarveoutIndex": 1, "currentCarveoutMi": 32768, "currentDynamicLimitMi": 32768,
                           "options": [{"index": 0, "label": "Minimum", "sizeMi": 512},
                                       {"index": 1, "label": "Medium", "sizeMi": 32768},
                                       {"index": 2, "label": "High", "sizeMi": 65536}],
                           "systemReserveMi": 16384, "stepMi": 1024, "minDynamicLimitMi": 1024}
        self.host["gpuMemory"] = self.capability

    def memory_payload(self, **changes):
        return self.payload("configure-gpu-memory", planId=self.capability["id"], allowExperimental=True,
                            gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 65536}) | changes

    def configure(self, **changes):
        return self.api["create_host_operation"](self.admin, self.memory_payload(**changes))

    def test_memory_operation_contains_only_bounded_settings(self):
        self.configure()
        spec = self.requests[-1][2]["spec"]
        self.assertEqual(spec["action"], "configure-gpu-memory")
        self.assertEqual(spec["gpuMemory"], {"carveoutIndex": 0, "dynamicLimitMi": 65536})
        self.assertEqual(spec["planId"], self.capability["id"])
        self.assertNotIn("pciAddress", spec)
        self.assertNotIn("systemReserveMi", spec)
        self.assertNotIn("packages", spec)

    def test_each_non_admin_role_cannot_configure_memory(self):
        for role in ("magicstick-viewer", "magicstick-user", "magicstick-operator"):
            with self.subTest(role=role), self.assertRaises(self.api["AuthError"]):
                self.api["create_host_operation"]({"roles": [role]}, self.memory_payload())
        self.assertEqual(self.requests, [])

    def test_stale_identity_consent_and_wrong_operation_mode_rejected(self):
        for changes in ({"planId": "e" * 64}, {"bootId": "boot-old"}, {"nodeUid": "node-old"},
                        {"confirmation": "wrong"}, {"allowExperimental": False}, {"experimentMode": True},
                        {"acknowledgeDisruption": False}):
            with self.subTest(changes=changes), self.assertRaises(self.api["RequestError"]):
                self.configure(**changes)
        self.assertEqual(self.requests, [])

    def test_rejects_unsupported_and_incomplete_capabilities(self):
        baseline = copy.deepcopy(self.capability)
        for key, value in (("supported", False), ("id", ""), ("systemMemoryMi", None), ("currentCarveoutIndex", True),
                           ("currentCarveoutMi", 123), ("systemReserveMi", 0), ("stepMi", 0), ("minDynamicLimitMi", -1),
                           ("options", []), ("options", [{"index": 0, "sizeMi": 512}, {"index": 0, "sizeMi": 1024}])):
            self.host["gpuMemory"] = {**baseline, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(self.api["RequestError"]):
                self.configure()
        self.host["gpuMemory"] = None
        with self.assertRaises(self.api["RequestError"]):
            self.configure()
        self.assertEqual(self.requests, [])

    def test_rejects_unknown_fields_floats_booleans_and_invalid_options(self):
        cases = [None, {}, [], {"carveoutIndex": 0}, {"carveoutIndex": 0, "dynamicLimitMi": 65536, "path": "/etc/example"}]
        for index in (-1, 3, 256, True, 0.0, "0"):
            cases.append({"carveoutIndex": index, "dynamicLimitMi": 65536})
        for dynamic in (-1, 0, True, 1024.0, "1024", 1025, 1048577):
            cases.append({"carveoutIndex": 0, "dynamicLimitMi": dynamic})
        for value in cases:
            with self.subTest(value=value), self.assertRaises(self.api["RequestError"]):
                self.configure(gpuMemory=value)
        self.assertEqual(self.requests, [])

    def test_fixed_and_dynamic_limits_share_one_capacity(self):
        with self.assertRaises(self.api["RequestError"]):
            self.configure(gpuMemory={"carveoutIndex": 2, "dynamicLimitMi": 32768})
        self.configure(gpuMemory={"carveoutIndex": 2, "dynamicLimitMi": 16384})
        self.assertEqual(self.requests[-1][2]["spec"]["gpuMemory"]["dynamicLimitMi"], 16384)

    def test_projection_can_reclaim_firmware_memory_but_preserves_reserve(self):
        self.configure(gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 80896})
        self.requests.clear()
        with self.assertRaises(self.api["RequestError"]):
            self.configure(gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 81920})
        self.assertEqual(self.requests, [])

    def test_rejects_no_op_and_memory_payloads_on_other_actions(self):
        with self.assertRaises(self.api["RequestError"]):
            self.configure(gpuMemory={"carveoutIndex": 1, "dynamicLimitMi": 32768})
        for action in ("prepare-gpu", "poweroff", "reboot"):
            with self.subTest(action=action), self.assertRaises(self.api["RequestError"]):
                self.create(action=action, gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 1024})
        self.assertEqual(self.requests, [])

    def test_memory_request_is_idempotent_and_cannot_change_values(self):
        self.configure()
        self.existing = self.requests[-1][2]
        self.requests.clear()
        self.configure()
        self.assertEqual([item[0] for item in self.requests], ["GET"])
        self.requests.clear()
        with self.assertRaises(self.api["RequestError"]):
            self.configure(gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 64512})
        self.assertEqual([item[0] for item in self.requests], ["GET"])


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

    def test_gpu_memory_evidence_is_returned_only_for_fresh_matching_host(self):
        self.report["gpuMemory"] = {"id": "d" * 64, "supported": True}
        self.assertEqual(self.status()["gpuMemory"], self.report["gpuMemory"])
        self.report["bootId"] = "old-boot"
        self.assertIsNone(self.status()["gpuMemory"])


class HostRbacTests(unittest.TestCase):
    def test_dashboard_never_receives_host_privileges_or_status_writes(self):
        role = list(yaml.safe_load_all((Path(__file__).parent / "host-management-rbac.yaml").read_text()))[0]
        self.assertEqual(role["kind"], "Role")
        self.assertEqual(role["rules"], [{"apiGroups": ["appliance.magicstick.dev"], "resources": ["hostoperations"], "verbs": ["get", "list", "create", "delete"]}])


if __name__ == "__main__":
    unittest.main()
