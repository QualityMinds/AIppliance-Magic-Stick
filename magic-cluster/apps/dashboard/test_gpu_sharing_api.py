import json
import unittest
from unittest.mock import patch

from test_dashboard_api import load_server


class GpuSharingApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def setUp(self):
        self.state = {'mode': 'exclusive', 'available': True, 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                      'expectedRevision': '7', 'reason': ''}
        self.payload = {'provider': 'amd', 'mode': 'shared', 'maxModels': 3, 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                        'expectedRevision': '7', 'acknowledgeSharing': True, 'acknowledgeRestart': True}
        self.writes = []

    def configure(self, payload):
        with patch.dict(self.api, {'gpu_sharing_status': lambda provider: self.state, 'request_json': lambda *args: self.writes.append(args)}):
            return self.api['configure_gpu_sharing'](payload)

    def test_patch_preserves_profile_and_model_configuration(self):
        self.assertTrue(self.configure(self.payload)['accepted'])
        method, path, body, content_type = self.writes[0]
        self.assertEqual(method, 'PATCH')
        self.assertTrue(path.endswith('/moduleactivations/amd-gpu'))
        self.assertEqual(body['metadata']['resourceVersion'], '7')
        self.assertEqual(set(body['spec']['parameters']), {'gpuSharing', 'validationRequest'})
        config = json.loads(body['spec']['parameters']['gpuSharing'])
        self.assertEqual(config['mode'], 'dra-shared')
        self.assertEqual(config['maxModels'], 3)
        self.assertEqual(config['namespace'], 'ai')
        self.assertEqual(content_type, 'application/merge-patch+json')

    def test_invalid_stale_unsupported_and_unacknowledged_requests_do_not_write(self):
        for change in ({'provider': 'intel'}, {'provider': None}, {'mode': 'mps'}, {'mode': 'dra-shared'}, {'maxModels': 1}, {'maxModels': True}, {'maxModels': 17},
                       {'acknowledgeSharing': False}, {'acknowledgeRestart': False}, {'expectedRevision': 'old'},
                       {'nodeUid': 'old'}, {'nodeName': 'wrong'}, {'image': 'arbitrary/image'}):
            with self.subTest(change=change), self.assertRaises((ValueError, self.api['RequestError'])):
                self.configure({**self.payload, **change})
        self.state['available'] = False
        with self.assertRaises(self.api['RequestError']):
            self.configure(self.payload)
        self.assertEqual(self.writes, [])

    def test_return_to_exclusive_is_possible_when_hardware_no_longer_matches(self):
        self.state['available'] = False
        self.assertTrue(self.configure({**self.payload, 'mode': 'exclusive', 'acknowledgeSharing': False})['accepted'])

    def test_nvidia_patch_does_not_touch_amd_validation_or_profiles(self):
        self.assertEqual(self.configure({**self.payload, 'provider': 'nvidia'}), {'accepted': True, 'provider': 'nvidia', 'mode': 'shared'})
        _, path, body, _ = self.writes[0]
        self.assertTrue(path.endswith('/moduleactivations/gpu'))
        self.assertEqual(set(body['spec']['parameters']), {'gpuSharing'})
        config = json.loads(body['spec']['parameters']['gpuSharing'])
        self.assertEqual(config['mode'], 'time-slicing')
        self.assertFalse(config['allowExperimental'])
        with self.assertRaises(self.api['RequestError']):
            self.configure({**self.payload, 'provider': 'nvidia', 'mode': 'exclusive', 'nodeUid': 'old'})

    def test_profile_edits_preserve_sharing_and_do_not_offer_a_backdoor(self):
        sharing = json.dumps({'mode': 'dra-shared', 'maxModels': 2})
        catalog = {'modules': {'amd-gpu': {'parameters': [{'name': name} for name in
                   ('compatibilityProfile', 'allowExperimental', 'validationRequest')]}, 'gpu': {}}}
        current = {'metadata': {'resourceVersion': '7'}, 'spec': {'parameters': {'gpuSharing': sharing}}}
        with patch.dict(self.api, {'catalog_json': lambda: catalog,
                                  'module_activation': lambda _: self.fail('Use the fenced revision, not a second lookup')}):
            resource = self.api['module_activation_payload']('amd-gpu', True, {'parameters': {}})
            result = self.api['manual_module_activation_patch'](resource, current)
            self.assertEqual(result['spec']['parameters']['gpuSharing'], sharing)
            self.assertEqual(result['metadata']['resourceVersion'], '7')
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                self.api['module_activation_payload']('amd-gpu', True, {'parameters': {'gpuSharing': sharing}})
            resource = self.api['module_activation_payload']('gpu', True, {'parameters': {}})
            result = self.api['manual_module_activation_patch'](resource, current)
            self.assertEqual(result['spec']['parameters'], {'gpuSharing': sharing})
            with self.assertRaises(ValueError):
                self.api['module_activation_payload']('gpu', True, {'parameters': {'other': 'invalid'}})
            with self.assertRaises(ValueError):
                self.api['module_activation_payload']('gpu', True, {'parameters': {'gpuSharing': sharing}})

    def default_reset(self, provider='nvidia'):
        self.state.update(managed=True, phase='Ready', backend='time-slicing', maxModels=2)
        if provider == 'amd':
            self.state['backend'] = 'dra'
        config={'mode': 'exclusive', 'maxModels': 2, 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                'namespace': 'ai', 'allowExperimental': False}
        activation={'metadata': {'resourceVersion': '7'}, 'spec': {'enabled': True,
                    'parameters': {'gpuSharing': json.dumps(config), 'unrelated': 'keep'}}}
        node={'metadata': {'name': 'example-node', 'uid': 'example-uid', 'labels': {
              'nvidia.com/gpu.count': '4', 'nvidia.com/device-plugin.config': 'magicstick-exclusive'}},
              'status': {'allocatable': {'nvidia.com/gpu': '4'}}}
        payload={**self.payload, 'provider': provider, 'mode': 'exclusive', 'maxModels': 2, 'acknowledgeSharing': False,
                 'restoreDefaults': {'parameters': 'present', 'gpuSharing': 'absent'}}
        if provider == 'amd':
            payload['restoreDefaults']['validationRequest'] = 'absent'
            activation['spec']['parameters']['validationRequest'] = ''
            node['status']['allocatable'] = {'amd.com/gpu': '1'}
        else:
            payload['allocationBackend'] = 'device-plugin'
        return activation, node, payload

    def configure_reset(self, activation, node, payload):
        with patch.dict(self.api, {'module_activation': lambda _: activation, 'get_resource': lambda _: node}):
            return self.configure(payload)

    def test_restore_fresh_defaults_removes_only_borrowed_fields_after_exclusive_convergence(self):
        activation, node, payload = self.default_reset()
        self.assertTrue(self.configure_reset(activation, node, payload)['accepted'])
        self.assertEqual(self.writes[0][2], {'metadata': {'resourceVersion': '7'}, 'spec': {'parameters': {'gpuSharing': None}}})
        self.assertEqual(self.writes[0][3], 'application/merge-patch+json')

    def test_default_reset_preserves_absent_empty_maps_strings_and_unrelated_parameters(self):
        import copy

        def merge(target, patch):
            if not isinstance(patch, dict):
                return copy.deepcopy(patch)
            target = copy.deepcopy(target) if isinstance(target, dict) else {}
            for key, value in patch.items():
                if value is None:
                    target.pop(key, None)
                else:
                    target[key] = merge(target.get(key), value)
            return target

        for provider in ('amd', 'nvidia'):
            for original in (None, {}, {'gpuSharing': ''}, {'unrelated': 'keep'},
                             *([{'validationRequest': ''}, {'gpuSharing': '', 'validationRequest': ''}] if provider == 'amd' else [])):
                with self.subTest(provider=provider, original=original):
                    self.writes.clear()
                    activation, node, payload = self.default_reset(provider)
                    owned = {key: value for key, value in activation['spec']['parameters'].items()
                             if key in ('gpuSharing', 'validationRequest')}
                    activation['spec']['parameters'] = {**(original or {}), **owned}
                    defaults = payload['restoreDefaults']
                    defaults['parameters'] = 'absent' if original is None else 'present'
                    for key in ('gpuSharing', *(['validationRequest'] if provider == 'amd' else [])):
                        defaults[key] = 'empty' if key in (original or {}) else 'absent'
                    expected = {'enabled': True, **({'parameters': original} if original is not None else {})}
                    self.configure_reset(activation, node, payload)
                    actual = merge(activation, self.writes[0][2])
                    self.assertEqual(actual['spec'], expected)

    def test_default_reset_is_not_an_unfenced_module_patch_or_direct_backend_switch(self):
        import copy
        activation, node, payload = self.default_reset()
        for defaults in (None, {}, True, {'parameters': 'absent', 'gpuSharing': 'empty'},
                         {'parameters': 'present', 'gpuSharing': 'arbitrary-json'},
                         {**payload['restoreDefaults'], 'unrelated': 'replace'},
                         {**payload['restoreDefaults'], 'validationRequest': 'empty'}):
            with self.subTest(defaults=defaults), self.assertRaises((ValueError, self.api['RequestError'])):
                self.configure_reset(activation, node, {**payload, 'restoreDefaults': defaults})
        for change in ({'expectedRevision': 'old'}, {'nodeUid': 'old'}, {'nodeName': 'another-node'},
                       {'acknowledgeRestart': False}, {'acknowledgeSharing': True}, {'mode': 'shared'},
                       {'allocationBackend': 'dra'}, {'maxModels': 3}):
            with self.subTest(change=change), self.assertRaises((ValueError, self.api['RequestError'])):
                self.configure_reset(activation, node, {**payload, **change})
        for change in ({'managed': False}, {'phase': 'Starting'}, {'mode': 'shared'}, {'available': False}, {'backend': 'dra'}):
            original = copy.deepcopy(self.state)
            with self.subTest(state=change), self.assertRaises(self.api['RequestError']):
                self.state.update(change)
                self.configure_reset(activation, node, payload)
            self.state = original
        for changes in ({'uid': 'foreign'}, {'resourceVersion': '8'}, {'deletionTimestamp': 'now'}):
            stale = copy.deepcopy(activation)
            stale['metadata'].update(changes)
            # The UID is part of the runner's journal fence; the API rejects
            # replacement via its never-reused resourceVersion, not a name.
            if 'uid' in changes:
                stale['metadata']['resourceVersion'] = 'replacement-revision'
            with self.subTest(metadata=changes), self.assertRaises(self.api['RequestError']):
                self.configure_reset(stale, node, payload)
        for labels in ({'nvidia.com/device-plugin.config': 'custom'}, {'nvidia.com/gpu.replicas': '2'},
                       {'nvidia.com/dra-kubelet-plugin': 'true'}, {'appliance.magicstick.dev/nvidia-dra-config': 'retained'}):
            foreign = copy.deepcopy(node)
            foreign['metadata']['labels'].update(labels)
            with self.subTest(labels=labels), self.assertRaises(self.api['RequestError']):
                self.configure_reset(activation, foreign, payload)
        for change in ({'uid': 'foreign'}, {'allocatable': {'nvidia.com/gpu': '8'}}):
            foreign = copy.deepcopy(node)
            foreign['metadata' if 'uid' in change else 'status'].update(change)
            with self.subTest(node=change), self.assertRaises(self.api['RequestError']):
                self.configure_reset(activation, foreign, payload)
        with self.assertRaises(self.api['RequestError']):
            self.configure_reset(activation, node, {**payload, 'restoreDefaults': {'parameters': 'absent', 'gpuSharing': 'absent'}})
        for config in ('invalid', '{}', json.dumps({'mode': 'exclusive'}),
                       json.dumps({**json.loads(activation['spec']['parameters']['gpuSharing']), 'custom': 'retained'})):
            custom = copy.deepcopy(activation)
            custom['spec']['parameters']['gpuSharing'] = config
            with self.subTest(config=config), self.assertRaises(self.api['RequestError']):
                self.configure_reset(custom, node, payload)
        activation['spec']['parameters']['validationRequest'] = 'active-probe'
        with self.assertRaises(self.api['RequestError']):
            self.configure_reset(activation, node, payload)
        self.assertEqual(self.writes, [])

    def test_amd_reset_requires_current_node_identity_too(self):
        activation, node, payload = self.default_reset('amd')
        for change in ({'nodeUid': 'old'}, {'nodeName': 'wrong'}, {'allocationBackend': 'device-plugin'}):
            with self.subTest(change=change), self.assertRaises((ValueError, self.api['RequestError'])):
                self.configure_reset(activation, node, {**payload, **change})
        self.assertEqual(self.writes, [])

    def nvidia_status(self, node_changes=None, config=None, observed=None):
        node = {'metadata': {'name': 'example-node', 'uid': 'example-uid', 'labels': {
            'nvidia.com/gpu.count': '1', 'nvidia.com/gpu.replicas': '2', 'nvidia.com/mig.strategy': 'none',
        }}, 'status': {'allocatable': {'nvidia.com/gpu': '2'}}}
        node['metadata']['labels'].update(node_changes or {})
        activation = {'metadata': {'resourceVersion': '7'}, 'spec': {'parameters': {}}}
        if config:
            activation['spec']['parameters']['gpuSharing'] = json.dumps(config)
        with patch.dict(self.api, {'module_activation': lambda module: activation,
                                  'ready_schedulable_nodes': lambda: [node],
                                  'appliance': lambda: {'status': {'hardwareOperators': {'gpu': {'sharing': observed or {}}}}},
                                  'request_json': lambda *args: self.writes.append(args)}):
            return self.api['gpu_sharing_status']('nvidia')

    def test_inherited_nvidia_slots_are_not_physical_gpu_count_and_status_is_read_only(self):
        state = self.nvidia_status()
        self.assertEqual((state['mode'], state['backend'], state['maxModels']), ('shared', 'time-slicing', 2))
        self.assertTrue(state['available'])
        self.assertFalse(state['managed'])
        self.assertFalse(state['experimental'])
        self.assertEqual(self.writes, [])

    def test_nvidia_custom_and_mig_configuration_are_not_adopted(self):
        for labels in ({'nvidia.com/mig.strategy': 'mixed'},
                       {'nvidia.com/device-plugin.config': 'custom-mps'}):
            with self.subTest(labels=labels):
                self.assertFalse(self.nvidia_status(labels)['available'])
        self.assertTrue(self.nvidia_status({'nvidia.com/device-plugin.config': 'magicstick-exclusive'})['available'])
        self.assertTrue(self.nvidia_status({'nvidia.com/gpu.count': '4'})['available'])
        self.assertEqual(self.writes, [])

    def test_global_mig_strategy_is_not_confused_with_enabled_mig_partitions(self):
        self.assertTrue(self.nvidia_status({'nvidia.com/mig.strategy': 'single', 'nvidia.com/mig.capable': 'false'})['available'])
        labels = {'nvidia.com/mig.strategy': 'single', 'nvidia.com/mig.capable': 'true',
                  'nvidia.com/mig.config': 'all-disabled', 'nvidia.com/mig.config.state': 'success'}
        self.assertTrue(self.nvidia_status(labels)['available'])
        self.assertFalse(self.nvidia_status({**labels, 'nvidia.com/mig.config.state': 'pending'})['available'])
        self.assertFalse(self.nvidia_status({**labels, 'nvidia.com/mig.config': 'all-1g.10gb'})['available'])
        self.assertFalse(self.nvidia_status({**labels, 'nvidia.com/gpu.product': 'EXAMPLE-MIG-1g.10gb'})['available'])
        self.assertEqual(self.writes, [])

    def test_observed_old_mode_is_not_reported_ready_for_new_configuration(self):
        config = {'mode': 'time-slicing', 'maxModels': 3, 'namespace': 'ai'}
        state = self.nvidia_status(config=config, observed={'mode': 'exclusive', 'maxModels': 2, 'phase': 'Ready'})
        self.assertEqual(state['mode'], 'shared')
        self.assertEqual(state['phase'], 'Starting')
        state = self.nvidia_status(config=config, observed={**config, 'phase': 'Ready'})
        self.assertEqual(state['phase'], 'Ready')

    def test_dra_readiness_replaces_extended_resource_without_fake_gpu_cards(self):
        node = {'metadata': {'name': 'example-node', 'labels': {'appliance.magicstick.dev/amd-dra-ready': 'true'}},
                'status': {'nodeInfo': {'architecture': 'amd64'}, 'allocatable': {}, 'capacity': {}}}
        catalog = {'targets': {'amd-gpu': {'kind': 'gpu', 'vendor': 'amd', 'engines': ['OLlama', 'VLLM'],
                                          'resourceNames': ['amd.com/gpu'], 'architectures': ['amd64']}}}
        with patch.dict(self.api, {'ready_schedulable_nodes': lambda: [node], 'compute_target_catalog': lambda: catalog,
                                  'summarized_modules': lambda: {}, 'kv_cache_options': lambda *_: []}):
            target = self.api['compute_target_availability']()['targets'][0]
            self.assertTrue(target['available'])
            self.assertEqual(target['engines'], ['OLlama', 'VLLM'])
            devices = self.api['gpu_resource_placeholders']([node], catalog, [])
            self.assertEqual(len(devices), 1)
            self.assertEqual(devices[0]['computeTarget'], 'amd-gpu')

    def test_nvidia_placeholders_count_physical_devices_not_sharing_slots(self):
        labels = {'nvidia.com/gpu.count': '1', 'nvidia.com/gpu.replicas': '3'}
        node = {'metadata': {'name': 'example-node', 'labels': labels},
                'status': {'capacity': {'nvidia.com/gpu': '3'}, 'allocatable': {'nvidia.com/gpu': '3'}}}
        catalog = {'targets': {'nvidia-gpu': {'kind': 'gpu', 'vendor': 'nvidia', 'resourceNames': ['nvidia.com/gpu']}}}
        self.assertEqual(len(self.api['gpu_resource_placeholders']([node], catalog, [])), 1)
        labels.pop('nvidia.com/gpu.count')
        self.assertEqual(len(self.api['gpu_resource_placeholders']([node], catalog, [])), 1)
        labels['nvidia.com/gpu.count'] = '2'
        node['status']['capacity']['nvidia.com/gpu'] = '6'
        self.assertEqual(len(self.api['gpu_resource_placeholders']([node], catalog, [])), 2)

    def test_route_requires_admin_and_csrf_protection(self):
        # The embedded Handler cannot be inspected by filename; check the
        # source that is actually mounted in the deployment instead.
        from test_dashboard_api import ROOT
        source = (ROOT / 'dashboard-api.yaml').read_text()
        route = source.split('def do_POST(self):', 1)[1].split('if path == "/api/hardware/gpu-sharing":', 1)[1].split('return', 1)[0]
        self.assertIn('self.require_access("admin")', route)
        self.assertIn('validate_dashboard_mutation_request(self)', route)


if __name__ == '__main__':
    unittest.main()
