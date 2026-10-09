import copy
import json
import unittest

from test_controller import load_controller


class InstanceModelTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()
        self.controller['log'] = lambda message: None
        self.models = [
            {'id': 'global-model', 'contextWindow': 128000},
            {'id': 'small-model', 'contextWindow': 8192},
        ]
        self.data = {
            'chat-models.json': json.dumps({'defaultModel': 'global-model', 'models': self.models}),
            'openclaw.json': json.dumps({
                'models': {'providers': {'litellm': {'models': self.models}}},
                'agents': {'defaults': {'model': {'primary': 'litellm/global-model'},
                                       'compaction': {'keepRecentTokens': 20000}}},
            }),
        }
        self.writes = []

    @staticmethod
    def openclaw_instance(name, model):
        return {'metadata': {'name': name, 'uid': 'uid-' + name,
                             'annotations': {'ai-appliance.io/preferred-model': model}},
                'spec': {'config': {'configMapRef': {'name': name + '-model-catalog',
                                                   'key': 'openclaw.json'}}}}

    def openclaw_api(self, instances, existing=None):
        def request(method, path, body=None, **kwargs):
            if method == 'GET' and '/openclawinstances?' in path:
                return {'items': instances}
            if method == 'GET':
                if existing is not None:
                    return copy.deepcopy(existing)
                raise RuntimeError('GET returned 404: missing')
            self.writes.append(copy.deepcopy(body))
            return body
        self.controller['k8s_request'] = request

    def test_openclaw_instances_keep_different_models_and_compaction_budgets(self):
        self.openclaw_api([self.openclaw_instance('small', 'small-model'),
                          self.openclaw_instance('large', 'global-model')])
        self.controller['sync_openclaw_instances'](self.data)
        configs = [json.loads(obj['data']['openclaw.json']) for obj in self.writes]
        self.assertEqual(configs[0]['agents']['defaults']['model']['primary'], 'litellm/small-model')
        self.assertEqual(configs[0]['agents']['defaults']['compaction'],
                         {'keepRecentTokens': 2048})
        self.assertEqual(configs[1]['agents']['defaults']['model']['primary'], 'litellm/global-model')
        self.assertEqual(configs[1]['agents']['defaults']['compaction'], {'keepRecentTokens': 20000})
        self.assertEqual(configs[0]['models'], configs[1]['models'])
        self.assertEqual(self.writes[0]['metadata']['ownerReferences'][0]['uid'], 'uid-small')

    def test_openclaw_removed_model_does_not_silently_switch_to_the_global_default(self):
        self.openclaw_api([self.openclaw_instance('missing', 'withdrawn-model')])
        self.controller['sync_openclaw_instances'](self.data)
        defaults = json.loads(self.writes[0]['data']['openclaw.json'])['agents']['defaults']
        self.assertEqual(defaults['model']['primary'], 'litellm/withdrawn-model')

    def test_openclaw_repeated_sync_does_not_rewrite_the_configmap(self):
        instances = [self.openclaw_instance('small', 'small-model')]
        self.openclaw_api(instances)
        self.controller['sync_openclaw_instances'](self.data)
        existing = self.writes.pop()
        existing['metadata']['resourceVersion'] = '42'
        self.openclaw_api(instances, existing)
        self.controller['sync_openclaw_instances'](self.data)
        self.assertEqual(self.writes, [])

    def test_openclaw_model_change_updates_owned_config_only(self):
        self.openclaw_api([self.openclaw_instance('small', 'small-model')])
        self.controller['sync_openclaw_instances'](self.data)
        existing = self.writes.pop()
        existing['metadata']['resourceVersion'] = '42'
        existing['metadata']['labels']['custom-label'] = 'keep'
        existing['metadata']['annotations'] = {'custom-annotation': 'keep'}
        existing['metadata']['ownerReferences'][0].pop('blockOwnerDeletion')
        self.openclaw_api([self.openclaw_instance('small', 'global-model')], existing)
        self.controller['sync_openclaw_instances'](self.data)
        self.assertEqual(self.writes[0]['metadata']['resourceVersion'], '42')
        self.assertEqual(self.writes[0]['metadata']['labels']['custom-label'], 'keep')
        self.assertEqual(self.writes[0]['metadata']['annotations']['custom-annotation'], 'keep')
        updated = json.loads(self.writes[0]['data']['openclaw.json'])
        self.assertEqual(updated['agents']['defaults']['model']['primary'], 'litellm/global-model')

    def test_openclaw_foreign_and_legacy_configmaps_are_not_modified(self):
        instance = self.openclaw_instance('small', 'small-model')
        self.openclaw_api([instance], {'metadata': {'resourceVersion': '1'}, 'data': {'custom': 'keep'}})
        self.controller['sync_openclaw_instances'](self.data)
        instance['spec']['config']['configMapRef']['name'] = 'ai-model-catalog'
        self.controller['sync_openclaw_instances'](self.data)
        self.assertEqual(self.writes, [])

    def test_operator_managed_pods_are_not_deleted_even_with_a_builtin_selector(self):
        self.assertFalse(self.controller['is_consumer_pod']({'metadata': {
            'labels': {'app.kubernetes.io/instance': 'openclaw', 'app.kubernetes.io/name': 'openclaw'},
            'annotations': {'ai-appliance.io/model-catalog-consumer': 'false'},
        }}))

    def template_api(self, templates):
        def request(method, path, body=None, **kwargs):
            if method == 'GET' and 'labelSelector=' in path:
                return {'items': [obj for name, obj in templates.items() if name != 'litellm-default']}
            name = path.rsplit('/', 1)[-1]
            if method == 'GET':
                return copy.deepcopy(templates[name])
            self.writes.append(copy.deepcopy(body))
            templates[name] = copy.deepcopy(body)
            return body
        self.controller['k8s_request'] = request

    def test_kubeopencode_keeps_instance_choices_and_removes_withdrawn_routes(self):
        templates = {
            'litellm-default': {'metadata': {'name': 'litellm-default'}, 'spec': {'config': {}}},
            'custom': {'metadata': {'name': 'custom'}, 'spec': {'config': {
                'model': 'litellm/small-model', 'small_model': 'litellm/cheap-model',
                'provider': {'litellm': {'options': {'apiKey': '{env:INSTANCE_KEY}'},
                                         'models': {'withdrawn': {'name': 'withdrawn'}}}},
            }, 'podSpec': {'annotations': {'custom-annotation': 'keep'},
                           'nodeSelector': {'worker': 'coding'}}}},
        }
        self.template_api(templates)
        self.controller['sync_agent_templates'](self.data)
        selected = templates['custom']['spec']['config']
        self.assertEqual(selected['model'], 'litellm/small-model')
        self.assertEqual(selected['small_model'], 'litellm/cheap-model')
        self.assertEqual(selected['provider']['litellm']['options']['apiKey'], '{env:INSTANCE_KEY}')
        self.assertNotIn('withdrawn', selected['provider']['litellm']['models'])
        self.assertEqual(templates['litellm-default']['spec']['config']['model'], 'litellm/global-model')
        pod_spec = templates['custom']['spec']['podSpec']
        self.assertEqual(pod_spec['annotations']['custom-annotation'], 'keep')
        self.assertEqual(pod_spec['nodeSelector'], {'worker': 'coding'})
        initial_hash = pod_spec['annotations']['ai-appliance.io/catalog-hash']
        self.writes.clear()
        self.controller['sync_agent_templates'](self.data)
        self.assertEqual(self.writes, [])
        self.data['chat-models.json'] = json.dumps({'defaultModel': 'small-model', 'models': self.models})
        self.controller['sync_agent_templates'](self.data)
        self.assertEqual(templates['custom']['spec']['config']['small_model'], 'litellm/cheap-model')
        self.assertEqual(templates['litellm-default']['spec']['config']['model'], 'litellm/small-model')
        self.assertEqual(templates['custom']['spec']['podSpec']['annotations']
                         ['ai-appliance.io/catalog-hash'], initial_hash)
        self.models[1]['contextWindow'] = 4096
        self.data['chat-models.json'] = json.dumps({'defaultModel': 'small-model', 'models': self.models})
        self.controller['sync_agent_templates'](self.data)
        self.assertNotEqual(templates['custom']['spec']['podSpec']['annotations']
                            ['ai-appliance.io/catalog-hash'], initial_hash)

    def test_kubeopencode_unavailable_instance_model_is_preserved(self):
        templates = {'custom': {'metadata': {'name': 'custom'}, 'spec': {'config': {
            'model': 'litellm/withdrawn', 'small_model': 'litellm/withdrawn',
        }}}, 'litellm-default': {'metadata': {'name': 'litellm-default'}, 'spec': {'config': {}}}}
        self.template_api(templates)
        self.controller['sync_agent_templates'](self.data)
        self.assertEqual(templates['custom']['spec']['config']['model'], 'litellm/withdrawn')

    def test_kubeopencode_placeholder_is_initialized_once_and_discovery_failure_keeps_intent(self):
        templates = {'custom': {'metadata': {'name': 'custom', 'labels': {
            'appliance.magicstick.dev/appinstance': 'custom'}}, 'spec': {'config': {
                'model': 'litellm/CHANGEME_MODEL', 'small_model': 'litellm/CHANGEME_MODEL',
            }}}}
        self.controller['AGENT_TEMPLATE_NAMES'] = ['custom']
        self.template_api(templates)
        self.controller['sync_agent_templates'](self.data)
        config = templates['custom']['spec']['config']
        self.assertEqual(config['model'], 'litellm/global-model')
        self.assertEqual(config['small_model'], 'litellm/global-model')
        config['model'] = 'litellm/small-model'
        self.controller['managed_agent_template_names'] = lambda: []
        self.controller['sync_agent_templates'](self.data)
        self.assertEqual(templates['custom']['spec']['config']['model'], 'litellm/small-model')

    def test_unknown_opencode_limits_are_conservative_and_fit_small_models(self):
        self.assertEqual(self.controller['opencode_model']({'id': 'unknown'})['limit'],
                         {'context': 8192, 'output': 2048})
        self.assertEqual(self.controller['opencode_model']({'id': 'small', 'contextWindow': 1024})['limit'],
                         {'context': 1024, 'output': 256})


if __name__ == '__main__':
    unittest.main()
