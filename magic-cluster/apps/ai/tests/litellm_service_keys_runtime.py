# SPDX-License-Identifier: BUSL-1.1
"""Run in the pinned LiteLLM image with an isolated PostgreSQL fixture."""
import copy
import io
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, '/fixture')
from service_keys import ServiceKeys, PREFIX, KEY_FIELD


def main():
    secrets = {}
    version = 0
    def request(method, path, body=None):
        nonlocal version
        if method == 'GET':
            if path not in secrets:
                raise urllib.error.HTTPError(path, 404, '', {}, io.BytesIO())
            return copy.deepcopy(secrets[path])
        if method == 'DELETE':
            secrets.pop(path, None)
            return {}
        version += 1
        resource = copy.deepcopy(body)
        resource['metadata']['resourceVersion'] = str(version)
        if method == 'POST': path += '/' + body['metadata']['name']
        secrets[path] = resource
        return copy.deepcopy(resource)
    manager = ServiceKeys(request, lambda: 'sk-synthetic-native-admin-key-not-for-production',
                          base_url='http://127.0.0.1:4000', clock=lambda: seconds[0])
    seconds = [100]
    model_id = 'magicstick-native-capability-fixture'
    model = {'model_name':'capability-fixture', 'litellm_params':{'model':'openai/opaque-alias',
             'api_key':'synthetic-upstream','mock_response':'synthetic response'},
             'model_info':{'id':model_id,'supports_function_calling':False,
                           'supports_vision':True,'supports_reasoning':True}}
    manager.api('POST','/model/new',model)
    try:
        info = next(item['model_info'] for item in manager.api('GET','/model/info')['data']
                    if item['model_name'] == model['model_name'])
        assert info['supports_function_calling'] is False
        assert info['supports_vision'] is True and info['supports_reasoning'] is True
        model['model_info'].update({'supports_vision':False,'supports_reasoning':False,'max_input_tokens':8192})
        manager.api('PATCH','/model/'+model_id+'/update',model)
        info = next(item['model_info'] for item in manager.api('GET','/model/info')['data']
                    if item['model_name'] == model['model_name'])
        assert info['supports_vision'] is False and info['supports_reasoning'] is False
        assert info['max_input_tokens'] == 8192
        # The canonical catalog masks removed overrides. LiteLLM's merge and
        # cost-map caches cannot reliably clear their legacy boolean fields.
        model['model_info'] = {'id':model_id,'ai_appliance_capabilities':{},
            'ai_appliance_unknown_capabilities':['tools','vision','reasoning']}
        manager.api('PATCH','/model/'+model_id+'/update',model)
        info = next(item['model_info'] for item in manager.api('GET','/model/info')['data']
                    if item['model_name'] == model['model_name'])
        assert info['ai_appliance_unknown_capabilities'] == ['tools','vision','reasoning']
        from pathlib import Path
        source = Path('/fixture/catalog.py').read_text().replace(
            'K8S_SSL = ssl.create_default_context(cafile=SA_CA_PATH)','K8S_SSL = None')
        namespace = {'__name__':'native_catalog_fixture'}
        exec(compile(source,'catalog.py','exec'),namespace)
        assert 'capabilities' not in namespace['catalog_entry']({'model_name':'capability-fixture',
            'model_info':info,'litellm_params':model['litellm_params']})
    finally:
        manager.api('POST','/model/delete',{'id':model_id})
    owner = {'kind':'AppInstance', 'metadata':{'uid':'native-fixture-a','name':'native-a','namespace':'ai-system'}}
    other = {'kind':'AppInstance', 'metadata':{'uid':'native-fixture-b','name':'native-b','namespace':'ai-system'}}
    path = '/api/v1/namespaces/ai/secrets/native-a-litellm'
    first = manager.ensure(owner, 'ai', 'native-a-litellm')
    manager.ensure(other, 'ai', 'native-b-litellm')
    key = manager.decode(secrets[path], KEY_FIELD)
    def call(route, token, body=None):
        request = urllib.request.Request('http://127.0.0.1:4000' + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, None  # Never print response bodies or credentials.
    body = {'model':'fixture','messages':[{'role':'user','content':'synthetic request'}]}
    assert call('/v1/models',key)[0] == 200
    assert call('/v1/chat/completions',key,body)[0] == 200
    assert call('/key/list',key)[0] in (401,403)
    manager.ensure(owner,'ai','native-a-litellm',enabled=False)
    assert call('/v1/chat/completions',key,body)[0] in (401,403)
    manager.ensure(owner,'ai','native-a-litellm')
    assert call('/v1/chat/completions',key,body)[0] == 200
    owner['metadata']['annotations'] = {PREFIX+'key-revision':'rotate-1'}
    second = manager.ensure(owner,'ai','native-a-litellm')
    assert first['revision'] != second['revision']
    new_key = manager.decode(secrets[path],KEY_FIELD)
    assert new_key != key
    assert call('/v1/chat/completions',new_key,body)[0] == 200
    assert call('/v1/chat/completions',key,body)[0] == 200
    seconds[0] += 900
    manager.ensure(owner,'ai','native-a-litellm')
    assert call('/v1/chat/completions',key,body)[0] in (401,403)
    manager.delete(owner,'ai','native-a-litellm')
    assert call('/v1/chat/completions',new_key,body)[0] in (401,403)
    assert path not in secrets
    assert len(manager.owned_keys(manager.owner(other))) == 1
    manager.delete(other,'ai','native-b-litellm')
    print('Native LiteLLM: capability metadata, unique inference keys, denied admin access, block/resume, rotation grace, revocation and owner isolation verified')


if __name__ == '__main__':
    main()
