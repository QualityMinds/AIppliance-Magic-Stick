import copy
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from test_controller import load_controller


class GpuSharingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def setUp(self):
        self.c = self.controller
        self.c['GPU_SHARING_STATE'] = {}
        self.node = {'metadata': {'name': 'example-node', 'uid': 'example-uid'},
                     'status': {'nodeInfo': {'kubeletVersion': 'v1.36.0+k3s1'}}}
        self.compat = {'nodes': [{'node': 'example-node', 'nodeUid': 'example-uid', 'eligible': True, 'pciDevices': ['1002:1586']}]}
        self.config = {'mode': 'dra-shared', 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                       'namespace': 'ai', 'maxModels': 2, 'allowExperimental': True}
        self.activation = {'spec': {'parameters': {'gpuSharing': json.dumps(self.config)}}}
        self.current = {'spec': {'draDriver': {'enable': True}}}
        self.slices = [{'spec': {'driver': 'gpu.amd.com', 'nodeName': 'example-node', 'pool': {'name': 'example-node'},
                                'devices': [{'name': 'gpu-0-128', 'attributes': {'resource.kubernetes.io/pciBusID': {'string': '0000:01:00.0'},
                                                                             'deviceID': {'string': '0x1586'}}}]}}]
        self.models = [{'metadata': {'name': 'model-' + str(i), 'creationTimestamp': str(i)},
                        'spec': {'type': 'local', 'enabled': True, 'local': {'computeTarget': 'amd-gpu'}, 'targetNamespace': 'ai'}} for i in range(3)]
        self.applied, self.deleted = [], []
        self.pods, self.claims = [], []
        self.driver_pods = [{'metadata': {'namespace': 'amd-gpu-operator', 'ownerReferences': [{'kind': 'DaemonSet', 'name': 'default-dra-driver'}]},
                             'spec': {'nodeName': 'example-node', 'containers': [{'image': self.c['AMD_DRA_IMAGE']}]},
                             'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}]
        self.mocks = {
            'model_activations': lambda: self.models,
            'list_items': lambda path: self.slices if 'resourceslices' in path else self.claims if 'resourceclaims' in path else self.pods + self.driver_pods if path == '/api/v1/pods' else self.pods,
            'apply_resource': self.applied.append,
            'get_applied_resource': lambda _: None,
            'delete_kubeai_model': lambda *args: self.deleted.append(args),
            'delete_resource': lambda *args: self.deleted.append(args),
        }

    def reconcile(self):
        with patch.dict(self.c, self.mocks):
            return self.c['reconcile_gpu_sharing']([self.node], self.compat, self.activation, self.current)

    def test_exclusive_default_has_no_dra_side_effects(self):
        self.activation = None
        self.current = {'spec': {'draDriver': {'enable': False}}}
        self.assertFalse(self.reconcile())
        self.assertEqual(self.applied, [])
        self.assertEqual(self.deleted, [])

    def test_rejects_consent_version_identity_and_namespace_errors(self):
        for change in ({'allowExperimental': False}, {'maxModels': 1}, {'maxModels': True}, {'nodeUid': 'old-uid'}, {'namespace': 'other'}):
            self.activation['spec']['parameters']['gpuSharing'] = json.dumps({**self.config, **change})
            self.assertIsNone(self.reconcile())
            self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')
        self.activation['spec']['parameters']['gpuSharing'] = json.dumps(self.config)
        self.node['status']['nodeInfo']['kubeletVersion'] = 'v1.35.0'
        self.assertIsNone(self.reconcile())
        self.assertIn('1.36', self.c['GPU_SHARING_STATE']['message'])
        self.assertEqual(self.applied, [])

    def test_drains_managed_amd_models_before_switch_and_preserves_nvidia(self):
        self.current['spec']['draDriver']['enable'] = False
        self.models += [{'metadata': {'name': 'nvidia-model'}, 'spec': {'type': 'local', 'local': {'computeTarget': 'nvidia-gpu'}}}]
        self.pods = [{'metadata': {'labels': {'app.kubernetes.io/managed-by': 'kubeai'}}, 'spec': {}, 'status': {'phase': 'Running'}}]
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Switching')
        self.assertEqual(self.deleted, [('model-0', 'ai'), ('model-1', 'ai'), ('model-2', 'ai')])
        self.assertEqual(self.applied, [])
        self.pods = []
        self.assertTrue(self.reconcile())

    def test_ready_uses_one_real_device_and_bounds_models_not_memory(self):
        self.assertTrue(self.reconcile())
        state = self.c['GPU_SHARING_STATE']
        self.assertEqual(state['phase'], 'Ready')
        self.assertEqual(state['admittedModels'], ['model-0', 'model-1'])
        self.assertFalse(state['memoryIsolation'])
        self.assertTrue(state['claimName'].startswith('magicstick-amd-shared-'))
        claims = [r for r in self.applied if r['kind'] == 'ResourceClaim']
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]['spec']['devices']['requests'][0]['exactly']['count'], 1)
        selector = claims[0]['spec']['devices']['requests'][0]['exactly']['selectors'][0]['cel']['expression']
        self.assertIn("device.attributes['resource.kubernetes.io'].pciBusID", selector)
        self.assertIn('0000:01:00.0', selector)
        self.assertNotIn('device.name', selector)
        self.assertNotIn('capacity', claims[0]['spec']['devices']['requests'][0]['exactly'])

    def test_missing_duplicate_or_wrong_hardware_does_not_admit_models(self):
        self.slices = []
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Starting')
        self.slices = [{'spec': {'driver': 'gpu.amd.com', 'nodeName': 'example-node', 'devices': [
            {'name': 'gpu-0', 'attributes': {'resource.kubernetes.io/pciBusID': {'string': '0000:01:00.0'}, 'deviceID': {'string': '0xffff'}}}]}}]
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')

    def test_reverse_switch_waits_for_claim_consumers(self):
        self.activation['spec']['parameters']['gpuSharing'] = json.dumps({'mode': 'exclusive'})
        self.claims = [{'metadata': {'name': 'shared', 'namespace': 'ai', 'labels': {'app.kubernetes.io/managed-by': 'magicstick-operator'}}, 'status': {'reservedFor': [{'name': 'model-pod'}]}}]
        self.assertIsNone(self.reconcile())
        self.assertIn('released', self.c['GPU_SHARING_STATE']['message'])
        self.claims[0]['status']['reservedFor'] = []
        self.assertFalse(self.reconcile())
        self.assertIn(('resource.k8s.io', 'v1', 'resourceclaims', 'ai', 'shared'), self.deleted)

    def test_generated_profile_is_fail_closed_and_retains_ram_reservation(self):
        self.reconcile()
        model = {'metadata': {'name': 'model-0', 'namespace': 'ai'}, 'spec': {'minReplicas': 1, 'maxReplicas': 1}}
        runtime = {'computeTarget': 'amd-gpu', 'baseResourceProfile': 'amd-test:1', 'memoryMi': 8192}
        base = {'imageName': 'amd-image', 'requests': {'amd.com/gpu': '1', 'memory': '4Gi'}, 'limits': {'amd.com/gpu': '1'}}
        writes = []
        with patch.dict(self.c, {'get_resource': lambda *_: {'spec': {'values': {'resourceProfiles': {'amd-test': base}}}},
                                'get_core_resource': lambda *_: {'data': {'values.json': '{}'}}, 'patch_json': lambda *args: writes.append(args)}):
            self.c['apply_dra_model_profile'](model, runtime)
            profile = next(iter(json.loads(writes[0][1]['data']['values.json'])['resourceProfiles'].values()))
            self.assertEqual(profile['requests']['memory'], '8192Mi')
            self.assertEqual(profile['limits'], {self.c['DRA_SENTINEL_RESOURCE']: '1'})
            self.assertEqual(profile['nodeSelector']['kubernetes.io/hostname'], 'example-node')
            self.assertEqual(model['spec']['env']['MAGICSTICK_DRA_CLAIM'], self.c['GPU_SHARING_STATE']['claimName'])
            model['metadata']['name'] = 'model-2'
            with self.assertRaisesRegex(ValueError, 'slot'):
                self.c['apply_dra_model_profile'](model, runtime)

    def test_driver_readiness_is_required_even_with_a_stale_resource_slice(self):
        self.driver_pods = []
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Starting')
        self.assertEqual(self.applied, [])

    def test_api_permission_failure_is_reported_without_crashing_other_reconciliation(self):
        def denied(_):
            raise HTTPError('https://example.local/api', 403, 'Forbidden', {}, None)
        self.mocks['get_applied_resource'] = denied
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')
        self.assertIn('HTTP 403', self.c['GPU_SHARING_STATE']['message'])

    def test_claim_reconciliation_is_idempotent_and_rejects_unowned_claims(self):
        self.reconcile()
        resources = {item['kind']: copy.deepcopy(item) for item in self.applied}
        self.applied.clear()
        self.mocks['get_applied_resource'] = lambda item: resources.get(item['kind'])
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Ready')
        self.assertNotIn('ResourceClaim', [item['kind'] for item in self.applied])
        resources['ResourceClaim']['metadata']['labels'].clear()
        self.assertIsNone(self.reconcile())
        self.assertIn('not Magic Stick owned', self.c['GPU_SHARING_STATE']['message'])

    def test_native_adapter_is_narrow_and_non_dra_models_are_unchanged(self):
        policy, _binding = self.c['dra_admission_resources']()
        self.assertEqual(policy['spec']['failurePolicy'], 'Fail')
        self.assertEqual(policy['spec']['matchConstraints']['objectSelector']['matchLabels']['appliance.magicstick.dev/compute-target'], 'amd-gpu')
        self.assertIn('system:serviceaccount:ai:kubeai', policy['spec']['matchConditions'][0]['expression'])
        self.assertNotIn('nvidia.com', json.dumps(policy))
        self.assertEqual(self.c['resource_path']('resource.k8s.io/v1', 'DeviceClass', None, 'gpu.amd.com'), '/apis/resource.k8s.io/v1/deviceclasses/gpu.amd.com')
        model = {'spec': {'env': {}}}
        original = copy.deepcopy(model)
        self.c['apply_dra_model_profile'](model, {'computeTarget': 'nvidia-gpu'})
        self.assertEqual(model, original)

    def test_native_adapter_uses_json_maps_not_typed_object_lists(self):
        policy, _ = self.c['dra_admission_resources']()
        expression = policy['spec']['mutations'][0]['jsonPatch']['expression']
        self.assertNotIn('Object.', expression)
        self.assertIn("value: [{'name': 'gpu', 'resourceClaimName': variables.claim}]", expression)
        self.assertIn("value: [{'name': 'gpu'}]", expression)
        self.assertIn("op: 'remove', path: '/spec/containers/0/resources/requests/appliance.magicstick.dev~1amd-dra'", expression)
        self.assertIn("op: 'remove', path: '/spec/containers/0/resources/limits/appliance.magicstick.dev~1amd-dra'", expression)


if __name__ == '__main__':
    unittest.main()
