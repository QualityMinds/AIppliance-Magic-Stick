# SPDX-License-Identifier: BUSL-1.1
import base64
import copy
import io
import json
import unittest
import urllib.error
import urllib.parse
from unittest.mock import patch
from test_controller import ROOT, load_controller
from service_keys import ServiceKeys, KeyError, PREFIX, KEY_FIELD


class Fixture(ServiceKeys):
    def __init__(self):
        self.secrets = {}
        self.keys = {}
        self.calls = []
        self.seconds = 100
        self.failure = ""
        self.resource_version = 0
        super().__init__(self.request, lambda: 'synthetic-admin-credential', clock=lambda: self.seconds)

    def request(self, method, path, body=None):
        if method == 'GET':
            if path not in self.secrets:
                raise urllib.error.HTTPError(path, 404, '', {}, io.BytesIO())
            return copy.deepcopy(self.secrets[path])
        if method == 'DELETE':
            self.secrets.pop(path, None)
            return {}
        self.resource_version += 1
        item = copy.deepcopy(body)
        if method == 'POST': path += '/' + item['metadata']['name']
        else:
            if item['metadata']['resourceVersion'] != self.secrets[path]['metadata']['resourceVersion']:
                raise urllib.error.HTTPError(path, 409, '', {}, io.BytesIO())
        if self.failure == 'save-active' and KEY_FIELD in item.get('data', {}):
            self.failure = ''
            raise OSError('fixture write failed')
        item['metadata']['resourceVersion'] = str(self.resource_version)
        self.secrets[path] = item
        return copy.deepcopy(item)

    def api(self, method, path, body=None, missing_ok=False):
        self.calls.append((method, path.split('?')[0], copy.deepcopy(body)))
        if path.startswith('/key/list'):
            return {'keys': list(copy.deepcopy(self.keys).values()), 'total_pages': 1}
        if path.startswith('/key/info'):
            key = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)['key'][0]
            return {'info': copy.deepcopy(self.keys[key])} if key in self.keys else None
        if path == '/key/generate':
            token = self.key_id(body['key'])
            self.keys[token] = {'token':token,'metadata':body['metadata'],'blocked':False,'key_type':body['key_type']}
            if self.failure == 'generate-after-commit':
                self.failure = ''
                raise KeyError('fixture API response lost')
            return {'key':body['key']}
        if path == '/key/update':
            self.keys[body['key']]['blocked'] = body['blocked']
            return copy.deepcopy(self.keys[body['key']])
        if path == '/key/delete':
            if self.failure == 'delete': raise KeyError('fixture unavailable')
            for token in body['keys']: self.keys.pop(token, None)
            return {'deleted_keys':body['keys']}
        raise AssertionError(path)


def owner(uid='fixture-uid-a', name='hermes-a'):
    return {'kind':'AppInstance','metadata':{'name':name,'namespace':'ai-system','uid':uid},
            'spec':{'application':'hermes','targetNamespace':'ai','values':{'model':'selected'}}}


class ServiceKeyLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.manager = Fixture()
        self.owner = owner()
        self.path = '/api/v1/namespaces/ai/secrets/hermes-a-litellm'

    def ensure(self, enabled=True):
        return self.manager.ensure(self.owner, 'ai', 'hermes-a-litellm', enabled=enabled)

    def test_each_instance_has_its_own_non_admin_key_and_idempotent_reconciliation(self):
        first = self.ensure()
        initial = copy.deepcopy(self.manager.secrets[self.path])
        self.assertEqual(self.ensure(), first)
        self.assertEqual(self.manager.secrets[self.path], initial)
        self.manager.ensure(owner('fixture-uid-b','hermes-b'), 'ai', 'hermes-b-litellm')
        self.assertEqual(len(self.manager.keys), 2)
        bodies = [body for _,path,body in self.manager.calls if path == '/key/generate']
        self.assertNotEqual(bodies[0]['key'], bodies[1]['key'])
        self.assertTrue(all(body['key_type'] == 'llm_api' for body in bodies))
        self.assertNotIn('synthetic-admin-credential', json.dumps(self.manager.secrets))
        self.assertNotIn('sk-', json.dumps(first))

    def test_api_commit_with_lost_response_retries_the_persisted_candidate(self):
        self.manager.failure = 'generate-after-commit'
        with self.assertRaises(KeyError): self.ensure()
        self.assertIn('PENDING_API_KEY', self.manager.secrets[self.path]['data'])
        self.assertNotIn(KEY_FIELD, self.manager.secrets[self.path]['data'])
        self.ensure()
        self.assertEqual(len(self.manager.keys), 1)
        self.assertEqual(sum(p == '/key/generate' for _,p,_ in self.manager.calls), 1)

    def test_secret_publication_failure_does_not_leak_a_second_key(self):
        self.manager.failure = 'save-active'
        with self.assertRaises(KeyError): self.ensure()
        self.ensure()
        self.assertEqual(len(self.manager.keys), 1)

    def test_rotation_changes_revision_retains_a_grace_period_and_revokes_old_key(self):
        first = self.ensure()
        old_id = next(iter(self.manager.keys))
        self.owner['metadata']['annotations'] = {PREFIX+'key-revision':'rotation-1'}
        second = self.ensure()
        self.assertNotEqual(first['revision'], second['revision'])
        self.assertEqual(len(self.manager.keys), 2)
        self.manager.seconds += 899
        self.ensure(); self.assertIn(old_id, self.manager.keys)
        self.manager.seconds += 1
        self.ensure(); self.assertNotIn(old_id, self.manager.keys)
        self.assertEqual(len(self.manager.keys), 1)

    def test_suspend_blocks_current_and_retiring_keys_and_resume_unblocks_current(self):
        self.ensure()
        self.owner['metadata']['annotations'] = {PREFIX+'key-revision':'rotation-1'}
        self.ensure()
        self.ensure(enabled=False)
        self.assertTrue(all(key['blocked'] for key in self.manager.keys.values()))
        self.ensure()
        self.assertEqual(sum(not key['blocked'] for key in self.manager.keys.values()), 1)

    def test_missing_secret_while_suspended_still_blocks_a_lost_key(self):
        self.ensure(); self.manager.secrets.clear(); self.ensure(enabled=False)
        self.assertTrue(all(key['blocked'] for key in self.manager.keys.values()))

    def test_deleted_secret_revokes_the_lost_key_before_replacement(self):
        self.ensure(); old_id = next(iter(self.manager.keys)); self.manager.secrets.clear()
        self.ensure(); self.assertNotIn(old_id, self.manager.keys); self.assertEqual(len(self.manager.keys), 1)

    def test_database_restore_re_registers_the_existing_secret(self):
        self.ensure(); secret = copy.deepcopy(self.manager.secrets[self.path]); self.manager.keys.clear()
        self.ensure(); self.assertEqual(self.manager.secrets[self.path], secret); self.assertEqual(len(self.manager.keys), 1)

    def test_target_namespace_change_cleans_old_secret_and_revokes_old_key(self):
        self.ensure(); old_id = next(iter(self.manager.keys))
        self.manager.ensure(self.owner, 'tenant', 'hermes-a-litellm')
        self.assertNotIn(self.path, self.manager.secrets)
        self.assertNotIn(old_id, self.manager.keys)
        self.assertEqual(len(self.manager.keys), 1)

    def test_invalid_pagination_or_retirement_metadata_has_a_safe_error(self):
        self.ensure()
        original = self.manager.api
        self.manager.api = lambda *a,**k: {'keys':[], 'total_pages':'synthetic-private'}
        with self.assertRaisesRegex(KeyError, 'invalid pagination'):
            self.manager.delete(self.owner,'ai','hermes-a-litellm')
        self.manager.api = original
        self.manager.secrets[self.path]['metadata']['annotations'][PREFIX+'retiring'] = 'synthetic-private'
        with self.assertRaisesRegex(KeyError, 'Invalid retiring service-key metadata'):
            self.ensure()

    def test_delete_preserves_a_different_instance_and_retries_backend_failure(self):
        self.ensure(); other = owner('fixture-uid-b','hermes-b')
        self.manager.ensure(other,'ai','hermes-b-litellm')
        self.manager.failure = 'delete'
        with self.assertRaises(KeyError): self.manager.delete(self.owner,'ai','hermes-a-litellm')
        self.assertIn(self.path,self.manager.secrets)
        self.manager.failure = ''; self.manager.delete(self.owner,'ai','hermes-a-litellm')
        self.manager.delete(self.owner,'ai','hermes-a-litellm')
        self.assertEqual(len(self.manager.keys),1); self.assertEqual(len(self.manager.secrets),1)

    def test_reused_name_and_foreign_backend_metadata_are_never_adopted(self):
        self.ensure()
        with self.assertRaisesRegex(KeyError,'foreign'):
            self.manager.ensure(owner('different-uid'), 'ai','hermes-a-litellm')
        self.manager.keys[next(iter(self.manager.keys))]['metadata']['magicstick_owner_uid'] = 'foreign'
        with self.assertRaisesRegex(KeyError,'foreign'): self.ensure()

    def test_admin_error_body_never_appears_in_exception(self):
        manager = ServiceKeys(lambda *args: {}, lambda:'synthetic-admin')
        error = urllib.error.HTTPError('http://fixture/key/generate',503,'',{},io.BytesIO(b'{"key":"synthetic-private-key"}'))
        with patch('urllib.request.urlopen',side_effect=error):
            with self.assertRaises(KeyError) as raised: manager.api('POST','/key/generate',{'key':'synthetic-private-key'})
        self.assertNotIn('synthetic-private-key',str(raised.exception))

    def test_incomplete_key_inventory_never_allows_secret_deletion(self):
        self.ensure()
        original = self.manager.api
        def incomplete(method,path,*args,**kwargs):
            return {'keys':[],'total_pages':101} if path.startswith('/key/list') else original(method,path,*args,**kwargs)
        self.manager.api = incomplete
        with self.assertRaisesRegex(KeyError,'incomplete'): self.manager.delete(self.owner,'ai','hermes-a-litellm')
        self.assertIn(self.path,self.manager.secrets)

    def test_finalizer_is_retained_until_backend_cleanup_succeeds(self):
        controller = load_controller(); instance = owner(); instance['metadata']['deletionTimestamp'] = '2026-10-04T00:00:00Z'
        removed = []
        with patch.dict(controller,{'sync_app_instance_access':lambda *a,**k: {},'get_applied_resource':lambda *a:None,
            'reconcile_service_key':lambda *a,**k: (_ for _ in ()).throw(KeyError('fixture unavailable')),
            'remove_app_instance_finalizer':lambda *a:removed.append(a)}):
            with self.assertRaises(KeyError): controller['reconcile_helm_app_instance'](instance,{'litellmKey':True},{})
        self.assertEqual(removed,[])

    def test_suspension_removes_external_access_even_while_key_blocking_retries(self):
        controller = load_controller(); instance = owner(); instance['spec']['enabled'] = False
        access = []
        with patch.dict(controller,{'ensure_app_instance_finalizer':lambda *a:None,
            'sync_app_instance_access':lambda *a,**k:access.append(k['enabled']) or {},
            'reconcile_service_key':lambda *a,**k:(_ for _ in ()).throw(KeyError('fixture unavailable'))}):
            with self.assertRaises(KeyError):
                controller['reconcile_helm_app_instance'](instance,{'litellmKey':True},{})
        self.assertEqual(access,[False])

    def test_helm_values_contain_only_secret_reference_and_rollout_revision(self):
        controller = load_controller(); reference = self.ensure()
        release,_ = controller['app_instance_helmrelease'](self.owner,{'chartPath':'fixtures/chart','litellmKey':True},{},litellm_key=reference)
        self.assertEqual(release['spec']['values']['instance']['litellmKey'],reference)
        self.assertNotIn('sk-',json.dumps(release))
