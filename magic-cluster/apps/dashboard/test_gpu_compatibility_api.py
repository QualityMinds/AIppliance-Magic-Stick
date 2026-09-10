import json
import unittest
from datetime import datetime, timedelta, timezone

from test_dashboard_api import load_server


class GPUCompatibilityApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.api['gpu_compatibility_catalog'] = lambda: {'profiles': [
            {'id': 'strix-halo', 'experimental': True},
        ]}

    def node(self, name='node-a', ollama=True, vllm=False):
        labels = {'kubernetes.io/os': 'linux', 'gpu-eligible': 'true'}
        if ollama:
            labels['ollama-eligible'] = 'true'
        if vllm:
            labels['vllm-eligible'] = 'true'
        report = {'nodeUid': name + '-uid', 'memoryArchitecture': 'unified',
                  'kernelVersion': '7.0.0-test', 'bootId': 'boot-a',
                  'generatedAt': datetime.now(timezone.utc).isoformat(),
                  'physicalMemoryMi': 65536, 'gpuAccessibleMi': 49152,
                  'memoryAccountingVerified': False}
        return {'metadata': {'name': name, 'uid': name + '-uid', 'labels': labels,
                             'annotations': {'appliance.magicstick.dev/gpu-host-preflight': json.dumps(report)}},
                'status': {'capacity': {'memory': '64Gi', 'amd.com/gpu': '1'},
                           'allocatable': {'memory': '60Gi', 'amd.com/gpu': '1'},
                           'nodeInfo': {'architecture': 'amd64', 'kernelVersion': '7.0.0-test', 'bootID': 'boot-a'}}}

    def configure_targets(self, nodes):
        self.api['ready_schedulable_nodes'] = lambda: nodes
        self.api['compute_target_catalog'] = lambda: {'targets': {'amd-gpu': {
            'displayName': 'AMD GPU', 'kind': 'gpu', 'vendor': 'amd',
            'architectures': ['amd64'], 'nodeSelector': {'gpu-eligible': 'true'},
            'engines': ['OLlama', 'VLLM'], 'resourceNames': ['amd.com/gpu'],
            'engineProfiles': {'OLlama': {'nodeSelector': {'ollama-eligible': 'true'}},
                               'VLLM': {'nodeSelector': {'vllm-eligible': 'true'}}},
        }}}
        self.api['summarized_modules'] = lambda: {'modules': {}}
        self.api['kv_cache_options'] = lambda *_args: []

    def test_profile_opt_in_requires_explicit_consent(self):
        with self.assertRaisesRegex(ValueError, 'acknowledgement'):
            self.api['validate_gpu_compatibility_parameters']({'compatibilityProfile': 'strix-halo'})
        self.assertEqual(self.api['validate_gpu_compatibility_parameters']({
            'compatibilityProfile': 'strix-halo', 'allowExperimental': True,
        })['allowExperimental'], 'true')

    def test_rejects_unknown_profile_arbitrary_fields_and_non_boolean_consent(self):
        for params in ({'compatibilityProfile': 'unknown', 'allowExperimental': True},
                       {'image': 'untrusted/image'}, {'allowExperimental': 1},
                       {'validationRequest': 'bad/token'}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.api['validate_gpu_compatibility_parameters'](params)

    def test_profile_selection_clears_previous_validation_request(self):
        params = self.api['validate_gpu_compatibility_parameters']({
            'compatibilityProfile': 'strix-halo', 'allowExperimental': 'true',
        })
        self.assertEqual(params['validationRequest'], '')
        self.assertEqual(self.api['validate_gpu_compatibility_parameters']({})['compatibilityProfile'], '')

    def test_profile_mutations_require_admin_even_when_disabling(self):
        self.assertEqual(self.api['module_mutation_access']('amd-gpu', {'parameters': {}}), 'admin')
        self.assertEqual(self.api['module_mutation_access']('gpu', {'parameters': {}}), 'operator')
        with self.assertRaisesRegex(ValueError, 'object'):
            self.api['module_activation_payload']('amd-gpu', True, {'parameters': []})

    def test_registered_gpu_does_not_enable_unvalidated_engine(self):
        self.configure_targets([self.node()])
        target = self.api['compute_target_availability']()['targets'][0]
        self.assertTrue(target['available'])
        self.assertEqual(target['engines'], ['OLlama'])
        self.assertEqual(target['engineAvailability']['VLLM']['reason'], 'engine-not-validated')
        with self.assertRaisesRegex(self.api['RequestError'], 'not passed GPU validation'):
            self.api['require_compute_target_available']('amd-gpu', 'VLLM')

    def test_no_validated_engine_disables_target(self):
        self.configure_targets([self.node(ollama=False)])
        target = self.api['compute_target_availability']()['targets'][0]
        self.assertFalse(target['available'])
        self.assertEqual(target['reason'], 'engine-not-validated')

    def test_shared_pool_charges_cpu_and_gpu_once_and_reserves_system_ram(self):
        reservations = {'cpu': [{'model': 'cpu', 'reservedMi': 4096}],
                        'amd-gpu': [{'model': 'gpu', 'reservedMi': 8192}]}
        pool = self.api['unified_memory_pools']([self.node()], reservations)[0]
        self.assertEqual(pool['totalMi'], 60 * 1024 - 8192)
        self.assertEqual(pool['id'], 'node-a-uid')
        self.assertEqual(pool['reservedMi'], 12288)
        self.assertEqual(pool['unreservedMi'], 40 * 1024)
        self.assertEqual(pool['gpuUnreservedMi'], 36 * 1024)
        self.assertFalse(pool['memoryAccountingVerified'])

    def test_installed_and_firmware_inventory_do_not_expand_model_budgets(self):
        node = self.node()
        key = 'appliance.magicstick.dev/gpu-host-preflight'
        report = json.loads(node['metadata']['annotations'][key])
        report.update(installedMemoryMi=131072, firmwareReservedMi=65536)
        node['metadata']['annotations'][key] = json.dumps(report)
        pool = self.api['unified_memory_pools']([node], {})[0]
        self.assertEqual(pool['installedMemoryMi'], 131072)
        self.assertEqual(pool['firmwareReservedMi'], 65536)
        self.assertEqual(pool['physicalMemoryMi'], 65536)
        self.assertEqual(pool['totalMi'], 52 * 1024)
        self.assertEqual(pool['gpuAccessibleMi'], 48 * 1024)
        old = self.api['unified_memory_pools']([self.node()], {})[0]
        self.assertIsNone(old['installedMemoryMi'])
        self.assertIsNone(old['firmwareReservedMi'])

    def test_stale_node_boot_or_uid_does_not_supply_memory_capacity(self):
        for field in ('bootID', 'kernelVersion'):
            node = self.node()
            node['status']['nodeInfo'][field] = 'changed'
            self.assertEqual(self.api['unified_memory_pools']([node], {}), [])
        node = self.node()
        node['metadata']['uid'] = 'new-uid'
        self.assertEqual(self.api['unified_memory_pools']([node], {}), [])

    def test_expired_or_malformed_host_evidence_does_not_supply_memory_capacity(self):
        for value in ('', 'invalid', (datetime.now(timezone.utc) - timedelta(days=2)).isoformat(),
                      (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()):
            node = self.node()
            key = 'appliance.magicstick.dev/gpu-host-preflight'
            report = json.loads(node['metadata']['annotations'][key])
            report['generatedAt'] = value
            node['metadata']['annotations'][key] = json.dumps(report)
            self.assertEqual(self.api['unified_memory_pools']([node], {}), [])

    def test_cpu_and_gpu_summary_use_same_physical_budget(self):
        self.configure_targets([self.node()])
        self.api['node_memory_samples'] = lambda _nodes: {'node-a': {'availableMi': 50 * 1024, 'source': 'kubelet'}}
        activations = [{'metadata': {'name': 'gpu-model'},
                        'spec': {'type': 'local', 'local': {'computeTarget': 'amd-gpu', 'vramMi': 8192}},
                        'status': {'memoryArchitecture': 'unified', 'memoryRequiredMi': 8192}}]
        result = self.api['compute_memory_summary'](activations, {'available': False})
        cpu, gpu = result['devices']
        self.assertEqual(cpu['totalMi'], 52 * 1024)
        self.assertEqual(cpu['unreservedMi'], 44 * 1024)
        self.assertEqual(cpu['reservedMi'], 8192)
        self.assertEqual(sum(item['reservedMi'] for item in cpu['reservations']), cpu['reservedMi'])
        self.assertEqual(gpu['sharedPoolId'], cpu['sharedPoolId'])
        self.assertEqual(gpu['unreservedMi'], 40 * 1024)

    def test_unified_host_request_floor_is_counted_once(self):
        activation = {'metadata': {'name': 'tiny'},
                      'spec': {'type': 'local', 'local': {'computeTarget': 'amd-gpu', 'vramMi': 100}},
                      'status': {'memoryArchitecture': 'unified', 'memoryRequiredMi': 8192}}
        reservations = self.api['active_model_memory_reservations']([activation])
        self.assertEqual(reservations['amd-gpu'][0]['reservedMi'], 8192)
        self.assertNotIn('cpu', reservations)

    def test_known_unified_reservations_survive_missing_host_evidence(self):
        node = self.node()
        node['metadata']['annotations'] = {}
        self.configure_targets([node])
        self.api['node_memory_samples'] = lambda _nodes: {}
        activation = {'metadata': {'name': 'running-gpu'},
                      'spec': {'type': 'local', 'local': {'computeTarget': 'amd-gpu', 'vramMi': 8192}},
                      'status': {'memoryArchitecture': 'unified', 'memoryRequiredMi': 8192}}
        result = self.api['compute_memory_summary']([activation], {'available': False})
        cpu = result['devices'][0]
        self.assertEqual(result['sharedPools'], [])
        self.assertEqual(cpu['reservedMi'], 8192)
        self.assertEqual(cpu['unreservedMi'], 56 * 1024)
        self.assertFalse(cpu['accountingVerified'])

    def test_estimate_never_uses_unvalidated_large_node(self):
        small, large = self.node(vllm=True), self.node(name='node-b')
        small_report = json.loads(small['metadata']['annotations']['appliance.magicstick.dev/gpu-host-preflight'])
        small_report['gpuAccessibleMi'] = 16384
        small['metadata']['annotations']['appliance.magicstick.dev/gpu-host-preflight'] = json.dumps(small_report)
        self.configure_targets([small, large])
        self.api['model_activations'] = lambda: []
        self.api['estimate_vllm_memory'] = lambda *_args: {'weightsMi': 1024, 'kvCacheMi': 256, 'runtimeReserveMi': 1024}
        result = self.api['estimate_model_memory']({'computeTarget': 'amd-gpu', 'engine': 'VLLM'})
        self.assertEqual(result['maximumMi'], 16384)
        self.assertEqual(len(result['sharedPools']), 1)


if __name__ == '__main__':
    unittest.main()
