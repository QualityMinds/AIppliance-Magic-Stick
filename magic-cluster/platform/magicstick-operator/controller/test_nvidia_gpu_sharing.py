import copy
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import yaml

from test_controller import CLUSTER_ROOT, ROOT, load_controller


class NvidiaGpuSharingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def setUp(self):
        self.c = self.controller
        self.c['NVIDIA_SHARING_STATE'] = {}
        self.node = {'metadata': {'name': 'example-node', 'uid': 'example-uid', 'labels': {
            'nvidia.com/gpu.count': '1', 'nvidia.com/gpu.replicas': '3', 'nvidia.com/mig.strategy': 'none',
            'nvidia.com/device-plugin.config': 'magicstick-shared-3',
        }}, 'status': {'allocatable': {'nvidia.com/gpu': '3'}, 'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        self.config = {'mode': 'time-slicing', 'nodeName': 'example-node', 'nodeUid': 'example-uid',
                       'namespace': 'ai', 'maxModels': 3, 'allowExperimental': False}
        self.activation = {'spec': {'parameters': {}}}
        self.policy = {'spec': {'devicePlugin': {'enabled': True, 'config': {'name': 'time-slicing-config'}}}}
        self.cm = yaml.safe_load((CLUSTER_ROOT / 'platform/gpu/nvidia-gpu-operator/time-slicing-config.yaml').read_text())
        self.models = [self.model('model-' + str(i), i) for i in range(4)]
        self.models += [self.model('amd-model', 0, 'amd-gpu'), self.model('cpu-model', 0, 'cpu')]
        self.plugin = {'metadata': {'namespace': 'gpu-operator', 'ownerReferences': [
            {'kind': 'DaemonSet', 'name': 'nvidia-device-plugin-daemonset'}]},
            'spec': {'nodeName': 'example-node'}, 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        self.pods = []
        self.writes, self.deleted = [], []
        self.mocks = {'get_json': lambda _: self.policy, 'get_core_resource': lambda *_: self.cm,
                      'model_activations': lambda: self.models, 'list_items': lambda _: self.pods + [self.plugin],
                      'patch_json': lambda *args: self.writes.append(args),
                      'delete_kubeai_model': lambda *args: self.deleted.append(args)}

    def model(self, name, timestamp, target='nvidia-gpu'):
        return {'metadata': {'name': name, 'creationTimestamp': str(timestamp)},
                'spec': {'type': 'local', 'enabled': True, 'targetNamespace': 'ai', 'local': {'computeTarget': target}}}

    def pod(self, target='nvidia-gpu'):
        resource = 'nvidia.com/gpu' if target == 'nvidia-gpu' else 'amd.com/gpu'
        return {'metadata': {'labels': {'app.kubernetes.io/managed-by': 'kubeai', 'appliance.magicstick.dev/compute-target': target}},
                'spec': {'nodeName': 'example-node', 'containers': [{'resources': {'limits': {resource: '1'}}}]},
                'status': {'phase': 'Running'}}

    def reconcile(self, nodes=None):
        self.activation['spec']['parameters']['gpuSharing'] = json.dumps(self.config)
        with patch.dict(self.c, self.mocks):
            return self.c['reconcile_nvidia_sharing'](nodes or [self.node], self.activation)

    def test_no_explicit_config_preserves_legacy_defaults_without_reading_or_writing(self):
        with patch.dict(self.c, {key: lambda *args: self.fail('Unexpected backend access') for key in self.mocks}):
            state = self.c['reconcile_nvidia_sharing']([self.node], self.activation)
        self.assertFalse(state['managed'])
        self.assertEqual(state['phase'], 'Ready')

    def test_ready_admits_oldest_models_without_counting_other_providers(self):
        self.pods = [self.pod(), self.pod('amd-gpu')]
        state = self.reconcile()
        self.assertEqual(state['phase'], 'Ready')
        self.assertEqual(state['admittedModels'], ['model-0', 'model-1', 'model-2'])
        self.assertEqual(state['activeModels'], 1)
        self.assertEqual(state['slotLimit'], 3)
        self.assertFalse(state['memoryIsolation'])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.deleted, [])

    def test_switch_drains_only_nvidia_models_and_then_changes_only_the_node_config_label(self):
        self.node['metadata']['labels']['nvidia.com/device-plugin.config'] = 'any'
        self.pods = [self.pod(), self.pod('amd-gpu')]
        self.assertEqual(self.reconcile()['phase'], 'Switching')
        self.assertEqual(self.deleted, [('model-' + str(i), 'ai') for i in range(4)])
        self.assertEqual(self.writes, [])
        self.pods = [self.pod('amd-gpu')]
        self.assertEqual(self.reconcile()['phase'], 'Starting')
        self.assertEqual(self.writes, [('/api/v1/nodes/example-node', {'metadata': {'labels': {
            'nvidia.com/device-plugin.config': 'magicstick-shared-3'}}})])

    def test_unmanaged_nvidia_init_container_blocks_switch_before_deletion(self):
        self.node['metadata']['labels']['nvidia.com/device-plugin.config'] = 'any'
        self.pods = [{'metadata': {}, 'spec': {'initContainers': [{'resources': {'limits': {'nvidia.com/gpu': '1'}}}]},
                      'status': {'phase': 'Running'}}]
        state = self.reconcile()
        self.assertEqual(state['phase'], 'Blocked')
        self.assertIn('unmanaged', state['message'])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.deleted, [])

    def test_omni_uses_the_same_admission_and_mode_switch_drain(self):
        self.models[0]['spec']['local']['realtime'] = {'profile': 'qwen3-omni'}
        pod = self.pod()
        pod['metadata']['labels'].update({'app.kubernetes.io/managed-by': 'magicstick-operator',
            'appliance.magicstick.dev/runtime-backend': 'vllm-omni',
            'appliance.magicstick.dev/modelactivation': 'model-0'})
        self.pods = [pod]
        state = self.reconcile()
        self.assertEqual(state['phase'], 'Ready')
        self.assertEqual(state['activeModels'], 1)
        self.assertIn('model-0', state['admittedModels'])
        omni_deleted = []
        self.mocks['delete_realtime_runtime'] = lambda *args: omni_deleted.append(args)
        self.node['metadata']['labels']['nvidia.com/device-plugin.config'] = 'any'
        self.assertEqual(self.reconcile()['phase'], 'Switching')
        self.assertEqual(omni_deleted, [('model-0', 'ai')])
        self.assertEqual(self.deleted, [('model-' + str(i), 'ai') for i in range(1, 4)])
        self.assertEqual(self.writes, [])

    def test_switch_back_to_exclusive_admits_one_model(self):
        self.config['mode'] = 'exclusive'
        labels = self.node['metadata']['labels']
        labels['nvidia.com/device-plugin.config'] = 'magicstick-exclusive'
        labels.pop('nvidia.com/gpu.replicas')
        self.node['status']['allocatable']['nvidia.com/gpu'] = '1'
        state = self.reconcile()
        self.assertEqual(state['phase'], 'Ready')
        self.assertEqual(state['admittedModels'], ['model-0'])
        self.assertEqual(state['slotLimit'], 1)

    def test_unsupported_node_identities_and_custom_profiles_are_never_modified(self):
        original = copy.deepcopy(self.node)
        changes = ({'nvidia.com/gpu.count': '2'}, {'nvidia.com/mig.strategy': 'mixed'},
                   {'nvidia.com/device-plugin.config': 'custom-config'})
        for change in changes:
            self.node = copy.deepcopy(original)
            self.node['metadata']['labels'].update(change)
            with self.subTest(change=change):
                self.assertEqual(self.reconcile()['phase'], 'Blocked')
        self.node = copy.deepcopy(original)
        self.node['metadata']['uid'] = 'replacement-node'
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        self.node = original
        self.assertEqual(self.reconcile([self.node, copy.deepcopy(self.node)])['phase'], 'Blocked')
        self.assertEqual(self.writes, [])
        self.assertEqual(self.deleted, [])

    def test_operator_mig_strategy_does_not_block_non_mig_cards_but_active_mig_is_rejected(self):
        labels = self.node['metadata']['labels']
        labels.update({'nvidia.com/mig.strategy': 'single', 'nvidia.com/mig.capable': 'false'})
        self.assertEqual(self.reconcile()['phase'], 'Ready')
        labels['nvidia.com/mig.strategy'] = 'mixed'
        self.assertEqual(self.reconcile()['phase'], 'Ready')
        labels['nvidia.com/mig.config'] = 'all-1g.10gb'
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        labels['nvidia.com/mig.config'] = 'all-disabled'
        labels['nvidia.com/mig.config.state'] = 'pending'
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        labels.update({'nvidia.com/mig.capable': 'true', 'nvidia.com/mig.config.state': 'success'})
        self.assertEqual(self.reconcile()['phase'], 'Ready')
        self.node['status']['allocatable']['nvidia.com/mig-1g.10gb'] = '1'
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        self.assertEqual(self.writes, [])

    def test_missing_or_modified_shipped_config_and_custom_clusterpolicy_are_not_overwritten(self):
        self.cm['data']['magicstick-shared-3'] = '{}'
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        self.policy['spec']['devicePlugin']['config']['name'] = 'external-config'
        self.assertIn('not using', self.reconcile()['message'])
        self.assertEqual(self.writes, [])
        self.assertEqual(self.deleted, [])

    def test_ready_requires_plugin_and_matching_live_advertised_slots(self):
        self.node['status']['allocatable']['nvidia.com/gpu'] = '2'
        self.assertEqual(self.reconcile()['phase'], 'Starting')
        self.node['status']['allocatable']['nvidia.com/gpu'] = '3'
        self.node['metadata']['labels']['nvidia.com/gpu.replicas'] = '2'
        self.assertEqual(self.reconcile()['phase'], 'Starting')
        self.node['metadata']['labels']['nvidia.com/gpu.replicas'] = '3'
        self.plugin['status']['conditions'][0]['status'] = 'False'
        self.assertEqual(self.reconcile()['phase'], 'Starting')
        self.assertEqual(self.writes, [])

    def test_disabled_module_does_not_change_node_and_permission_error_does_not_crash_loop(self):
        self.activation['spec']['enabled'] = False
        self.assertEqual(self.reconcile()['phase'], 'Blocked')
        self.activation['spec']['enabled'] = True

        def denied(_):
            raise HTTPError('https://example.local/api', 403, 'Forbidden', {}, None)

        self.mocks['get_json'] = denied
        state = self.reconcile()
        self.assertEqual(state['phase'], 'Blocked')
        self.assertIn('HTTP 403', state['message'])
        self.assertEqual(self.writes, [])

    def test_dynamic_profile_keeps_cpu_offloading_and_uses_the_device_plugin_not_dra(self):
        self.reconcile()
        resource = {'metadata': {'name': 'model-0', 'namespace': 'ai'}, 'spec': {
            'minReplicas': 1, 'maxReplicas': 1, 'resourceProfile': 'nvidia-test:1'}}
        runtime = {'computeTarget': 'nvidia-gpu', 'baseResourceProfile': 'nvidia-test:1', 'memoryMi': 8192,
                   'offloading': {'enabled': True}}
        base = {'imageName': 'nvidia-image', 'requests': {'nvidia.com/gpu': '1', 'memory': '4Gi', 'cpu': '2'},
                'runtimeClassName': 'nvidia', 'limits': {'memory': '4Gi'}}
        with patch.dict(self.c, {'get_resource': lambda *_: {'spec': {'values': {'resourceProfiles': {'nvidia-test': base}}}},
                                'get_core_resource': lambda *_: {'data': {'values.json': '{}'}},
                                'patch_json': lambda *args: self.writes.append(args)}):
            self.c['apply_nvidia_sharing_profile'](resource, runtime)
            profile = next(iter(json.loads(self.writes[0][1]['data']['values.json'])['resourceProfiles'].values()))
            self.assertEqual(profile['requests'], {'nvidia.com/gpu': '1', 'memory': '8192Mi', 'cpu': '2'})
            self.assertEqual(profile['limits'], {'nvidia.com/gpu': '1', 'memory': '8192Mi'})
            self.assertEqual(profile['imageName'], 'nvidia-image')
            self.assertEqual(profile['runtimeClassName'], 'nvidia')
            self.assertEqual(profile['nodeSelector']['kubernetes.io/hostname'], 'example-node')
            self.assertEqual(runtime['gpuSharing'], {'mode': 'time-slicing', 'node': 'example-node'})
            self.assertNotIn('claim', json.dumps(resource).lower())
            self.assertNotIn('amd', json.dumps(resource).lower())
            resource['metadata']['name'] = 'model-3'
            with self.assertRaisesRegex(ValueError, 'slot'):
                self.c['apply_nvidia_sharing_profile'](resource, runtime)
            resource['metadata']['name'] = 'model-0'
            resource['spec']['maxReplicas'] = 2
            with self.assertRaisesRegex(ValueError, 'one replica'):
                self.c['apply_nvidia_sharing_profile'](resource, runtime)
            resource['spec']['maxReplicas'] = 1
            resource['spec']['resourceProfile'] = 'nvidia-test:2'
            with self.assertRaisesRegex(ValueError, 'one GPU allocation'):
                self.c['apply_nvidia_sharing_profile'](resource, runtime)

    def test_nvidia_profile_adapter_does_not_touch_amd_or_unmanaged_models(self):
        self.reconcile()
        resource = {'spec': {'resourceProfile': 'amd:1'}}
        original = copy.deepcopy(resource)
        self.c['apply_nvidia_sharing_profile'](resource, {'computeTarget': 'amd-gpu'})
        self.assertEqual(resource, original)
        self.c['NVIDIA_SHARING_STATE']['managed'] = False
        self.c['apply_nvidia_sharing_profile'](resource, {'computeTarget': 'nvidia-gpu'})
        self.assertEqual(resource, original)

    def test_all_shipped_profiles_match_controller_and_legacy_default_is_preserved(self):
        self.assertEqual(json.loads(self.cm['data']['magicstick-exclusive']), self.c['nvidia_sharing_plugin_config']('exclusive', 2))
        for count in range(2, 17):
            self.assertEqual(json.loads(self.cm['data']['magicstick-shared-' + str(count)]), self.c['nvidia_sharing_plugin_config']('time-slicing', count))
        legacy = yaml.safe_load(self.cm['data']['any'])
        self.assertEqual(legacy, self.c['nvidia_sharing_plugin_config']('time-slicing', 2))

    def test_fresh_installation_defaults_to_one_model_per_gpu_for_both_providers(self):
        release = yaml.safe_load((CLUSTER_ROOT / 'platform/gpu/nvidia-gpu-operator/helmrelease.yaml').read_text())
        default = release['spec']['values']['devicePlugin']['config']['default']
        self.assertEqual(default, 'magicstick-exclusive')
        self.assertNotIn('sharing', json.loads(self.cm['data'][default]))
        self.assertEqual(self.c['gpu_sharing_config']({'spec': {'parameters': {}}}), {'mode': 'exclusive'})

    def test_observed_sharing_status_is_published_and_retained_by_the_crd(self):
        self.reconcile()
        catalog = yaml.safe_load((ROOT / 'module-catalog.yaml').read_text())['data']['modules.json']
        statuses = self.c['hardware_operator_statuses'](json.loads(catalog), {}, nodes=[], crd_names=set())
        self.assertEqual(statuses['gpu']['sharing']['phase'], 'Ready')
        self.assertEqual(statuses['gpu']['sharing']['admittedModels'], ['model-0', 'model-1', 'model-2'])
        self.assertNotIn('sharing', statuses['amd-gpu'])
        crd = yaml.safe_load((ROOT / 'crds/appliances.appliance.magicstick.dev.yaml').read_text())
        status = crd['spec']['versions'][0]['schema']['openAPIV3Schema']['properties']['status']
        field = status['properties']['hardwareOperators']['additionalProperties']['properties']['sharing']
        self.assertTrue(field['x-kubernetes-preserve-unknown-fields'])


if __name__ == '__main__':
    unittest.main()
