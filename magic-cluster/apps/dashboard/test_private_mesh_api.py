import base64
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from test_dashboard_api import load_server

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'dashboard/apps/api'))


class PrivateMeshApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.api['license_service'] = lambda: self.fail('Core Mesh must not read licensing')
        self.api['read_secret'] = lambda *_: {'data': {'MESH_ADMIN_TOKEN': base64.b64encode(b'fixture-only-token').decode()}}
        self.api['settings_response'] = lambda: {'mdnsDomain': 'example.local', 'publicDomain': 'example.com'}
        self.api['get_resource'] = lambda *_: {'data': {'oidc-ca.crt': '-----BEGIN CERTIFICATE-----\nfixture-public-certificate'}}

    def test_requires_admin_and_csrf_before_forwarding(self):
        handler = self.api['Handler'].__new__(self.api['Handler'])
        checked = []
        handler.require_access = lambda role: (checked.append(role) or {'username': 'administrator'})
        self.api['validate_dashboard_mutation_request'] = lambda _h: checked.append('csrf')
        self.api['read_body'] = lambda _h: {}
        self.api['private_mesh_request'] = lambda *_: checked.append('forward')
        handler.route = lambda: '/api/mesh/sync'
        handler.send_json = lambda *_: None
        handler.handle_mesh(mutate=True)
        self.assertEqual(checked, ['admin', 'csrf', 'forward'])

    def test_upstream_url_and_author_are_server_owned(self):
        seen = []
        def open_request(req, **kwargs):
            seen.append(req)
            return io.BytesIO(b'{}')
        with patch.object(self.api['urllib'].request, 'urlopen', open_request):
            self.api['private_mesh_request']('POST', 'invite', {'creator': 'spoofed', 'type': 'client'}, {'username': 'administrator'})
        self.assertEqual(seen[0].full_url, 'http://private-mesh.ai.svc.cluster.local:8080/commands/invite')
        self.assertEqual(json.loads(seen[0].data)['creator'], 'administrator')

    def test_missing_module_does_not_report_installed(self):
        def absent(*_):
            raise LookupError()
        self.api['read_secret'] = absent
        self.assertFalse(self.api['private_mesh_request']('GET')['installed'])
        with self.assertRaises(self.api['RequestError']):
            self.api['private_mesh_request']('POST', 'create', {})

    def test_untrusted_enrollment_origin_is_rejected(self):
        for origin in ['http://example.com', 'https://attacker.example.com', 'https://example.com/path', 'https://user@example.com']:
            with self.assertRaises(self.api['RequestError']):
                self.api['private_mesh_request']('POST', 'create', {'origin': origin})

    def test_unsupported_operations_are_never_forwarded(self):
        with self.assertRaises(self.api['RequestError']):
            self.api['private_mesh_request']('POST', '../../model/new', {})

    def test_core_mutations_and_activation_work_without_license(self):
        with patch.object(self.api['urllib'].request, 'urlopen', side_effect=lambda *_a, **_k: io.BytesIO(b'{}')) as forward:
            for action in ['join', 'share', 'invite', 'relay', 'sync', 'leave', 'unshare', 'revoke-invite', 'revoke-node']:
                self.api['private_mesh_request']('POST', action, {})
            self.api['private_mesh_request']('POST', 'create', {'origin': 'https://example.com'})
            self.assertEqual(forward.call_count, 10)
        self.assertTrue(self.api['module_activation_payload']('private-mesh', True)['spec']['enabled'])
        self.assertFalse(self.api['module_activation_payload']('private-mesh', False)['spec']['enabled'])

    def test_status_has_no_entitlement_dependency(self):
        with patch.object(self.api['urllib'].request, 'urlopen', side_effect=lambda *_a, **_k: io.BytesIO(b'{"configured":true}')):
            status = self.api['private_mesh_request']('GET')
        self.assertTrue(status['installed'])
        self.assertTrue(status['configured'])
        self.assertNotIn('feature', status)


if __name__ == '__main__':
    unittest.main()
