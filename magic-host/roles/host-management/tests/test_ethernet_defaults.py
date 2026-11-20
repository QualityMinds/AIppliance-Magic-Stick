import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import call, patch

import yaml


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
import ethernet_defaults as ethernet
import network_config as network


MAC = "02:00:00:00:00:01"


class EthernetPlanTests(unittest.TestCase):
    def test_includes_unplugged_physical_ethernet_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, kind, devtype, device, wifi_marker in (
                ("eno1", "1", "", True, False),
                ("wlp2s0", "1", "DEVTYPE=wlan", True, True),
                ("wlp3s0", "1", "", True, True),
                ("wwan0", "1", "DEVTYPE=wwan", True, False),
                ("veth123", "1", "", False, False),
                ("lo", "772", "", False, False),
            ):
                link = root / name
                link.mkdir()
                if device:
                    (link / "device").mkdir()
                if wifi_marker:
                    (link / "phy80211").mkdir()
                (link / "type").write_text(kind)
                (link / "uevent").write_text(devtype)
                (link / "address").write_text(MAC)
                (link / "operstate").write_text("down")
            self.assertEqual(list(ethernet.physical_ethernet(root)), [("eno1", MAC)])

    def test_defaults_merge_placeholder_by_id_and_preserve_wifi_precedence(self):
        original = {"network": {
            "version": 2,
            "ethernets": {"installed-port": {"match": {"macaddress": MAC}, "set-name": "eno1"}},
            "wifis": {"wlan0": {"dhcp4": True, "access-points": {"Example": {"password": "example-password"}}}},
        }}
        before = copy.deepcopy(original)
        result = ethernet.ethernet_overlay(original, [("eno1", MAC)], [{"dev": "wlan0", "metric": 600}])
        self.assertEqual(result, {"network": {"version": 2, "ethernets": {
            "installed-port": {"dhcp4": True, "dhcp-identifier": "mac", "optional": True,
                               "dhcp4-overrides": {"route-metric": 700}}
        }}})
        self.assertEqual(original, before)

    def test_uses_regular_ethernet_priority_when_no_default_route(self):
        result = ethernet.ethernet_overlay({"network": {"version": 2}}, [("eno1", MAC)], [])
        profile = result["network"]["ethernets"]["eno1"]
        self.assertTrue(profile["optional"])
        self.assertEqual(profile["dhcp4-overrides"]["route-metric"], 100)

    def test_preserves_intentional_ipv4_ipv6_and_alternate_backends(self):
        for profile in ({"dhcp4": True}, {"dhcp4": False}, {"addresses": ["198.51.100.7/24"]},
                        {"dhcp6": True}, {"activation-mode": "off"}, {"renderer": "NetworkManager"},
                        {"set-name": "eno1", "match": {"driver": "r8169"}}):
            with self.subTest(profile=profile):
                effective = {"network": {"ethernets": {"eno1": profile}}}
                self.assertEqual(ethernet.ethernet_overlay(effective, [("eno1", MAC)], []), {})
        for options in ({"renderer": "NetworkManager"}, {"bridges": {"br0": {"interfaces": ["eno1"]}}},
                        {"ethernets": {"wildcard": {"match": {"name": "en*"}}}}):
            with self.subTest(options=options):
                self.assertEqual(ethernet.ethernet_overlay({"network": options}, [("eno1", MAC)], []), {})


class FirstInstallEthernetTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.first_install = root / "new-install"
        self.k3s = root / "k3s"
        self.netplan = root / "netplan"
        self.netplan.mkdir()
        self.config = self.netplan / "50-installer.yaml"
        self.original = {"network": {"version": 2}}
        self.original_yaml = yaml.safe_dump(self.original)
        self.config.write_text(self.original_yaml)
        self.output = self.netplan / ethernet.OVERLAY
        for obj, field, value in (
            (ethernet, "FIRST_INSTALL", self.first_install),
            (ethernet, "INSTALLED_K3S", (self.k3s,)),
            (network, "NETPLAN", self.netplan),
        ):
            patcher = patch.object(obj, field, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.command = patch.object(network, "command", side_effect=lambda args, **_: {
            "systemctl": "active\n", "ip": "[]",
        }.get(args[0], "")).start()
        patch.object(network, "configuration", return_value=(self.original, {}, "")).start()
        patch.object(ethernet, "physical_ethernet", return_value=[("eno1", MAC)]).start()
        patch.object(ethernet.os, "geteuid", return_value=0).start()
        self.addCleanup(patch.stopall)

    def test_only_on_fresh_install_before_k3s(self):
        self.assertEqual(ethernet.apply_defaults(), "unchanged")
        self.first_install.touch()
        self.k3s.touch()
        self.assertEqual(ethernet.apply_defaults(), "unchanged")
        self.command.assert_not_called()

    def test_apply_is_persistent_idempotent_and_does_not_reapply_wifi(self):
        self.first_install.touch()
        self.assertEqual(ethernet.apply_defaults(), "configured")
        self.assertEqual(self.config.read_text(), self.original_yaml)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertTrue(yaml.safe_load(self.output.read_text())["network"]["ethernets"]["eno1"]["dhcp4"])
        self.assertEqual(self.command.call_args_list[-2:], [
            call(["netplan", "generate"], timeout=30), call(["networkctl", "reload"], timeout=30),
        ])
        self.command.reset_mock()
        self.assertEqual(ethernet.apply_defaults(), "unchanged")
        self.command.assert_not_called()

    def test_failed_reload_restores_previous_generation_without_deleting_other_files(self):
        self.first_install.touch()
        self.command.side_effect = [
            "active", "[]", "", subprocess.TimeoutExpired(["networkctl", "reload"], 30), "", "",
        ]
        self.assertEqual(ethernet.apply_defaults(), "rolled-back")
        self.assertFalse(self.output.exists())
        self.assertEqual(self.config.read_text(), self.original_yaml)
        self.assertEqual(self.command.call_args_list[-2:], [
            call(["netplan", "generate"], timeout=30), call(["networkctl", "reload"], timeout=30),
        ])


if __name__ == "__main__":
    unittest.main()
