from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'magic-host/roles/host-management/files'))
from test_dashboard_api import load_server


class NetworkApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.admin = {"subject": "example-admin", "roles": ["magicstick-admin"]}
        self.host = {"name": "example-node", "nodeUid": "node-uid", "bootId": "boot-a", "available": True,
                     "network": {"id": "f" * 64, "supported": True, "interfaces": [
                         {"name": "wlan0", "kind": "wifi", "editable": True, "scanSupported": True, "clusterAddresses": []}]}}
        self.api['host_management_status'] = lambda: {"nodes": [self.host]}
        self.calls, self.existing = [], None
        def request(method, path, body=None):
            self.calls.append((method, path, body))
            if method == 'GET':
                if self.existing: return self.existing
                raise urllib.error.HTTPError(path, 404, 'not found', {}, io.BytesIO())
            if method == 'POST' and path.endswith('/secrets'):
                return {**body, "metadata": {**body['metadata'], "uid": "secret-uid"}}
            return body
        self.api['request_json'] = request

    def payload(self, **updates):
        return {"action": "configure-network", "nodeName": "example-node", "nodeUid": "node-uid", "bootId": "boot-a", "requestId": "a" * 32,
                "confirmation": "example-node", "acknowledgeDisruption": True, "allowExperimental": False, "experimentMode": False, "planId": "f" * 64,
                "network": {"interface": "wlan0", "mode": "dhcp", "metric": 600, "dns": [], "ssid": "Example", "security": "wpa-psk", "password": "x" * 12}, **updates}

    def test_password_goes_only_to_immutable_request_scoped_secret(self):
        answer = self.api['create_host_operation'](self.admin, self.payload())
        secret = next(c[2] for c in self.calls if c[0] == 'POST' and c[1].endswith('/secrets'))
        operation = self.calls[-1][2]
        self.assertTrue(secret['immutable'])
        self.assertEqual(secret['type'], 'appliance.magicstick.dev/network-request')
        self.assertEqual(operation['spec']['networkRef'], {"name": "host-network-" + "a" * 32, "uid": "secret-uid"})
        self.assertNotIn('x' * 12, json.dumps(operation))
        self.assertNotIn('Example', json.dumps(operation))
        self.assertNotIn('password', json.dumps(answer))

    def test_inventory_change_and_wrong_role_or_consent_do_not_create_credentials(self):
        for changes in ({"planId": "e" * 64}, {"bootId": "old"}, {"acknowledgeDisruption": False}, {"confirmation": "wrong"}, {"allowExperimental": True}, {"gpuMemory": {}}, {"network": {"interface": "../../x"}}):
            with self.assertRaises(self.api['RequestError']): self.api['create_host_operation'](self.admin, self.payload(**changes))
        for role in ('magicstick-user', 'magicstick-viewer', 'magicstick-operator'):
            with self.assertRaises(self.api['AuthError']): self.api['create_host_operation']({"roles": [role]}, self.payload())
        self.assertEqual(self.calls, [])

    def test_network_settings_are_rejected_on_power_operations(self):
        with self.assertRaises(self.api['RequestError']): self.api['create_host_operation'](self.admin, self.payload(action='reboot'))
        self.assertFalse(self.calls)

    def test_busy_host_does_not_create_an_orphan_secret(self):
        self.existing = {"metadata": {"uid": "busy"}, "spec": {"requestId": "b" * 32}, "status": {"phase": "Applying"}}
        with self.assertRaises(self.api['RequestError']): self.api['create_host_operation'](self.admin, self.payload())
        self.assertEqual([c[0] for c in self.calls], ['GET'])

    def test_confirmation_is_explicit_bounded_and_metadata_only(self):
        self.existing = {"metadata": {"uid": "operation-uid", "resourceVersion": "12"}, "spec": self.payload(),
                         "status": {"phase": "AwaitingConfirmation", "confirmationDeadline": (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()}}
        payload = {"nodeUid": "node-uid", "requestId": "a" * 32, "confirmation": "example-node"}
        self.api['confirm_host_network'](self.admin, payload)
        self.assertEqual(self.calls[-1][0], 'PATCH')
        self.assertEqual(set(self.calls[-1][2]), {'metadata'})
        self.assertEqual(self.calls[-1][2]['metadata']['resourceVersion'], '12')
        self.existing['status']['confirmationDeadline'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        with self.assertRaises(self.api['RequestError']): self.api['confirm_host_network'](self.admin, payload)
        with self.assertRaises(self.api['AuthError']): self.api['confirm_host_network']({"roles": ['magicstick-viewer']}, payload)

    def test_status_has_a_strict_credential_free_allowlist(self):
        value = self.api['public_host_network']({"supported": True, "password": 'x' * 12, "interfaces": [{"name": "wlan0", "password": 'x' * 12, "hasPassword": True, "access-points": {"Example": {"password": 'x' * 12}}}],
                                                "scan": {"interface": "wlan0", "networks": [{"ssid": "Example", "password": 'x' * 12}]}})
        self.assertNotIn('x' * 12, json.dumps(value))
        self.assertEqual(value['interfaces'][0], {"name": "wlan0", "hasPassword": True})


if __name__ == '__main__': unittest.main()
