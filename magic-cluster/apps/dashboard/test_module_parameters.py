import json
import pathlib
import unittest
from unittest.mock import patch

import yaml
from test_dashboard_api import load_server


class ModuleParameterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()
        path = pathlib.Path(__file__).parents[2] / 'platform/magicstick-operator/module-catalog.yaml'
        cls.catalog = json.loads(yaml.safe_load(path.read_text())['data']['modules.json'])

    def payload(self, module, parameters):
        with patch.dict(self.api, {'catalog_json': lambda: self.catalog}):
            return self.api['module_activation_payload'](module, True, {'parameters': parameters})

    def test_declared_string_parameters_are_accepted_without_rewriting_them(self):
        resource = self.payload('litellm', {'postgresStorage': '20Gi'})
        self.assertEqual(resource['spec']['parameters'], {'postgresStorage': '20Gi'})
        self.assertEqual(self.payload('agent-sandbox', {})['spec']['parameters'], {})

    def test_unknown_nested_non_string_and_oversized_parameters_are_rejected(self):
        for module, values in [('agent-sandbox', {'unknownRegressionField': 'invalid'}),
                               ('litellm', {'postgresStorage': {'nested': 'value'}}),
                               ('litellm', {'postgresStorage': 4}),
                               ('litellm', {'postgresStorage': 'x' * 4097}),
                               ('litellm', {'postgresStorage': 'bad\x00value'}),
                               ('gpu', {'gpuSharing': '{}'})]:
            with self.subTest(module=module, values=values), self.assertRaises(ValueError):
                self.payload(module, values)

    def test_http_rejection_cannot_create_or_patch_runtime_intent(self):
        for payload in ({'parameters': {'unknownRegressionField': 'invalid'}},
                        {'parameters': []}, {'arbitrary': 'invalid'}):
            writes, responses = [], []
            handler = self.api['Handler'].__new__(self.api['Handler'])
            handler.path = '/api/modules/agent-sandbox/enable'
            handler.headers = {}
            handler.handle_edge_guard = lambda: False
            handler.require_access = lambda _: {}
            handler.send_json = lambda value, status=200: responses.append(status)
            handler.send_error_json = lambda status, _: responses.append(status)
            with patch.dict(self.api, {'catalog_json': lambda: self.catalog, 'read_body': lambda _: payload,
                                      'create_or_patch': lambda *args: writes.append(args),
                                      'get_resource': lambda _: self.fail('Invalid input must not look up/write intent')}):
                handler.do_POST()
            self.assertEqual(responses, [400])
            self.assertEqual(writes, [])

    def test_explicit_parameter_map_replaces_legacy_fields_with_revision_fence(self):
        resource = self.payload('agent-sandbox', {})
        current = {'metadata': {'resourceVersion': '7'}, 'spec': {'parameters': {'unknownRegressionField': 'invalid'}}}
        result = self.api['manual_module_activation_patch'](resource, current)
        self.assertEqual(result['metadata']['resourceVersion'], '7')
        self.assertEqual(result['spec']['parameters'], {'unknownRegressionField': None})
        # Enable/disable without a parameter map keeps existing saved settings.
        without = self.api['module_activation_payload']('agent-sandbox', False)
        self.assertNotIn('parameters', self.api['manual_module_activation_patch'](without, current)['spec'])

    def test_http_write_uses_one_snapshot_and_never_adopts_a_concurrent_replacement(self):
        for current in (None, {'metadata': {'resourceVersion': '7'},
                               'spec': {'parameters': {'unknownRegressionField': 'invalid'}}}):
            with self.subTest(existing=bool(current)):
                reads, writes, responses = [], [], []
                handler = self.api['Handler'].__new__(self.api['Handler'])
                handler.path = '/api/modules/agent-sandbox/disable'
                handler.headers = {}
                handler.handle_edge_guard = lambda: False
                handler.require_access = lambda _: {}
                handler.send_json = lambda value, status=200: responses.append(status)
                handler.send_error_json = lambda status, _: responses.append(status)
                def read(path):
                    reads.append(path)
                    return current
                def write(*args):
                    writes.append(args)
                    return {}
                with patch.dict(self.api, {'catalog_json': lambda: self.catalog,
                                          'read_body': lambda _: {'parameters': {}},
                                          'get_resource': read, 'request_json': write,
                                          'create_or_patch': lambda *args: self.fail('Do not re-read and adopt another intent')}):
                    handler.do_POST()
                self.assertEqual(responses, [200])
                self.assertEqual(len(reads), 1)
                self.assertEqual(len(writes), 1)
                method, path, body, *content_type = writes[0]
                if current:
                    self.assertEqual(method, 'PATCH')
                    self.assertEqual(body['metadata']['resourceVersion'], '7')
                    self.assertEqual(content_type, ['application/merge-patch+json'])
                    self.assertEqual(body['spec']['parameters'], {'unknownRegressionField': None})
                else:
                    self.assertEqual(method, 'POST')
                    self.assertTrue(path.endswith('/moduleactivations'))
                    self.assertEqual(body['spec']['parameters'], {})
