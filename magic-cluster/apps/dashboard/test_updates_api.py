from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "magic-host/roles/host-management/files"))
from updates_contract import DEFAULT_POLICY, policy_id
from test_host_management_api import HostManagementApiTests


class UpdatesApiTests(unittest.TestCase):
    payload = HostManagementApiTests.payload

    def setUp(self):
        HostManagementApiTests.setUp(self)
        self.capability = {"supported": True, "id": policy_id(DEFAULT_POLICY), "policy": dict(DEFAULT_POLICY), "busy": False}
        self.host["updates"] = self.capability

    def update_payload(self, action="check-updates", **changes):
        return self.payload(action, planId=self.capability["id"]) | changes

    def create(self, action="check-updates", **changes):
        return self.api["create_host_operation"](self.admin, self.update_payload(action, **changes))

    def test_settings_create_bounded_request_without_commands(self):
        self.create("configure-updates", updatePolicy={**DEFAULT_POLICY, "windowStart": "22:00"})
        body = self.requests[-1][2]
        self.assertEqual(body["kind"], "HostOperation")
        self.assertEqual(body["spec"]["updatePolicy"]["windowStart"], "22:00")
        self.assertNotIn("command", body["spec"])
        self.assertNotIn("updateScope", body["spec"])

    def test_manual_install_scope_is_explicit_and_immutable(self):
        self.create("install-updates", updateScope="security")
        self.existing = self.requests[-1][2]
        self.requests.clear()
        self.create("install-updates", updateScope="security")
        self.assertEqual([r[0] for r in self.requests], ["GET"])
        with self.assertRaises(self.api["RequestError"]):
            self.create("install-updates", updateScope="all")

    def test_updates_require_admin_and_exact_host_consent(self):
        for role in ("magicstick-user", "magicstick-viewer", "magicstick-operator"):
            with self.assertRaises(self.api["AuthError"]):
                self.api["create_host_operation"]({"roles": [role]}, self.update_payload())
        for change in ({"confirmation": "wrong"}, {"acknowledgeDisruption": False}, {"bootId": "old"}):
            with self.assertRaises(self.api["RequestError"]): self.create(**change)
        self.assertEqual(self.requests, [])

    def test_stale_policy_and_unsupported_hosts_rejected(self):
        with self.assertRaises(self.api["RequestError"]): self.create(planId="b" * 64)
        self.capability["supported"] = False
        with self.assertRaises(self.api["RequestError"]): self.create()
        self.assertEqual(self.requests, [])

    def test_update_execution_blocks_all_other_host_actions(self):
        self.capability["busy"] = True
        for action in ("check-updates", "configure-updates", "install-updates", "reboot", "poweroff", "prepare-gpu"):
            with self.subTest(action=action), self.assertRaises(self.api["RequestError"]): self.create(action)
        self.assertEqual(self.requests, [])

    def test_rejects_arbitrary_packages_commands_and_cross_action_settings(self):
        for action, changes in (("check-updates", {"updateScope": "all"}), ("check-updates", {"updatePolicy": DEFAULT_POLICY}),
                                ("check-updates", {"command": "apt dist-upgrade"}), ("check-updates", {"packages": ["curl"]}),
                                ("check-updates", {"gpuMemory": {}}), ("check-updates", {"network": {}}),
                                ("install-updates", {"updateScope": "dist-upgrade"}), ("install-updates", {"updateScope": []}),
                                ("configure-updates", {"updatePolicy": {**DEFAULT_POLICY, "automaticReboot": "true"}}),
                                ("reboot", {"updatePolicy": DEFAULT_POLICY})):
            with self.subTest(action=action, changes=changes), self.assertRaises(self.api["RequestError"]): self.create(action, **changes)
        self.assertEqual(self.requests, [])

    def test_existing_host_operation_is_not_replaced(self):
        self.existing = {"metadata": {"uid": "busy"}, "spec": {"requestId": "b" * 32}, "status": {"phase": "Preparing"}}
        with self.assertRaises(self.api["RequestError"]): self.create()
        self.assertEqual([r[0] for r in self.requests], ["GET"])

    def test_report_filters_private_paths_processes_and_unexpected_fields(self):
        value = self.api["public_host_updates"]({**self.capability, "pid": 1, "path": "/root/private", "packages": [
            {"name": "openssl", "candidate": "2", "installed": "1", "security": True, "blocked": "", "repositoryToken": "redacted"}],
            "policy": {**DEFAULT_POLICY, "command": "not allowed"}})
        self.assertNotIn("pid", value)
        self.assertNotIn("path", value)
        self.assertNotIn("command", value["policy"])
        self.assertNotIn("repositoryToken", value["packages"][0])


if __name__ == "__main__":
    unittest.main()
