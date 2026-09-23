import copy
import unittest
import urllib.error
from unittest.mock import patch

from test_controller import load_controller


class ModelPodStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = load_controller()

    def setUp(self):
        self.activation = {'metadata': {'name': 'example-model', 'generation': 3}}
        self.model = {'metadata': {'name': 'example-model', 'uid': 'example-model-uid', 'generation': 2}}
        self.pods = []
        self.paths = []

    def check(self, now='2026-01-01T12:00:00Z'):
        def list_pods(path):
            self.paths.append(path)
            return self.pods
        with patch.dict(self.c, {'now': lambda: now, 'list_items': list_pods}):
            return self.c['model_pod_creation_status'](self.activation, self.model, 'ai', 'example-model')

    def save_tracker(self):
        tracker, state = self.check()
        self.activation['status'] = {'podCreation': tracker}
        return state

    def test_new_model_waits_for_pod_not_runtime_and_uses_scoped_query(self):
        self.assertEqual(self.save_tracker()[:2], ('WaitingForPod', 'WaitingForModelPod'))
        self.assertIn('/namespaces/ai/pods?labelSelector=app%3Dmodel%2Cmodel%3Dexample-model', self.paths[0])

    def terminal_pod(self):
        return {'metadata': {'name': 'model-example', 'uid': 'pod-uid', 'resourceVersion': '42',
                             'ownerReferences': [{'apiVersion': 'kubeai.org/v1', 'kind': 'Model',
                                                  'name': 'example-model', 'uid': 'example-model-uid',
                                                  'controller': True}]},
                'status': {'phase': 'Failed', 'reason': 'UnexpectedAdmissionError',
                           'message': 'no healthy devices present'}}

    def recover(self, time='2026-01-01T12:00:00Z'):
        self.deleted, self.patches = [], []
        with patch.dict(self.c, {'list_items': lambda _: self.pods, 'now': lambda: time,
                                'delete_json': lambda path, body: self.deleted.append((path, body)),
                                'patch_json': lambda path, body: self.patches.append((path, body))}):
            return self.c['recover_terminal_model_pod'](self.activation, self.model, 'ai', 'example-model')

    def test_terminal_owned_pod_is_replaced_with_identity_preconditions_and_failure_detail(self):
        self.pods = [self.terminal_pod()]
        tracker, state = self.recover()
        self.assertEqual(state[:2], ('Starting', 'RecoveringTerminalModelPod'))
        self.assertIn('no healthy devices present', state[2])
        self.assertEqual(tracker['attempts'], 1)
        self.assertEqual(self.patches[0][1]['status']['podRecovery'], tracker)
        self.assertEqual(self.deleted[0][0], '/api/v1/namespaces/ai/pods/model-example')
        self.assertEqual(self.deleted[0][1]['preconditions'], {'uid': 'pod-uid', 'resourceVersion': '42'})

    def test_live_foreign_unowned_terminating_and_unsafe_pods_are_never_deleted(self):
        for mutation in ('Running', 'Pending', 'foreign', 'unowned', 'terminating', 'no-rv', 'no-controller'):
            pod = self.terminal_pod()
            if mutation in ('Running', 'Pending'):
                pod['status']['phase'] = mutation
            elif mutation == 'foreign':
                pod['metadata']['ownerReferences'][0]['uid'] = 'other-model'
            elif mutation == 'unowned':
                pod['metadata']['ownerReferences'] = []
            elif mutation == 'terminating':
                pod['metadata']['deletionTimestamp'] = '2026-01-01T12:00:00Z'
            elif mutation == 'no-rv':
                del pod['metadata']['resourceVersion']
            else:
                pod['metadata']['ownerReferences'][0]['controller'] = False
            self.pods = [pod]
            self.assertEqual(self.recover(), (None, None), mutation)
            self.assertEqual(self.deleted, [], mutation)

    def test_recovery_backoff_and_max_attempts_survive_reconciliation(self):
        self.pods = [self.terminal_pod()]
        tracker, _ = self.recover()
        self.activation['status'] = {'podRecovery': tracker}
        self.assertEqual(self.recover('2026-01-01T12:00:29Z')[1][1], 'ModelPodRecoveryBackoff')
        self.assertEqual(self.deleted, [])
        tracker, _ = self.recover('2026-01-01T12:00:30Z')
        self.assertEqual(tracker['attempts'], 2)
        tracker['attempts'] = 5
        self.activation['status']['podRecovery'] = tracker
        self.assertEqual(self.recover('2026-01-02T12:00:00Z')[1][1], 'ModelPodRecoveryExhausted')
        self.assertEqual(self.deleted, [])
        self.activation['metadata']['generation'] += 1
        self.assertEqual(self.recover('2026-01-02T12:00:00Z')[0]['attempts'], 1)

    def test_pending_replacement_keeps_recovery_attempts(self):
        self.pods = [self.terminal_pod()]
        tracker, _ = self.recover()
        self.activation['status'] = {'podRecovery': tracker}
        self.pods[0]['status']['phase'] = 'Pending'
        self.assertEqual(self.recover(), (tracker, None))

    def test_completed_owned_pod_is_also_replaced(self):
        self.pods = [self.terminal_pod()]
        self.pods[0]['status'] = {'phase': 'Succeeded'}
        tracker, state = self.recover()
        self.assertEqual(tracker['attempts'], 1)
        self.assertEqual(state[1], 'RecoveringTerminalModelPod')
        self.assertEqual(len(self.deleted), 1)

    def test_conflicting_delete_preserves_retry_budget_and_persists_before_delete(self):
        events = []
        def delete(path, body):
            events.append('delete')
            raise urllib.error.HTTPError(path, 409, 'Conflict', {}, None)
        with patch.dict(self.c, {'list_items': lambda _: [self.terminal_pod()],
                                'now': lambda: '2026-01-01T12:00:00Z',
                                'patch_json': lambda *_: events.append('persist'),
                                'delete_json': delete}):
            tracker, state = self.c['recover_terminal_model_pod'](self.activation, self.model, 'ai', 'example-model')
        self.assertEqual(events, ['persist', 'delete'])
        self.assertEqual(tracker['attempts'], 1)
        self.assertEqual(state[1], 'RecoveringTerminalModelPod')

    def test_invalid_naive_or_future_recovery_time_does_not_block_retry(self):
        self.pods = [self.terminal_pod()]
        tracker, _ = self.recover()
        self.activation['status'] = {'podRecovery': tracker}
        for timestamp in ('bad', '2026-01-01T12:00:00', '2099-01-01T00:00:00Z'):
            tracker['lastAttempt'] = timestamp
            self.assertEqual(self.recover()[0]['attempts'], 2)
            self.assertEqual(len(self.deleted), 1)

    def test_missing_pod_becomes_degraded_after_two_minutes_and_keeps_timer(self):
        self.save_tracker()
        self.assertEqual(self.check('2026-01-01T12:01:59Z')[1][0], 'WaitingForPod')
        tracker, state = self.check('2026-01-01T12:02:00Z')
        self.assertEqual(state[:2], ('Degraded', 'ModelPodCreationStalled'))
        self.assertIn('Retrying automatically', state[2])
        self.assertEqual(tracker, self.activation['status']['podCreation'])
        self.assertEqual(self.check('2026-01-01T13:00:00Z')[1][0], 'Degraded')

    def test_new_uid_model_generation_or_activation_generation_resets_timer(self):
        for obj, key, value in ((self.model, 'uid', 'replacement-uid'), (self.model, 'generation', 9),
                                (self.activation, 'generation', 9)):
            with self.subTest(key=key, value=value):
                self.save_tracker()
                old = obj['metadata'][key]
                obj['metadata'][key] = value
                self.assertEqual(self.check('2026-01-01T12:05:00Z')[1][0], 'WaitingForPod')
                obj['metadata'][key] = old

    def test_pending_or_running_pod_clears_stall_without_a_download_timeout(self):
        self.save_tracker()
        for phase in ('Pending', 'Running'):
            self.pods = [{'metadata': {'ownerReferences': [{'kind': 'Model', 'uid': 'example-model-uid'}]},
                          'status': {'phase': phase}}]
            self.assertEqual(self.check('2026-01-01T18:00:00Z'), (None, None))

    def test_terminating_or_previous_model_pods_do_not_mask_missing_pod(self):
        self.save_tracker()
        self.pods = [{'metadata': {'deletionTimestamp': '2026-01-01T12:00:00Z'}},
                     {'metadata': {'ownerReferences': [{'kind': 'Model', 'uid': 'old-uid'}]}}]
        self.assertEqual(self.check('2026-01-01T12:05:00Z')[1][0], 'Degraded')

    def test_invalid_naive_or_future_timestamp_restarts_timer(self):
        self.save_tracker()
        for since in ('bad', '2026-01-01T12:00:00', '2099-01-01T00:00:00Z'):
            self.activation['status']['podCreation']['since'] = since
            tracker, state = self.check('2026-01-01T12:05:00Z')
            self.assertEqual(state[0], 'WaitingForPod')
            self.assertEqual(tracker['since'], '2026-01-01T12:05:00Z')

    def test_status_patch_persists_and_clears_tracker(self):
        tracker, _ = self.check()
        patches = []
        with patch.dict(self.c, {'patch_json': lambda _path, body: patches.append(copy.deepcopy(body))}):
            self.c['patch_model_status'](self.activation, 'WaitingForPod', 'WaitingForModelPod', 'Waiting', pod_creation=tracker)
            self.c['patch_model_status'](self.activation, 'Starting', 'WaitingForReadyReplica', 'Starting')
        self.assertEqual(patches[0]['status']['podCreation'], tracker)
        self.assertIsNone(patches[1]['status']['podCreation'])

    def test_blocked_sharing_is_degraded_not_starting_for_both_providers(self):
        for target, key in (('amd-gpu', 'GPU_SHARING_STATE'), ('nvidia-gpu', 'NVIDIA_SHARING_STATE')):
            statuses = []
            self.activation['spec'] = {'type': 'local', 'local': {'computeTarget': target}}
            with patch.dict(self.c, {
                'ensure_model_finalizer': lambda *_: None,
                'patch_model_status': lambda *args, **kwargs: statuses.append(args),
                key: {'phase': 'Blocked', 'managed': True, 'message': 'GPU sharing setup rejected.'},
            }):
                phase, status = self.c['reconcile_model_activation'](self.activation, {}, {})
            self.assertEqual(phase, 'Degraded')
            self.assertEqual(statuses[-1][2], 'GpuSharingBlocked')
            self.assertEqual(status['message'], 'GPU sharing setup rejected.')

    def test_reconciliation_reports_stall_then_recovers_through_starting_to_ready(self):
        self.activation['spec'] = {'type': 'local', 'targetNamespace': 'ai', 'local': {'computeTarget': 'cpu'}}
        self.model['spec'] = {'minReplicas': 1}
        self.model['status'] = {'replicas': {'all': 0, 'ready': 0}}
        self.save_tracker()
        runtime = {'computeTarget': 'cpu', 'engine': 'VLLM', 'kvCacheType': 'auto',
                   'resourceProfile': 'cpu:1', 'vramMi': 0, 'memoryMi': 4096}
        statuses = []
        mocks = {
            'now': lambda: '2026-01-01T12:05:00Z',
            'list_items': lambda _path: self.pods,
            'ensure_model_finalizer': lambda *_: None,
            'ensure_model_module_activations': lambda *_: None,
            'module_ready': lambda *_: True,
            'kubeai_model_resource': lambda *_: (self.model, copy.deepcopy(runtime)),
            'crd_exists': lambda *_: True,
            'apply_resource': lambda *_: self.model,
            'get_resource': lambda *_: self.model,
            'catalog_contains_model': lambda *_: True,
            'patch_model_status': lambda *args, **kwargs: statuses.append((args, kwargs)),
        }
        with patch.dict(self.c, mocks):
            phase, status = self.c['reconcile_model_activation'](self.activation, {'modules': {}}, {})
            self.assertEqual(phase, 'Degraded')
            self.assertEqual(statuses[-1][0][2], 'ModelPodCreationStalled')
            self.assertEqual(status['podCreation'], self.activation['status']['podCreation'])
            self.pods = [{'metadata': {}, 'status': {'phase': 'Pending'}}]
            phase, status = self.c['reconcile_model_activation'](self.activation, {'modules': {}}, {})
            self.assertEqual(phase, 'Starting')
            self.assertIsNone(status['podCreation'])
            self.assertIsNone(statuses[-1][1]['pod_creation'])
            self.model['status']['replicas'] = {'all': 1, 'ready': 1}
            phase, status = self.c['reconcile_model_activation'](self.activation, {'modules': {}}, {})
            self.assertEqual(phase, 'Ready')
            self.assertIsNone(status['podCreation'])


if __name__ == '__main__':
    unittest.main()
