import copy
import unittest
from unittest.mock import Mock

import test_support  # noqa: F401 -- repository and isolated-job import paths
from runtime import LocalInventory
from mesh_service import MeshError, MeshService, Store


def kubeai(name='ollama-chat', engine='OLlama', ready=1):
    return {'metadata': {'name': name, 'uid': 'uid-' + name},
            'spec': {'engine': engine, 'features': ['TextGeneration']},
            'status': {'replicas': {'ready': ready}}}


def freetoken(name='freetoken-chat', phase='Ready'):
    return {'metadata': {'name': name, 'uid': 'uid-' + name},
            'spec': {'type': 'local', 'enabled': True, 'targetNamespace': 'ai',
                     'local': {'engine': 'FreeToken', 'modelType': 'chat'}},
            'status': {'phase': phase, 'runtimeEndpoint': f'http://{name}.ai.svc.cluster.local:8000/v1'}}


class LocalInventoryTests(unittest.TestCase):
    def setUp(self):
        self.resources = {LocalInventory.MODEL_PATH: [], LocalInventory.ACTIVATION_PATH: []}
        self.reader = Mock(side_effect=lambda path: copy.deepcopy(self.resources[path]))
        self.inventory = LocalInventory(self.reader)

    def test_discovers_all_three_engines_and_service_lists_them(self):
        self.resources[LocalInventory.MODEL_PATH] = [kubeai(), kubeai('vllm-chat', 'VLLM')]
        self.resources[LocalInventory.ACTIVATION_PATH] = [freetoken()]
        self.inventory.refresh()
        self.assertEqual(self.inventory.status(), 'ready')
        self.assertEqual({model['engine'] for model in self.inventory().values()}, {'OLLAMA', 'VLLM', 'FREETOKEN'})
        self.assertEqual(self.inventory()['freetoken-chat']['apiBase'], 'http://freetoken-chat.ai.svc.cluster.local:8000/v1')
        service = MeshService(Store(':memory:'), self.inventory)
        self.addCleanup(service.store.db.close)
        self.assertEqual(set(service.getStatus()['models']), {'ollama-chat', 'vllm-chat', 'freetoken-chat'})
        self.assertEqual({call.args[0] for call in self.reader.call_args_list}, set(self.resources))

    def test_only_ready_models_may_be_shared(self):
        self.resources[LocalInventory.MODEL_PATH] = [kubeai(ready=0)]
        self.resources[LocalInventory.ACTIVATION_PATH] = [freetoken(phase='Stopped')]
        self.inventory.refresh()
        self.assertEqual(self.inventory.status(), 'no_local_model')
        service = MeshService(Store(':memory:'), self.inventory)
        self.addCleanup(service.store.db.close)
        self.assertEqual(service.getStatus()['models'], [])
        for name in ['ollama-chat', 'freetoken-chat']:
            with self.assertRaises(MeshError):
                service._require_local(name)

    def test_rejects_deleted_unidentified_external_and_non_chat_resources(self):
        invalid = [kubeai('deleted'), kubeai('no-uid'), kubeai('embedding'), kubeai('unknown', 'other')]
        invalid[0]['metadata']['deletionTimestamp'] = '2026-01-01T00:00:00Z'
        invalid[1]['metadata'].pop('uid')
        invalid[2]['spec']['features'] = ['TextEmbedding']
        self.resources[LocalInventory.MODEL_PATH] = invalid
        external, disabled, deleted, embedding, no_uid = [freetoken(name) for name in ['external', 'disabled', 'deleted', 'embedding', 'no-uid']]
        external['spec']['type'] = 'external'
        disabled['spec']['enabled'] = False
        deleted['metadata']['deletionTimestamp'] = '2026-01-01T00:00:00Z'
        embedding['spec']['local']['modelType'] = 'embedding'
        no_uid['metadata'].pop('uid')
        self.resources[LocalInventory.ACTIVATION_PATH] = [external, disabled, deleted, embedding, no_uid]
        self.inventory.refresh()
        self.assertEqual(self.inventory(), {})

    def test_freetoken_endpoint_must_be_a_versioned_service_in_its_target_namespace(self):
        for endpoint in ['', 'https://example.com/v1', 'http://backend.other.svc.cluster.local/v1',
                         'http://backend.ai.svc.cluster.local.evil.example.com/v1',
                         'http://user@backend.ai.svc.cluster.local/v1',
                         'http://backend.ai.svc.cluster.local/v1?model=external',
                         'http://backend.ai.svc.cluster.local/v1#fragment',
                         'http://backend.ai.svc.cluster.local:bad/v1',
                         'http://backend.ai.svc.cluster.local:0/v1',
                         'http://backend.ai.svc.cluster.local/other']:
            with self.subTest(endpoint=endpoint):
                model = freetoken()
                model['status']['runtimeEndpoint'] = endpoint
                self.resources[LocalInventory.ACTIVATION_PATH] = [model]
                self.inventory.refresh()
                self.assertEqual(self.inventory(), {})

    def test_provenance_loss_clears_previous_inventory(self):
        self.resources[LocalInventory.MODEL_PATH] = [kubeai()]
        self.inventory.refresh()
        self.assertTrue(self.inventory())
        self.reader.side_effect = OSError('Kubernetes unavailable')
        self.inventory.refresh()
        self.assertEqual(self.inventory(), {})
        self.assertEqual(self.inventory.status(), 'unavailable')

    def test_does_not_guess_between_conflicting_local_backends(self):
        self.resources[LocalInventory.MODEL_PATH] = [kubeai('same-name')]
        self.resources[LocalInventory.ACTIVATION_PATH] = [freetoken('same-name')]
        self.inventory.refresh()
        self.assertEqual(self.inventory(), {})

    def test_partial_status_is_not_ready_and_malformed_responses_clear_old_data(self):
        pending = kubeai()
        pending['status'] = None
        self.resources[LocalInventory.MODEL_PATH] = [pending]
        self.inventory.refresh()
        self.assertEqual(self.inventory.status(), 'no_local_model')
        self.resources[LocalInventory.MODEL_PATH] = [kubeai()]
        self.inventory.refresh()
        self.assertEqual(self.inventory.status(), 'ready')
        self.resources[LocalInventory.ACTIVATION_PATH] = [None]
        self.inventory.refresh()
        self.assertEqual(self.inventory(), {})
        self.assertEqual(self.inventory.status(), 'unavailable')


if __name__ == '__main__':
    unittest.main()
