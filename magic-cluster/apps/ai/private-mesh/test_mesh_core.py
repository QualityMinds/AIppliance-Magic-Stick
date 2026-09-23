# SPDX-License-Identifier: BUSL-1.1
"""Core availability and security regression tests without any license fixture."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_support  # noqa: F401
from integration import ExportBridge, ModelSync
from mesh_service import MeshError, MeshService, Store
from test_mesh import Clock, FakeLiteLLM


class MeshCoreTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.inventory = {'qwen': {'uid': 'fixture', 'ready': True, 'source': 'kubeai', 'engine': 'VLLM'}}
        self.service = MeshService(Store(':memory:'), lambda: self.inventory, self.clock)
        self.addCleanup(self.service.store.db.close)
        self.service.createMesh('example-mesh', 'stick-a', 'https://example.com', '0' * 64)
        self.service.shareModel('qwen', {'enabled': True})
        self.service.refreshMembership(None)

    def test_default_appliance_creates_and_exports_without_license_state(self):
        with patch('licensing.LicenseService.status', side_effect=AssertionError('Mesh must not read licensing')):
            self.assertIn('share/stick-a/qwen', self.service.exportModels())
            self.assertTrue(self.service.createInvite('client', 'test')['token'])
            self.service.setRelayConfig({'mode': 'auto'})
            self.service.refreshMembership(None)

    def test_appliance_join_needs_signed_invite_not_license(self):
        invite = self.service.createInvite('magic-stick', 'test')
        other = MeshService(Store(':memory:'), lambda: {}, self.clock)
        self.addCleanup(other.store.db.close)
        other.joinMesh(invite['token'], 'stick-b', lambda _m, _p, body: self.service.enroll(body))
        self.assertEqual(other.getStatus()['node']['type'], 'magic-stick')
        with self.assertRaises(MeshError):
            other.joinMesh(invite['token'], 'stick-b', lambda *_: self.fail('Reused invitation'))

    def test_client_cannot_create_invites_share_or_become_appliance(self):
        client = MeshService(Store(':memory:'), lambda: self.inventory, self.clock, consume_only=True)
        self.addCleanup(client.store.db.close)
        appliance_invite = self.service.createInvite('magic-stick', 'test')
        with self.assertRaises(MeshError):
            client.joinMesh(appliance_invite['token'], 'client', lambda *_: self.fail('Client escalated'))
        invite = self.service.createInvite('client', 'test')
        client.joinMesh(invite['token'], 'laptop', lambda _m, _p, body: self.service.enroll(body))
        client.require_runtime()
        self.assertFalse(client.can_export())
        for action in [lambda: client.shareModel('qwen', {'enabled': True}),
                       lambda: client.createInvite('client', 'test'),
                       lambda: client.createMesh('other', 'client', 'https://example.com', '0' * 64)]:
            with self.assertRaises(MeshError):
                action()
        self.assertEqual(client.exportModels(), {})

    def test_unsigned_enrollment_heartbeat_and_stale_membership_fail_closed(self):
        for action in [lambda: self.service.enroll({}), lambda: self.service.heartbeat({})]:
            with self.assertRaises(MeshError):
                action()
        self.clock.now += 300
        self.assertEqual(self.service.activeRoster(), {})
        self.assertEqual(self.service.policy()['members'], {})

    def test_routes_and_local_models_work_without_license(self):
        lite = FakeLiteLLM()
        foreign = {'model_name': 'independent-model', 'model_info': {'id': 'foreign'}}
        lite.models.append(foreign)
        sync = ModelSync(self.service, lite, lambda: {'data': []},
                         'http://kubeai.example.com/v1', 'http://import.example.com/v1', 'fixture-import')
        sync.reconcile()
        names = {item['model_name'] for item in lite.models}
        self.assertTrue({'local/qwen', 'share/stick-a/qwen', 'independent-model'} <= names)
        self.service.unshareModel('qwen')
        sync.reconcile()
        self.assertNotIn('share/stick-a/qwen', {item['model_name'] for item in lite.models})
        self.assertIn(foreign, lite.models)
        self.assertTrue(self.inventory['qwen']['ready'])

    def test_export_bridge_still_rejects_unknown_peer_and_wrong_token(self):
        bridge = ExportBridge(self.service, 'http://127.0.0.1:1', 'fixture-bridge')
        for token, peer in [('wrong-token', self.service.identity.endpoint), ('fixture-bridge', 'f' * 64)]:
            with self.subTest(peer=peer), self.assertRaises(MeshError):
                bridge.authorize(token, peer)

    def test_mesh_has_no_license_secret_rbac_or_runtime_verifier(self):
        root = Path(test_support.__file__).resolve().parents[4]
        access = (root / 'magic-cluster/apps/ai/private-mesh/access.yaml').read_text()
        self.assertNotIn('license-reader', access)
        self.assertNotIn('magicstick-license', access)
        source = (root / 'core/magicstick_core/private_mesh/server.py').read_text()
        self.assertNotIn('MeshLicense', source)
        self.assertNotIn('license_check', source)


if __name__ == '__main__':
    unittest.main()
