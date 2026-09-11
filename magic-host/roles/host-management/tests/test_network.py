import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

FILES = Path(__file__).resolve().parents[1] / "files"
sys.path.insert(0, str(FILES))
import network_config as config
import network_apply as trial
from network_contract import validate_network
from host_worker import atomic_json
import host_worker as worker_module
from test_host_management import operation, report, node


def inventory():
    return {"id": "a" * 64, "supported": True, "interfaces": [
        {"name": "eth0", "kind": "ethernet", "mac": "02:00:00:00:00:01", "editable": True, "configuredMode": "dhcp", "addresses": ["198.51.100.10/24"], "clusterAddresses": []},
        {"name": "wlan0", "kind": "wifi", "mac": "02:00:00:00:00:02", "editable": True, "scanSupported": True, "configuredMode": "dhcp", "configuredSsid": "Example Wi-Fi", "hasPassword": True, "clusterAddresses": []},
    ]}


def settings(**changes):
    return {"interface": "eth0", "mode": "dhcp", "metric": 100, "dns": [], **changes}


class NetworkContractTests(unittest.TestCase):
    def test_dhcp_static_and_scan(self):
        self.assertEqual(validate_network(settings(), inventory()), settings())
        self.assertEqual(validate_network(settings(mode="static", address="198.51.100.10/24", gateway="198.51.100.1"), inventory())["gateway"], "198.51.100.1")
        self.assertEqual(validate_network({"interface": "wlan0"}, inventory(), scan=True), {"interface": "wlan0"})

    def test_rejects_paths_commands_unknown_fields_bad_addresses_and_metric(self):
        for changes in ({"interface": "../../x"}, {"interface": "eth0;reboot"}, {"command": "echo"}, {"metric": True}, {"metric": 0},
                        {"dns": ["not-an-ip"]}, {"dns": "198.51.100.1"}, {"address": "198.51.100.1/24"},
                        {"mode": "static", "address": "198.51.100.10"}, {"mode": "static", "address": "198.51.100.10/24", "gateway": "203.0.113.1"},
                        {"password": "x" * 12}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_network(settings(**changes), inventory())

    def test_wifi_password_reuse_only_for_same_ssid(self):
        wifi = settings(interface="wlan0", ssid="Example Wi-Fi", security="wpa-psk", hidden=False)
        self.assertEqual(validate_network(wifi, inventory())["password"], "")
        with self.assertRaises(ValueError):
            validate_network({**wifi, "ssid": "Other network"}, inventory())
        self.assertEqual(validate_network({**wifi, "ssid": "Other network", "password": "x" * 12}, inventory())["ssid"], "Other network")
        for change in ({"ssid": "x" * 33}, {"ssid": "bad\nname"}, {"security": "wpa-eap"}, {"password": "short"}, {"hidden": 1}):
            with self.assertRaises(ValueError):
                validate_network({**wifi, **change}, inventory())

    def test_cluster_address_and_wifi_migration_are_blocked(self):
        value = inventory(); value["interfaces"][0]["clusterAddresses"] = ["198.51.100.10"]
        validate_network(settings(mode="static", address="198.51.100.10/24"), value)
        with self.assertRaises(ValueError):
            validate_network(settings(mode="static", address="198.51.100.11/24"), value)
        value["interfaces"][1]["clusterAddresses"] = ["198.51.100.10"]
        with self.assertRaises(ValueError):
            validate_network(settings(interface="wlan0", ssid="Other", security="open"), value)

    def test_unavailable_and_read_only_interfaces_are_rejected(self):
        value = inventory(); value["interfaces"][0]["editable"] = False
        with self.assertRaises(ValueError): validate_network(settings(), value)
        value = inventory(); value["supported"] = False
        with self.assertRaises(ValueError): validate_network(settings(), value)


class NetplanTests(unittest.TestCase):
    def test_public_fingerprint_uses_a_persistent_private_key(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            left = config.private_fingerprint({'config': 'example'}, Path(first))
            self.assertEqual(left, config.private_fingerprint({'config': 'example'}, Path(first)))
            self.assertNotEqual(left, config.private_fingerprint({'config': 'example'}, Path(second)))
            self.assertNotEqual(left, config.private_fingerprint({'config': 'changed'}, Path(first)))
            self.assertEqual((Path(first) / 'network-fingerprint.key').stat().st_mode & 0o777, 0o600)

    def test_changes_only_target_and_preserves_backend_ipv6_and_other_wifi_credentials(self):
        original = {"network": {"version": 2, "renderer": "networkd", "ethernets": {"eth0": {"dhcp4": True, "dhcp6": True, "addresses": ["2001:db8::10/64"]}},
                   "wifis": {"wlan0": {"dhcp4": True, "access-points": {"Example Wi-Fi": {"password": "x" * 12}}}}}}
        result = config.build_configuration(original, inventory(), settings(mode="static", address="198.51.100.10/24", gateway="198.51.100.1"))
        self.assertEqual(result["network"]["wifis"], original["network"]["wifis"])
        self.assertEqual(result["network"]["renderer"], "networkd")
        self.assertEqual(result["network"]["ethernets"]["eth0"]["addresses"], ["2001:db8::10/64", "198.51.100.10/24"])
        self.assertTrue(original["network"]["ethernets"]["eth0"]["dhcp4"])

    def test_matching_mac_preserves_installer_profile_identity(self):
        effective = {"network": {"version": 2, "ethernets": {"installer-profile": {"match": {"macaddress": "02:00:00:00:00:01"}, "dhcp4": True}}}}
        result = config.build_configuration(effective, inventory(), settings())
        self.assertEqual(list(result["network"]["ethernets"]), ["installer-profile"])

    def test_saved_wifi_password_stays_on_host(self):
        effective = {"network": {"version": 2, "wifis": {"wlan0": {"access-points": {"Example Wi-Fi": {"password": "x" * 12}}}}}}
        result = config.build_configuration(effective, inventory(), settings(interface="wlan0", ssid="Example Wi-Fi", security="wpa-psk"))
        self.assertEqual(result["network"]["wifis"]["wlan0"]["access-points"]["Example Wi-Fi"]["password"], "x" * 12)

    def test_scan_deduplicates_ssids_and_keeps_strongest_signal(self):
        output = "BSS one\n\tsignal: -60.0 dBm\n\tSSID: Example\n\tRSN:\nBSS two\n\tsignal: -40.0 dBm\n\tSSID: Example\n\tRSN:\n"
        with patch.object(config, "command", return_value=output) as command:
            self.assertEqual(config.scan_wifi("wlan0"), [{"ssid": "Example", "signal": -40, "security": "secured"}])
            command.assert_called_once_with(["iw", "dev", "wlan0", "scan"], timeout=25)


class NetworkRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.netplan = self.root / "netplan"; self.netplan.mkdir()
        self.original = "network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n"
        (self.netplan / "10-installer.yaml").write_text(self.original)
        self.approved = self.root / "approved.json"; self.trial = self.root / "trial.json"
        self.node = {"metadata": {"uid": "node-uid"}, "status": {"nodeInfo": {"bootID": "boot-a"}}}
        self.confirm = False
        self.offline = False
        self.get_operations = 0
        def kube(args, data=None):
            if args[:2] == ["get", "node"]: return self.node
            if args[0] == "get":
                self.get_operations += 1
                if self.offline and self.get_operations > 1: raise RuntimeError("offline")
                return {"metadata": {"uid": "op-uid", "annotations": {trial.CONFIRM: "a" * 32} if self.confirm else {}}, "status": {"phase": "Applying"}}
            return {}
        for target, attribute, replacement in ((config, "NETPLAN", self.netplan), (trial, "TRIAL", self.trial), (trial, "APPROVED", self.approved)):
            patcher = patch.object(target, attribute, replacement); patcher.start(); self.addCleanup(patcher.stop)
        self.command = patch.object(config, "command", return_value="").start()
        patch.object(config, "collect", return_value=inventory()).start()
        patch.object(config, "configuration", return_value=({"network": {"version": 2, "ethernets": {"eth0": {"dhcp4": True}}}}, {"10-installer.yaml": self.original}, "a" * 64)).start()
        patch.object(trial, "kube", side_effect=kube).start()
        patch.object(trial, "boot_id", return_value="boot-a").start()
        self.addCleanup(patch.stopall)
        atomic_json(self.approved, {"settings": settings(), "approvedAt": time.time(), "nodeName": "example-node", "nodeUid": "node-uid", "bootId": "boot-a", "planId": "a" * 64, "requestId": "a" * 32, "operationName": "example-operation", "operationUid": "op-uid"})

    def test_unconfirmed_trial_restores_files_and_reapplies_without_browser(self):
        with patch.object(trial, "SECONDS", 0): trial.apply()
        self.assertEqual((self.netplan / "10-installer.yaml").read_text(), self.original)
        self.assertFalse((self.netplan / trial.MANAGED).exists())
        self.assertEqual(json.loads(self.trial.read_text())["phase"], "RolledBack")
        self.assertFalse(self.approved.exists())
        self.assertEqual(sum(call.args[0] == ["netplan", "apply"] for call in self.command.call_args_list), 2)

    def test_confirmed_trial_remains_persistent_and_secrets_backups_are_removed(self):
        self.confirm = True
        trial.apply()
        self.assertTrue((self.netplan / trial.MANAGED).exists())
        self.assertFalse((self.netplan / "10-installer.yaml").exists())
        value = json.loads(self.trial.read_text())
        self.assertEqual(value["phase"], "Succeeded")
        self.assertNotIn("backup", value)
        self.assertEqual((self.netplan / trial.MANAGED).stat().st_mode & 0o777, 0o600)

    def test_failed_generate_restores_without_repeating_trial(self):
        calls = 0
        def command(args, **_):
            nonlocal calls
            calls += 1
            if calls == 1: raise RuntimeError("invalid generated configuration")
            return ""
        self.command.side_effect = command
        with self.assertRaises(RuntimeError): trial.apply()
        self.assertEqual(json.loads(self.trial.read_text())["phase"], "RolledBack")
        self.assertEqual((self.netplan / "10-installer.yaml").read_text(), self.original)

    def test_boot_recovery_restores_files_and_regenerates_before_network_starts(self):
        atomic_json(self.trial, {"requestId": "a" * 32, "phase": "AwaitingConfirmation", "changed": True, "backup": {"10-installer.yaml": self.original}})
        (self.netplan / "10-installer.yaml").unlink(); (self.netplan / trial.MANAGED).write_text("bad configuration")
        trial.recover(boot=True)
        self.command.assert_called_once_with(["netplan", "generate"], timeout=30)
        self.assertEqual((self.netplan / "10-installer.yaml").read_text(), self.original)

    def test_lost_api_before_changes_does_not_touch_network(self):
        with patch.object(trial, "publish", side_effect=RuntimeError("offline")), self.assertRaises(RuntimeError): trial.apply()
        self.command.assert_not_called()
        self.assertEqual(json.loads(self.trial.read_text())["phase"], "Failed")

    def test_changed_boot_rejects_before_host_side_effects(self):
        with patch.object(trial, "boot_id", return_value="boot-b"), self.assertRaises(RuntimeError): trial.apply()
        self.command.assert_not_called()

    def test_lost_api_after_apply_cannot_disable_local_deadline(self):
        calls = 0
        def publish(_):
            nonlocal calls
            calls += 1
            if calls > 1: raise RuntimeError('API unavailable')
        with patch.object(trial, 'publish', side_effect=publish), patch.object(trial, 'SECONDS', 5), \
                patch.object(trial.time, 'monotonic', side_effect=[0, 1, 2, 6]), patch.object(trial.time, 'sleep'):
            trial.apply()
        self.assertEqual(json.loads(self.trial.read_text())["phase"], "RolledBack")
        self.assertEqual((self.netplan / "10-installer.yaml").read_text(), self.original)


class NetworkWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inventory = inventory()
        self.worker = worker_module.Worker(node(), report(True), {}, self.root, network=self.inventory)
        self.operation = operation({}, 'configure-network', planId='a' * 64, networkRef={'name': 'host-network-' + 'a' * 32, 'uid': 'secret-uid'})
        import base64
        self.secret = {'metadata': {'uid': 'secret-uid', 'labels': {'appliance.magicstick.dev/request-id': 'a' * 32}}, 'immutable': True,
                       'type': 'appliance.magicstick.dev/network-request', 'data': {'settings.json': base64.b64encode(json.dumps(settings()).encode()).decode()}}
        def kube(args, data=None):
            return self.secret if args[:2] == ['get', 'secret'] else {}
        self.kube = patch.object(worker_module, 'kube', side_effect=kube).start()
        self.run = patch.object(worker_module, 'run', return_value='').start()
        patch.object(config, 'collect', return_value=self.inventory).start()
        self.addCleanup(patch.stopall)

    def test_worker_starts_only_fixed_supervised_service_and_persists_approval(self):
        self.worker.reconcile(self.operation)
        self.run.assert_called_once_with(['/usr/bin/systemctl', 'start', '--no-block', 'magicstick-network-apply.service'])
        approved = json.loads((self.root / 'approved-network.json').read_text())
        self.assertEqual(approved['settings'], settings())
        self.assertEqual((self.root / 'approved-network.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.worker.state['current']['phase'], 'Applying')
        self.assertNotIn('settings', self.worker.state['current'])
        self.assertTrue(any(call.args[0][0] == 'delete' for call in self.kube.call_args_list))

    def test_replaced_credential_identity_cannot_execute(self):
        self.secret['metadata']['uid'] = 'replacement-secret'
        self.worker.reconcile(self.operation)
        self.run.assert_not_called()
        self.assertEqual(self.worker.state['current']['phase'], 'Failed')

    def test_stale_fingerprint_rejected_before_reading_credentials(self):
        self.operation['spec']['planId'] = 'b' * 64
        self.worker.reconcile(self.operation)
        self.run.assert_not_called()
        self.assertFalse(any(call.args[0][:2] == ['get', 'secret'] for call in self.kube.call_args_list))

    def test_service_result_is_reconciled_without_reapplying(self):
        self.worker.reconcile(self.operation)
        atomic_json(self.root / 'network-trial.json', {'requestId': 'a' * 32, 'phase': 'RolledBack', 'message': 'Previous configuration restored.'})
        self.worker.reconcile(self.operation)
        self.assertEqual(self.run.call_count, 1)
        self.assertEqual(self.worker.state['current']['phase'], 'RolledBack')


if __name__ == "__main__": unittest.main()
