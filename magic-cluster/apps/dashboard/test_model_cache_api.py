from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "magic-host/roles/host-management/files"))
from test_host_management_api import HostManagementApiTests


class ModelCacheApiTests(unittest.TestCase):
    payload = HostManagementApiTests.payload

    def setUp(self):
        HostManagementApiTests.setUp(self)
        self.host["modelCache"] = {"supported": True, "blocked": False, "id": "a" * 64, "reclaimableBytes": 1234}

    def create(self, **changes):
        return self.api["create_host_operation"](self.admin, self.payload("clear-model-cache", planId="a" * 64) | changes)

    def test_request_has_no_paths_or_commands(self):
        self.create()
        self.assertEqual(self.requests[-1][2]["spec"]["action"], "clear-model-cache")
        self.assertNotIn("path", self.requests[-1][2]["spec"])

    def test_admin_and_exact_host_required(self):
        for role in ("magicstick-viewer", "magicstick-operator", "magicstick-user"):
            with self.assertRaises(self.api["AuthError"]):
                self.api["create_host_operation"]({"roles": [role]}, self.payload("clear-model-cache", planId="a" * 64))
        for change in ({"confirmation": "wrong"}, {"bootId": "old"}, {"acknowledgeDisruption": False}):
            with self.assertRaises(self.api["RequestError"]): self.create(**change)
        self.assertEqual(self.requests, [])

    def test_busy_stale_empty_and_unsupported_cache_cannot_be_cleared(self):
        for field, value in (("supported", False), ("blocked", True), ("id", "b" * 64), ("reclaimableBytes", 0)):
            saved = self.host["modelCache"][field]
            self.host["modelCache"][field] = value
            with self.assertRaises(self.api["RequestError"]): self.create()
            self.host["modelCache"][field] = saved
        self.assertEqual(self.requests, [])

    def test_rejects_paths_commands_and_cross_action_settings(self):
        for change in ({"path": "/"}, {"command": "rm"}, {"gpuMemory": {}}, {"network": {}}, {"updateScope": "all"}, {"allowExperimental": True}):
            with self.assertRaises(self.api["RequestError"]): self.create(**change)
        self.assertEqual(self.requests, [])

    def test_api_exposes_only_public_cache_fields(self):
        value = self.api["public_model_cache"]({**self.host["modelCache"], "token": "private",
            "caches": [{"id": "huggingface", "usedBytes": 123, "path": "/private"}]})
        self.assertNotIn("token", value)
        self.assertNotIn("path", value["caches"][0])


if __name__ == "__main__": unittest.main()
