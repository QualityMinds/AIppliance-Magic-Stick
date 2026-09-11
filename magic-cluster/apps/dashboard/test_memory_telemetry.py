"""Direct host/GPU counters must not become reservation or working-set estimates."""
import copy
import json
import unittest
from datetime import datetime, timedelta, timezone

from test_dashboard_api import load_server


GIB = 1024 ** 3


class MemoryTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.sample = {
            'schemaVersion': 1, 'source': 'proc-meminfo-amdgpu-sysfs',
            'nodeUid': 'example-uid', 'bootId': 'example-boot', 'kernelVersion': '7.0.0-test',
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'totalBytes': 128 * GIB, 'availableBytes': 48 * GIB,
            'devices': [{'pciAddress': '0000:01:00.0', 'gttTotalBytes': 96 * GIB,
                         'gttUsedBytes': 64 * GIB, 'vramTotalBytes': GIB // 2,
                         'vramUsedBytes': GIB // 4}],
        }
        self.report = {
            'nodeUid': 'example-uid', 'bootId': 'example-boot', 'kernelVersion': '7.0.0-test',
            'generatedAt': self.sample['generatedAt'], 'memoryArchitecture': 'unified',
            'gpuPciAddress': '0000:01:00.0', 'physicalMemoryMi': 128 * 1024,
            'gpuAccessibleMi': 96 * 1024, 'firmwareReservedMi': 512,
            'gpuCapacityMi': 96 * 1024, 'gpuCapacitySource': 'kfd-topology',
            'gpuAllocationMode': 'shared-gtt',
        }

    def node(self, sample=True):
        annotations = {'appliance.magicstick.dev/gpu-host-preflight': json.dumps(self.report)}
        if sample:
            annotations['appliance.magicstick.dev/memory-sample'] = json.dumps(self.sample)
        return {'metadata': {'name': 'example-node', 'uid': 'example-uid', 'annotations': annotations},
                'status': {'capacity': {'memory': '128Gi', 'amd.com/gpu': '1'},
                           'allocatable': {'memory': '128Gi', 'amd.com/gpu': '1'},
                           'nodeInfo': {'bootID': 'example-boot', 'kernelVersion': '7.0.0-test'}}}

    def unexpected_kubelet(self, *_args, **_kwargs):
        self.fail('UMA must not fall back to misleading kubelet working-set metrics')

    def test_host_memavailable_replaces_overstated_kubelet_memory(self):
        self.api['request_json'] = self.unexpected_kubelet
        samples = self.api['node_memory_samples']([self.node()])
        self.assertEqual(samples['example-node']['availableMi'], 48 * 1024)
        self.assertEqual(samples['example-node']['source'], 'host-proc-meminfo')

    def test_loaded_gpu_usage_is_subtracted_from_ceiling_not_linux_ram_again(self):
        nodes = [self.node()]
        samples = self.api['node_memory_samples'](nodes)
        reservations = {'amd-gpu': [{'model': 'example-model', 'reservedMi': 80 * 1024}]}
        pool = self.api['unified_memory_pools'](nodes, reservations, samples)[0]
        self.assertEqual(pool['freeMi'], 48 * 1024)
        self.assertEqual(pool['sharedFreeMi'], 32 * 1024)
        self.assertEqual(pool['gpuUnreservedMi'], 16 * 1024)
        self.assertEqual(pool['dedicatedFreeMi'], 256)

    def test_linux_pressure_further_limits_shared_free(self):
        self.sample['availableBytes'] = 12 * GIB
        result = self.api['gpu_memory_free'](self.report, self.sample, 96 * 1024)
        self.assertEqual(result['sharedFreeMi'], 12 * 1024)

    def test_zero_available_is_known_not_missing(self):
        self.sample['availableBytes'] = 0
        nodes = [self.node()]
        pool = self.api['unified_memory_pools'](nodes, {}, self.api['node_memory_samples'](nodes))[0]
        self.assertEqual(pool['freeMi'], 0)
        self.assertEqual(pool['sharedFreeMi'], 0)

    def test_shared_counter_over_a_lower_mapping_ceiling_clamps_to_zero(self):
        self.assertEqual(self.api['gpu_memory_free'](self.report, self.sample, 32 * 1024)['sharedFreeMi'], 0)

    def test_unknown_and_invalid_gpu_counters_are_not_zero_usage(self):
        for value in (None, -1, True, '0', 1.5, 97 * GIB):
            with self.subTest(value=value):
                sample = copy.deepcopy(self.sample)
                sample['devices'][0]['gttUsedBytes'] = value
                readings = self.api['gpu_memory_free'](self.report, sample, 96 * 1024)
                self.assertIsNone(readings['sharedFreeMi'])
                self.assertEqual(readings['dedicatedFreeMi'], 256)

    def test_gpu_counters_require_one_exact_pci_match_and_consistent_capacity(self):
        for devices in ([], {}, [dict(self.sample['devices'][0], pciAddress='0000:02:00.0')],
                        self.sample['devices'] * 2):
            sample = dict(self.sample, devices=devices)
            self.assertEqual(self.api['gpu_memory_free'](self.report, sample, 96 * 1024),
                             {'sharedFreeMi': None, 'dedicatedFreeMi': None})
        self.assertIsNone(self.api['gpu_memory_free'](self.report, self.sample, 100 * 1024)['sharedFreeMi'])
        self.report['firmwareReservedMi'] = 65536
        self.assertIsNone(self.api['gpu_memory_free'](self.report, self.sample, 96 * 1024)['dedicatedFreeMi'])

    def test_stale_wrong_boot_and_malformed_samples_never_use_kubelet_for_uma(self):
        self.api['request_json'] = self.unexpected_kubelet
        self.api['list_resource'] = self.unexpected_kubelet
        bad_fields = [('generatedAt', (datetime.now(timezone.utc) - timedelta(seconds=91)).isoformat()),
                      ('generatedAt', (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()),
                      ('generatedAt', '2026-01-01'), ('nodeUid', 'other'), ('bootId', 'old'),
                      ('kernelVersion', 'old'), ('source', 'kubelet'), ('schemaVersion', 2),
                      ('availableBytes', -1), ('availableBytes', True), ('availableBytes', 129 * GIB),
                      ('totalBytes', 64 * GIB)]
        for field, value in bad_fields:
            with self.subTest(field=field, value=value):
                node = self.node()
                node['metadata']['annotations']['appliance.magicstick.dev/memory-sample'] = json.dumps(dict(self.sample, **{field: value}))
                self.assertEqual(self.api['node_memory_samples']([node]), {})
        self.assertEqual(self.api['node_memory_samples']([self.node(sample=False)]), {})

    def test_normal_nodes_keep_kubelet_fallback(self):
        node = self.node(sample=False)
        node['metadata']['annotations'] = {}
        self.api['request_json'] = lambda *_args, **_kwargs: {'node': {'memory': {'availableBytes': 60 * GIB}}}
        self.assertEqual(self.api['node_memory_samples']([node])['example-node']['availableMi'], 60 * 1024)

    def test_summary_uses_host_counters_for_cpu_and_confirmed_gpu_domain(self):
        self.api['ready_schedulable_nodes'] = lambda: [self.node()]
        self.api['compute_target_catalog'] = lambda: {'targets': {'amd-gpu': {
            'kind': 'gpu', 'vendor': 'amd', 'resourceNames': ['amd.com/gpu']}}}
        result = self.api['compute_memory_summary']([], {'available': False})
        cpu, gpu = result['devices']
        self.assertEqual(cpu['freeMi'], 48 * 1024)
        self.assertEqual(gpu['freeMi'], 32 * 1024)
        self.assertTrue(gpu['metricsAvailable'])
        self.sample['generatedAt'] = (datetime.now(timezone.utc) - timedelta(seconds=91)).isoformat()
        result = self.api['compute_memory_summary']([], {'available': False})
        self.assertIsNone(result['devices'][0]['freeMi'])
        self.assertIsNone(result['devices'][1]['freeMi'])
        self.assertFalse(result['metricsComplete'])


if __name__ == '__main__':
    unittest.main()
