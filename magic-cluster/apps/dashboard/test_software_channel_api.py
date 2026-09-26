# SPDX-License-Identifier: BUSL-1.1
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "magic-host/roles/host-management/files"))
from test_host_management_api import HostManagementApiTests


class SoftwareChannelApiTests(HostManagementApiTests):
    def setUp(self):
        super().setUp()
        self.selected = {"kind": "branch", "value": "feature/my-change"}
        self.host["software"] = {"supported": True, "id": "c" * 64, "channel": {"kind": "branch", "value": "main"},
            "hostCommit": "a" * 40, "preview": {"id": "d" * 64, "configurationId": "c" * 64, "channel": self.selected,
            "commit": "b" * 40, "checkedAtEpoch": time.time(), "ready": True}}

    def software_payload(self, action="apply-software-channel", **changes):
        return self.payload(action, planId="c" * 64, softwareChannel=self.selected,
                            **({"softwarePreviewId": "d" * 64} if action == "apply-software-channel" else {})) | changes

    def test_administrator_can_submit_feature_branch_only_as_bounded_intent(self):
        self.api["create_host_operation"](self.admin, self.software_payload())
        spec = self.requests[-1][2]["spec"]
        self.assertEqual(spec["softwareChannel"], self.selected)
        self.assertEqual(spec["softwarePreviewId"], "d" * 64)
        self.assertNotIn("repository", spec)
        self.assertEqual(self.requests[-1][2]["kind"], "HostOperation")

    def test_non_admin_cannot_check_or_apply(self):
        for action in ("check-software-channel", "apply-software-channel"):
            for role in ("magicstick-viewer", "magicstick-operator", "magicstick-user"):
                with self.assertRaises(self.api["AuthError"]):
                    self.api["create_host_operation"]({"roles": [role]}, self.software_payload(action))
        self.assertFalse(self.requests)

    def test_stale_preview_and_injection_rejected_before_writes(self):
        for changes in ({"softwarePreviewId": "e" * 64}, {"softwareChannel": {"kind": "branch", "value": "main;id"}},
                        {"repository": "https://example.com"}, {"planId": "f" * 64}, {"gpuMemory": {}},
                        {"softwareChannel": {"kind": "commit", "value": "abc123"}}):
            with self.assertRaises(self.api["RequestError"]):
                self.api["create_host_operation"](self.admin, self.software_payload(**changes))
        self.assertFalse(self.requests)

    def test_software_fields_cannot_be_smuggled_into_other_operations(self):
        with self.assertRaises(self.api["RequestError"]):
            self.api["create_host_operation"](self.admin, self.payload("reboot", softwareChannel=self.selected))

    def test_public_status_excludes_local_paths_and_process_identity(self):
        result = self.api["public_host_software"]({**self.host["software"], "repository": "private", "checkout": "/root/private", "operation": {"pid": 42, "phase": "Applying", "requestId": "a" * 32}})
        self.assertNotIn("repository", result)
        self.assertNotIn("checkout", result)
        self.assertNotIn("pid", result["operation"])
