# SPDX-License-Identifier: BUSL-1.1
import time
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "magic-host/roles/host-management/files"))
from test_host_management_api import HostManagementApiTests
import release_catalog


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

    def test_release_discovery_is_admin_only_and_does_not_depend_on_a_license(self):
        for role in ("magicstick-viewer", "magicstick-operator", "magicstick-user"):
            with self.assertRaises(self.api["AuthError"]):
                self.api["software_release_catalog"]({"roles": [role]})
        value = {"releases": [], "fetchedAt": "2024-01-01T00:00:00Z", "stale": False}
        with patch.object(release_catalog.ReleaseClient, "catalog", return_value=value) as read:
            self.assertEqual(self.api["software_release_catalog"](self.admin), value)
            self.assertEqual(self.api["software_release_catalog"](self.admin), value)
            read.assert_called_once_with()
        self.assertFalse(self.requests)

    def test_release_discovery_retains_explicit_stale_state_on_public_network_failure(self):
        service = self.api["software_release_catalog"]
        with patch.object(release_catalog.ReleaseClient, "catalog", side_effect=release_catalog.ReleaseError("Public catalog unavailable.")):
            failed = service(self.admin)
        self.assertTrue(failed["stale"])
        self.assertEqual(failed["releases"], [])
        self.assertIn("unavailable", failed["message"])
        good = {"releases": [{"version": "v1.2.3"}], "fetchedAt": "2024-01-01T00:00:00Z", "stale": False}
        self.api["SOFTWARE_RELEASE_CACHE"].update(value=good, at=self.api["time"].monotonic() - 301)
        with patch.object(release_catalog.ReleaseClient, "catalog", side_effect=release_catalog.ReleaseError("Public catalog unavailable.")):
            stale = service(self.admin)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["releases"], good["releases"])
        self.assertFalse(self.requests)

    def test_release_preview_only_exports_valid_fixed_fields_and_exact_license_dates(self):
        proof = {"version": "v1.2.3", "commit": "b" * 40, "tagObject": "a" * 40, "releaseId": 1,
            "manifestDigest": "sha256:" + "c" * 64, "prerelease": False,
            "license": {"schemaVersion": 1, "version": "v1.2.3", "firstPublicDistribution": "2024-02-29", "changeDate": "2027-02-28", "changeLicense": "MIT"}}
        value = self.host["software"]
        value["preview"]["release"] = {**proof, "publisherToken": "synthetic-private-value"}
        result = self.api["public_host_software"](value)
        self.assertEqual(result["preview"]["release"], proof)
        for bad in ({"version": {"private": "value"}}, {"releaseId": True}, {"tagObject": "private"}, {"commit": "d" * 40},
                    {"license": {**proof["license"], "changeDate": "2035-01-01"}}):
            value["preview"]["release"] = {**proof, **bad}
            self.assertNotIn("release", self.api["public_host_software"](value)["preview"])
