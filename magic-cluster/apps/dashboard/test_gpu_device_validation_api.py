import json
import unittest
from datetime import datetime, timezone

from test_dashboard_api import load_server


class DeviceValidationApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.devices = [
            {'id': 'example-uid/0000:01:00.0', 'node': 'example-node', 'nodeUid': 'example-uid', 'bootId': 'example-boot', 'module': 'amd-gpu', 'validationAvailable': True, 'validationContext': 'a' * 64},
            {'id': 'example-uid/0000:02:00.0', 'node': 'example-node', 'nodeUid': 'example-uid', 'bootId': 'example-boot', 'module': 'gpu', 'validationAvailable': True, 'validationContext': 'b' * 64},
        ]
        self.api['appliance'] = lambda: {'status': {'hardwareOperators': {'amd-gpu': {'devices': self.devices[:1]}, 'gpu': {'devices': self.devices[1:]}}}}
        self.node = {'metadata': {'uid': 'example-uid'}, 'status': {'nodeInfo': {'bootID': 'example-boot'}}}
        host = {'nodeUid': 'example-uid', 'bootId': 'example-boot', 'kernelVersion': '7.0-test', 'fingerprint': 'e' * 64, 'generatedAt': datetime.now(timezone.utc).isoformat()}
        self.node['metadata']['annotations'] = {'appliance.magicstick.dev/gpu-host-preflight': json.dumps(host)}
        self.node['status']['nodeInfo']['kernelVersion'] = '7.0-test'
        for device in self.devices:
            device.update(hostFingerprint='e' * 64, activationGeneration=2)
        self.api['get_resource'] = lambda _path: self.node
        self.activations = {x: {'metadata': {'resourceVersion': '7', 'generation': 2}, 'spec': {'enabled': True}} for x in ('amd-gpu', 'gpu')}
        self.api['module_activation'] = lambda name: self.activations[name]
        self.writes = []
        self.api['request_json'] = lambda *args: self.writes.append(args)
        self.payload = {'nodeName': 'example-node', 'nodeUid': 'example-uid', 'engine': 'OLlama', 'deviceIds': [d['id'] for d in self.devices], 'requestId': 'dashboard-example', 'acknowledgeResourceUse': True}

    def test_all_gpus_get_independent_identity_bound_annotations_without_spec_changes(self):
        result = self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(result['deviceIds'], self.payload['deviceIds'])
        self.assertEqual(len(self.writes), 2)
        for method, path, body, content_type in self.writes:
            self.assertEqual(method, 'PATCH')
            self.assertNotIn('spec', body)
            self.assertEqual(body['metadata']['resourceVersion'], '7')
            annotations = body['metadata']['annotations']
            self.assertEqual(len(annotations), 1)
            value = json.loads(next(iter(annotations.values())))
            self.assertEqual(value['requestId'], 'dashboard-example')
            self.assertEqual(value['context'], ('a' if path.endswith('amd-gpu') else 'b') * 64)

    def test_one_nvidia_gpu_never_writes_the_amd_activation(self):
        self.api['request_gpu_engine_validation']({**self.payload, 'deviceIds': [self.devices[1]['id']]})
        self.assertEqual(len(self.writes), 1)
        self.assertTrue(self.writes[0][1].endswith('/moduleactivations/gpu'))

    def test_refuses_unknown_device_cross_node_identity_no_consent_and_unknown_fields(self):
        for change in ({'deviceIds': ['unknown']}, {'deviceIds': []}, {'deviceIds': [self.devices[0]['id']] * 2},
                       {'nodeUid': 'stale'}, {'engine': 'shell'}, {'image': 'arbitrary/image'}, {'acknowledgeResourceUse': False}):
            with self.subTest(change=change), self.assertRaises((ValueError, self.api['RequestError'])):
                self.api['request_gpu_engine_validation']({**self.payload, **change})
        self.assertEqual(self.writes, [])

    def test_all_devices_are_checked_before_any_provider_is_mutated(self):
        self.devices[1]['validationAvailable'] = False
        with self.assertRaises(self.api['RequestError']):
            self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(self.writes, [])

    def test_changed_boot_or_disabled_activation_requires_refresh(self):
        self.node['status']['nodeInfo']['bootID'] = 'other-boot'
        with self.assertRaises(self.api['RequestError']):
            self.api['request_gpu_engine_validation'](self.payload)
        self.node['status']['nodeInfo']['bootID'] = 'example-boot'
        self.activations['gpu']['spec']['enabled'] = False
        with self.assertRaises(self.api['RequestError']):
            self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(self.writes, [])

    def test_running_and_queued_diagnostics_are_not_duplicated(self):
        for state in ('queued', 'running'):
            self.devices[0]['validation'] = {'OLlama': {'state': state}}
            with self.assertRaises(self.api['RequestError']):
                self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(self.writes, [])

    def test_inventory_or_activation_generation_changes_require_new_review(self):
        self.devices[0]['hostFingerprint'] = 'd' * 64
        with self.assertRaises(self.api['RequestError']):
            self.api['request_gpu_engine_validation'](self.payload)
        self.devices[0]['hostFingerprint'] = 'e' * 64
        self.activations['gpu']['metadata']['generation'] = 3
        with self.assertRaises(self.api['RequestError']):
            self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(self.writes, [])

    def test_changed_configuration_has_a_fixed_conflict_code_without_relaxing_review(self):
        self.activations['amd-gpu']['metadata']['generation'] = 3
        with self.assertRaises(self.api['RequestError']) as raised:
            self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(getattr(raised.exception, 'code', None), 'GPU_CONFIGURATION_CHANGED')
        self.assertEqual(raised.exception.generations, {'currentGeneration': 3, 'inventoryGeneration': 2})
        self.assertEqual(self.writes, [])

    def test_public_conflict_reply_exports_only_fixed_code_and_bounded_generations(self):
        responses = []
        handler = self.api['Handler'].__new__(self.api['Handler'])
        handler.send_json = lambda payload, status=200: responses.append((payload, status))
        for current, inventory, expected in ((3, 2, (3, 2)), (True, '2', (None, None)),
                                             (0, 2147483648, (None, None)), (None, None, (None, None))):
            error = self.api['GpuValidationConflict']('GPU_CONFIGURATION_CHANGED', current_generation=current,
                                                       inventory_generation=inventory)
            handler.send_error_json(error.status, str(error), error.code, {**error.generations, 'raw': 'synthetic-private-body'})
            self.assertEqual(responses[-1], ({'error': str(error), 'code': 'GPU_CONFIGURATION_CHANGED',
                'generations': {'currentGeneration': expected[0], 'inventoryGeneration': expected[1]}}, 409))
        handler.send_error_json(400, 'Invalid request', 'UNKNOWN', {'currentGeneration': 3})
        self.assertEqual(responses[-1], ({'error': 'Invalid request'}, 400))
        error = self.api['GpuValidationConflict']('GPU_REQUEST_CONFLICT', ['gpu', 'synthetic-private-body'])
        handler.send_error_json(error.status, str(error), error.code, {'currentGeneration': 3})
        self.assertEqual(responses[-1][0]['code'], 'GPU_REQUEST_CONFLICT')
        self.assertNotIn('generations', responses[-1][0])
        self.assertNotIn('synthetic-private-body', json.dumps(responses))

    def test_a_partial_provider_conflict_is_reported_without_repeating_accepted_work(self):
        def write(*args):
            if args[1].endswith('/gpu'):
                raise self.api['urllib'].error.HTTPError(args[1], 409, 'Conflict', {}, None)
            self.writes.append(args)
        self.api['request_json'] = write
        with self.assertRaisesRegex(self.api['RequestError'], 'Accepted providers: amd-gpu') as raised:
            self.api['request_gpu_engine_validation'](self.payload)
        self.assertEqual(raised.exception.code, 'GPU_REQUEST_CONFLICT')
        self.assertEqual(len(self.writes), 1)


if __name__ == '__main__':
    unittest.main()
