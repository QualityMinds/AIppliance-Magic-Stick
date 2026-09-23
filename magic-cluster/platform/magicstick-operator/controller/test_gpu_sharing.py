import copy
import json
import hashlib
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
        self.compat = {'nodes': [{'node': 'example-node', 'nodeUid': 'example-uid', 'eligible': True, 'hostDriverReady': True, 'pciDevices': ['1002:1586']}]}
        self.config = {'mode': 'dra-shared', 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                       'namespace': 'ai', 'maxModels': 2, 'allowExperimental': True}
        self.activation = {'spec': {'parameters': {'gpuSharing': json.dumps(self.config)}}}
        self.current = {'spec': {'draDriver': {'enable': True}}}
        self.slices = [{'spec': {'driver': 'gpu.amd.com', 'nodeName': 'example-node', 'pool': {'name': 'example-node'},
                                'devices': [{'name': 'gpu-0-128', 'attributes': {'resource.kubernetes.io/pciBusID': {'string': '0000:01:00.0'},
                                                                             'deviceID': {'string': '0x1586'}}}]}}]
        identity = json.dumps(['1002', '0x1586', '0000:01:00.0', '', ''], separators=(',', ':'))
        self.slices[0]['spec']['devices'][0]['attributes']['hardwareIdentity'] = {'string': hashlib.sha256(identity.encode()).hexdigest()}
        self.slices[0]['spec']['devices'][0]['name'] = 'gpu-' + hashlib.sha256(identity.encode()).hexdigest()[:24]
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
            'delete_json': lambda *args: self.deleted.append(args),
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

    def test_mode_switch_retires_omni_runtime_and_waits_for_its_claim_consumer(self):
        self.models[0]['spec']['local']['realtime'] = {'profile': 'qwen3-omni-rocm'}
        omni_deleted = []
        self.mocks['delete_realtime_runtime'] = lambda *args: omni_deleted.append(args)
        self.pods = [{'metadata': {'labels': {'app.kubernetes.io/managed-by': 'magicstick-operator',
                        'appliance.magicstick.dev/runtime-backend': 'vllm-omni',
                        'appliance.magicstick.dev/modelactivation': 'model-0',
                        'appliance.magicstick.dev/compute-target': 'amd-gpu'}},
                     'spec': {'resourceClaims': [{'name': 'gpu', 'resourceClaimName': 'shared'}]},
                     'status': {'phase': 'Running'}}]
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['activeModels'], 1)
        self.assertIn('model-0', self.c['GPU_SHARING_STATE']['admittedModels'])
        self.activation['spec']['parameters']['gpuSharing'] = json.dumps({'mode': 'exclusive'})
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Switching')
        self.assertEqual(omni_deleted, [('model-0', 'ai')])
        self.assertNotIn(('model-0', 'ai'), self.deleted)
        self.assertIn(('model-1', 'ai'), self.deleted)
        self.pods = []
        self.assertFalse(self.reconcile())

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
        self.assertIn("value: [{'name': 'gpu', 'resourceClaimName': string(variables.claim)}]", expression)
        self.assertIn("value: [{'name': 'gpu'}]", expression)
        self.assertIn("op: 'remove', path: '/spec/containers/0/resources/requests/appliance.magicstick.dev~1amd-dra'", expression)
        self.assertIn("op: 'remove', path: '/spec/containers/0/resources/limits/appliance.magicstick.dev~1amd-dra'", expression)

    def legacy_claim(self):
        self.reconcile()
        claim = copy.deepcopy(next(r for r in self.applied if r['kind'] == 'ResourceClaim'))
        claim['metadata'].update(name='magicstick-amd-shared-legacy', uid='legacy-uid', resourceVersion='12')
        claim['metadata']['annotations'].pop('appliance.magicstick.dev/gpu-identity')
        self.applied.clear()
        self.claims = [claim]
        return claim

    def test_unused_legacy_claim_is_uid_guarded_and_new_claim_waits_for_deletion(self):
        self.legacy_claim()
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Switching')
        self.assertFalse(any(r['kind'] == 'ResourceClaim' for r in self.applied))
        self.assertEqual(self.deleted[-1][1]['preconditions'], {'uid': 'legacy-uid', 'resourceVersion': '12'})
        self.claims = []
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Ready')

    def test_reserved_terminating_and_terminal_referenced_claims_are_not_deleted(self):
        claim = self.legacy_claim()
        for phase in ('Running', 'Succeeded', 'Failed'):
            self.pods = [{'metadata': {'namespace': 'ai', 'deletionTimestamp': 'example-time'},
                          'spec': {'resourceClaims': [{'resourceClaimName': claim['metadata']['name']}]}, 'status': {'phase': phase}}]
            self.assertIsNone(self.reconcile())
            self.assertEqual(self.deleted, [])
        self.pods = []
        claim['status'] = {'reservedFor': [{'name': 'consumer-a'}, {'name': 'consumer-b'}]}
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.deleted, [])
        self.assertIn('all consuming Pods', self.c['GPU_SHARING_STATE']['message'])

    def test_foreign_claims_and_changed_selection_are_never_cleaned(self):
        claim = self.legacy_claim()
        claim['metadata']['labels']['app.kubernetes.io/managed-by'] = 'other'
        self.assertTrue(self.reconcile())
        self.assertEqual(self.deleted, [])
        claim['metadata']['labels']['app.kubernetes.io/managed-by'] = 'magicstick-operator'
        claim['spec']['devices']['requests'][0]['exactly']['count'] = 2
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.deleted, [])

    def test_claim_name_uses_hardware_identity_not_drm_number(self):
        device = self.c['amd_dra_devices'](self.slices, self.node)[0]
        before = self.c['dra_shared_claim'](self.config, device)
        device['name'] = 'gpu-9-139'
        self.assertEqual(before, self.c['dra_shared_claim'](self.config, device))

    def test_crashloop_is_allocation_failure_not_driver_installation(self):
        self.driver_pods[0]['status'] = {'containerStatuses': [{'state': {'waiting': {'reason': 'CrashLoopBackOff'}}}]}
        self.assertTrue(self.reconcile())  # Keep DRA installed to recover, do not switch backends.
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')
        self.assertIn('host driver is ready', self.c['GPU_SHARING_STATE']['message'])

    def test_unverifiable_hardware_identity_is_rejected(self):
        device = self.slices[0]['spec']['devices'][0]
        for identity in ('', '[]', '"wrong"'):
            device['attributes']['hardwareIdentity']['string'] = identity
            self.assertIsNone(self.reconcile())
            self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')

    def test_resource_slice_identity_digest_matches_hardware_fields(self):
        device = self.slices[0]['spec']['devices'][0]
        device['attributes']['hardwareUUID'] = {'string': 'a' * 32}
        device['attributes']['partitionProfile'] = {'string': 'spx_nps1'}
        identity = json.dumps(['1002', '0x1586', '0000:01:00.0', 'a' * 32, 'spx_nps1'], separators=(',', ':'))
        digest = hashlib.sha256(identity.encode()).hexdigest()
        device['attributes']['hardwareIdentity']['string'] = digest
        device['name'] = 'gpu-' + digest[:24]
        self.assertTrue(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Ready')
        device['attributes']['hardwareUUID']['string'] = 'b' * 32
        self.assertIsNone(self.reconcile())
        self.assertEqual(self.c['GPU_SHARING_STATE']['phase'], 'Blocked')


if __name__ == '__main__':
    unittest.main()
