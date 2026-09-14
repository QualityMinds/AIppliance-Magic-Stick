import copy
import json
import unittest
from datetime import datetime, timezone

import yaml

from test_controller import ROOT, load_controller


class PhysicalGpuTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()
        self.catalog = json.loads(yaml.safe_load((ROOT / 'gpu-compatibility-catalog.yaml').read_text())['data']['profiles.json'])
        self.host = {'nodeUid': 'example-uid', 'bootId': 'example-boot', 'kernelVersion': '7.0-test',
                     'fingerprint': 'a' * 64, 'generatedAt': datetime.now(timezone.utc).isoformat(),
                     'displayDevices': [
                         {'pciAddress': '0000:01:00.0', 'vendorId': '1002', 'deviceId': '1586', 'driver': 'amdgpu', 'name': 'AMD Example', 'architecture': 'gfx1151', 'memoryTotalMi': 512},
                         {'pciAddress': '0000:02:00.0', 'vendorId': '10de', 'deviceId': '2684', 'driver': 'nvidia', 'name': 'NVIDIA Example'},
                     ]}
        self.node = {'metadata': {'name': 'example-node', 'uid': 'example-uid', 'labels': {'kubernetes.io/hostname': 'example-node', 'nvidia.com/gpu.count': '1', 'nvidia.com/gpu.memory': '24576', 'nvidia.com/gpu.replicas': '4'}},
                     'status': {'nodeInfo': {'bootID': 'example-boot', 'kernelVersion': '7.0-test'},
                                'allocatable': {'amd.com/gpu': '1', 'nvidia.com/gpu': '4'}, 'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        self.compat = {'nodes': [{'node': 'example-node', 'nodeUid': 'example-uid', 'profileId': 'strix-halo', 'eligible': True,
                                 'memoryArchitecture': 'unified', 'physicalMemoryMi': 65000, 'gpuAccessibleMi': 45000, 'firmwareReservedMi': 512}]}
        self.activations = {name: {'metadata': {'name': name, 'uid': name + '-uid', 'generation': 2}, 'spec': {'enabled': True}}
                            for name in ('amd-gpu', 'gpu')}
        self.jobs, self.pods, self.writes, self.patches = [], [], [], []
        self.c['GPU_SHARING_STATE'] = {}
        self.c['list_items'] = lambda path: (self.jobs if '/jobs?' in path else self.pods) if '/ai-system/' in path else []
        self.c['apply_resource'] = lambda value: self.writes.append(value)
        self.c['patch_json'] = lambda *args: self.patches.append(args)
        self.c['get_core_resource'] = lambda *_args: {'data': {'validate.py': '# probe'}}

    def inventory(self):
        self.node['metadata']['annotations'] = {self.c['GPU_PREFLIGHT_ANNOTATION']: json.dumps(self.host)}
        return self.c['physical_gpu_devices']([self.node], self.compat, self.activations, self.catalog)

    def request(self, engine='OLlama', vendor=None, request_id='dashboard-example'):
        for device, _node, _profile, _host, activation in self.inventory():
            if vendor and device['vendor'] != vendor:
                continue
            key = self.c['gpu_device_request_key'](device['id'], engine)
            activation['metadata'].setdefault('annotations', {})[key] = json.dumps({'requestId': request_id, 'context': device['validationContext']})

    def reconcile(self):
        self.inventory()
        return self.c['reconcile_device_validations']([self.node], self.compat, self.activations, self.catalog)

    def test_two_physical_devices_not_five_sharing_slots_with_device_local_memory(self):
        items = [row[0] for row in self.inventory()]
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['pciId'], '1002:1586')
        self.assertEqual(items[0]['architecture'], 'gfx1151')
        self.assertEqual(items[0]['memory']['firmwareReservedMi'], 512)
        self.assertEqual(items[1]['memoryTotalMi'], 24576)
        self.assertNotIn('memory', items[1])
        self.assertTrue(all(item['validationAvailable'] for item in items))

    def test_no_probe_is_created_merely_for_inventory_or_ready_hardware(self):
        result = self.reconcile()
        self.assertEqual(self.writes, [])
        self.assertEqual([x['validation']['OLlama']['state'] for x in result], ['unverified', 'unverified'])

    def test_all_devices_are_queued_and_run_sequentially(self):
        self.request()
        result = self.reconcile()
        self.assertEqual([x['validation']['OLlama']['state'] for x in result], ['running', 'queued'])
        self.assertEqual(len(self.writes), 1)
        amd_job = copy.deepcopy(self.writes[0])
        amd_job['metadata']['uid'] = 'job-uid'
        amd_job['status'] = {'conditions': [{'type': 'Complete', 'status': 'True'}]}
        self.pods = [{'metadata': {'ownerReferences': [{'uid': 'job-uid'}]}, 'status': {'initContainerStatuses': [{'name': 'engine', 'imageID': 'example/image@sha256:' + 'e' * 64}]}}]
        self.jobs.append(amd_job)
        self.writes.clear()
        result = self.reconcile()
        self.assertEqual([x['validation']['OLlama']['state'] for x in result], ['passed', 'running'])
        self.assertEqual(len(self.writes), 1)
        pod = self.writes[0]['spec']['template']['spec']
        self.assertEqual(pod['initContainers'][0]['resources']['limits']['nvidia.com/gpu'], '1')
        self.assertNotIn('amd.com/gpu', pod['initContainers'][0]['resources']['limits'])
        self.assertEqual(pod['runtimeClassName'], 'nvidia')
        self.assertIn('appliance.magicstick.dev/gpu-host-identity', pod['nodeSelector'])

    def test_single_nvidia_request_never_uses_amd_dra_claim_or_other_engine(self):
        self.c['GPU_SHARING_STATE'] = {'mode': 'dra-shared', 'phase': 'Ready', 'nodeUid': 'example-uid', 'namespace': 'ai', 'claimName': 'example-claim', 'device': {'pciAddress': '0000:01:00.0'}}
        self.request(engine='VLLM', vendor='nvidia')
        result = self.reconcile()
        self.assertEqual(result[0]['validation']['VLLM']['state'], 'unverified')
        self.assertEqual(result[1]['validation']['OLlama']['state'], 'unverified')
        job = self.writes[0]
        self.assertEqual(job['metadata']['namespace'], 'ai-system')
        self.assertNotIn('resourceClaims', job['spec']['template']['spec'])
        env = {e['name']: e['value'] for e in job['spec']['template']['spec']['initContainers'][0]['env']}
        self.assertEqual(env['GPU_PROVIDER'], 'nvidia')

    def test_single_amd_request_uses_only_the_matching_shared_claim(self):
        self.c['GPU_SHARING_STATE'] = {'mode': 'dra-shared', 'phase': 'Ready', 'nodeUid': 'example-uid', 'namespace': 'ai', 'claimName': 'example-claim', 'device': {'pciAddress': '0000:01:00.0'}}
        self.request(vendor='amd')
        self.reconcile()
        job = next(x for x in self.writes if x['kind'] == 'Job')
        self.assertEqual(job['metadata']['namespace'], 'ai')
        self.assertNotIn('ownerReferences', job['metadata'])
        self.assertEqual(job['spec']['template']['spec']['resourceClaims'], [{'name': 'gpu', 'resourceClaimName': 'example-claim'}])
        self.assertNotIn('nvidia.com/gpu', json.dumps(job))

    def test_changed_host_or_profile_never_repeats_a_manual_request(self):
        self.request()
        self.host['fingerprint'] = 'b' * 64
        result = self.reconcile()
        self.assertEqual(self.writes, [])
        self.assertEqual([x['validation']['OLlama']['state'] for x in result], ['stale', 'stale'])

    def test_failed_diagnostic_does_not_disable_the_device_or_retry(self):
        self.request(vendor='nvidia')
        self.reconcile()
        job = self.writes[0]
        job['status'] = {'conditions': [{'type': 'Failed', 'status': 'True'}]}
        self.jobs.append(job)
        self.writes.clear()
        result = self.reconcile()
        self.assertTrue(result[1]['eligible'])
        self.assertEqual(result[1]['validation']['OLlama']['state'], 'failed')
        self.assertEqual(self.writes, [])

    def test_completed_job_without_runtime_image_evidence_is_not_a_pass(self):
        self.request(vendor='nvidia')
        self.reconcile()
        job = self.writes[0]
        job['status'] = {'conditions': [{'type': 'Complete', 'status': 'True'}]}
        self.jobs.append(job)
        self.writes.clear()
        self.assertEqual(self.reconcile()[1]['validation']['OLlama']['state'], 'stale')
        self.assertEqual(self.writes, [])

    def test_multi_vendor_devices_without_exact_binding_are_visible_but_not_blindly_tested(self):
        self.host['displayDevices'].append({**self.host['displayDevices'][1], 'pciAddress': '0000:03:00.0'})
        devices = [x[0] for x in self.inventory()]
        self.assertEqual(len(devices), 3)
        self.assertTrue(devices[0]['validationAvailable'])
        self.assertTrue(all(not x['validationAvailable'] for x in devices[1:]))

    def test_stale_host_inventory_and_mig_do_not_claim_exact_gpu_readiness(self):
        self.host['bootId'] = 'old-boot'
        self.assertEqual(self.inventory(), [])
        self.host['bootId'] = 'example-boot'
        self.node['status']['allocatable']['nvidia.com/mig-1g.10gb'] = '2'
        self.assertFalse(self.inventory()[1][0]['validationAvailable'])

    def test_nvidia_diagnostic_images_match_configured_model_images(self):
        release = yaml.safe_load((ROOT.parents[1] / 'platform/ai/kubeai/base/helmrelease.yaml').read_text())
        servers = release['spec']['values']['modelServers']
        for engine, prefix in [('OLlama', 'ollama'), ('VLLM', 'vllm')]:
            self.assertEqual(self.catalog['diagnostics']['nvidia']['engines'][engine]['image'], servers[engine]['images']['magicstick-' + prefix + '-nvidia'])


if __name__ == '__main__':
    unittest.main()
