import copy
import json
import unittest
from urllib.error import HTTPError

from test_controller import load_controller


class GpuDiagnosticRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()
        self.history = {'metadata': {'resourceVersion': '1'}, 'data': {'records.json': '{}'}}
        self.writes, self.patches = [], []
        self.c['get_core_resource'] = lambda *args: copy.deepcopy(self.history)
        self.c['apply_resource'] = self.writes.append
        self.c['patch_json'] = self.patch
        self.job = {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {
            'name': 'gpu-check-' + 'a' * 24, 'namespace': 'ai', 'uid': 'job-uid',
            'labels': {'app.kubernetes.io/managed-by': 'magicstick-operator'},
            'annotations': {'appliance.magicstick.dev/validation-request': 'dashboard-example',
                            'appliance.magicstick.dev/validation-engine': 'OLlama',
                            'appliance.magicstick.dev/validation-node': 'example-node',
                            'appliance.magicstick.dev/validation-context': 'example-context'}},
            'spec': {}, 'status': {'conditions': [{'type': 'Complete', 'status': 'True'}]}}
        self.pods = [{'metadata': {'ownerReferences': [{'uid': 'job-uid'}]},
                      'status': {'initContainerStatuses': [{'name': 'engine', 'imageID': 'example/runtime@sha256:' + 'a' * 64}]}}]

    def patch(self, path, body):
        self.patches.append((path, copy.deepcopy(body)))
        if '/configmaps/' in path:
            self.assertEqual(body['metadata']['resourceVersion'], self.history['metadata']['resourceVersion'])
            self.history['data'].update(body['data'])
            self.history['metadata']['resourceVersion'] = str(int(self.history['metadata']['resourceVersion']) + 1)
            return copy.deepcopy(self.history)
        return body

    def test_result_and_image_identity_survive_job_ttl_and_controller_restart(self):
        self.c['gpu_validation_history']([self.job], self.pods)
        self.assertIn('/configmaps/', self.patches[0][0])
        self.assertEqual(self.patches[1][1]['spec'], {'ttlSecondsAfterFinished': 300})
        archived = self.c['gpu_validation_history']([], [])
        self.assertEqual(len(archived), 1)
        self.assertEqual(self.c['gpu_job_state'](archived[0]), 'passed')
        self.assertEqual(archived[0]['_imageId'], self.pods[0]['status']['initContainerStatuses'][0]['imageID'])
        self.assertFalse(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(self.writes, [])

    def test_deleted_running_job_is_consumed_not_restarted(self):
        self.job['status'] = {}
        self.assertTrue(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(len(self.writes), 1)
        archived = self.c['gpu_validation_history']([], [])
        self.assertEqual(self.c['gpu_job_state'](archived[0]), 'failed')
        self.assertFalse(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(len(self.writes), 1)

    def test_image_evidence_is_retained_after_completed_pod_disappears(self):
        self.c['gpu_validation_history']([self.job], self.pods)
        self.c['gpu_validation_history']([self.job], [])
        archived = self.c['gpu_validation_history']([], [])
        self.assertEqual(archived[0]['_imageId'], self.pods[0]['status']['initContainerStatuses'][0]['imageID'])

    def test_api_outage_neither_cleans_jobs_nor_starts_new_tests(self):
        def unavailable(*args):
            raise HTTPError('https://example.local/api', 503, 'Unavailable', {}, None)
        self.c['patch_json'] = unavailable
        self.assertEqual(self.c['gpu_validation_history']([self.job], self.pods), [self.job])
        self.assertFalse(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(self.writes, [])
        self.assertEqual(self.patches, [])

    def test_foreign_jobs_are_never_archived_or_given_a_ttl(self):
        self.job['metadata']['labels']['app.kubernetes.io/managed-by'] = 'other'
        self.c['gpu_validation_history']([self.job], self.pods)
        self.assertEqual(self.patches, [])

    def test_active_job_overrides_consumed_receipt_and_cannot_be_ttl_deleted(self):
        self.job['status'] = {}
        self.assertTrue(self.c['create_gpu_validation_job'](self.job))
        jobs = self.c['gpu_validation_history']([self.job], self.pods)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(self.c['gpu_job_state'](jobs[0]), 'running')
        self.assertTrue(all('/jobs/' not in path for path, _ in self.patches))

    def test_history_capacity_and_revision_conflict_fail_closed(self):
        self.history['data']['records.json'] = json.dumps({'old': 'x' * 750000})
        self.assertFalse(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(self.writes, [])
        self.history['data']['records.json'] = '{}'
        def conflict(*args):
            raise HTTPError('https://example.local/api', 409, 'Conflict', {}, None)
        self.c['patch_json'] = conflict
        self.assertFalse(self.c['create_gpu_validation_job'](self.job))
        self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
