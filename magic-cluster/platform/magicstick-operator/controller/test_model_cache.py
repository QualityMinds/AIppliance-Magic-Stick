import unittest
from test_controller import load_controller


class ModelCacheGateTests(unittest.TestCase):
    def test_pending_active_and_terminal_operations(self):
        controller = load_controller(cache_gate=True)
        for phase in (None, 'Preparing', 'Succeeded', 'Failed', 'Interrupted', 'Rejected'):
            def items(path):
                self.assertTrue(path.endswith('/hostoperations'))
                return [{'spec': {'action': 'clear-model-cache'}, 'status': {'phase': phase}}]
            controller['list_items'] = items
            self.assertEqual(controller['model_cache_cleanup_active'](), phase in (None, 'Preparing'))
        controller['list_items'] = lambda _: [{'spec': {'action': 'reboot'}}]
        self.assertFalse(controller['model_cache_cleanup_active']())

    def test_pending_cleanup_prevents_each_local_engine_from_creating_a_runtime(self):
        controller = load_controller(cache_gate=True)
        controller['list_items'] = lambda _: [{'spec': {'action': 'clear-model-cache'}}]
        controller['ensure_model_finalizer'] = lambda _: None
        controller['patch_model_status'] = lambda *args, **kwargs: None
        for engine in ('VLLM', 'OLlama', 'FreeToken'):
            activation = {'metadata': {'name': 'example-model', 'namespace': 'ai-system', 'generation': 1},
                'spec': {'type': 'local', 'local': {'engine': engine}}}
            phase, status = controller['reconcile_model_activation'](activation, {}, {})
            self.assertEqual(phase, 'Starting')
            self.assertIn('cache cleanup', status['message'])


if __name__ == '__main__': unittest.main()
