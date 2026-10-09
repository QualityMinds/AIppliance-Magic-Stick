# SPDX-License-Identifier: BUSL-1.1
import json
import unittest
from test_controller import load_controller


class ModelCapabilitiesTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()

    def deployment(self, **info):
        return {'model_name':'custom-alias','litellm_params':{'model':'openai/opaque-alias'},
                'model_info':{'source':'external','ai_appliance_type':'chat',**info}}

    def test_native_litellm_booleans_preserve_explicit_false_and_unknown(self):
        info = {'supports_function_calling':False, 'supports_vision':True, 'supports_reasoning':None}
        entry = self.controller['catalog_entry'](self.deployment(**info))
        self.assertEqual(entry['capabilities'],{'tools':False,'vision':True})
        for invalid in (None, 'false', 1, {}, []):
            entry = self.controller['catalog_entry'](self.deployment(supports_vision=invalid))
            self.assertNotIn('capabilities',entry)

    def test_local_and_external_declarations_reach_litellm(self):
        known = {'tools':True,'vision':False,'reasoning':True}
        kubeai = self.controller['kubeai_deployment']({'metadata':{'name':'local',
            'annotations':{'ai-appliance.io/capabilities':json.dumps(known)}},'spec':{'features':['TextGeneration']}})
        external = self.controller['external_deployment']({'name':'external','model':'openai/alias','capabilities':known})
        for result in (kubeai,external):
            self.assertEqual(self.controller['catalog_entry'](result)['capabilities'],known)
            self.assertNotIn('capabilities',result['litellm_params'])

    def test_removed_declarations_clear_stale_litellm_metadata(self):
        result = self.controller['external_deployment']({'name':'external','model':'openai/alias'})
        for field in ('supports_function_calling','supports_vision','supports_reasoning'):
            self.assertNotIn(field,result['model_info'])
        self.assertNotIn('capabilities',self.controller['catalog_entry'](result))
        self.assertEqual(result['model_info']['ai_appliance_capabilities'],{})
        old = self.controller['external_deployment']({'name':'external','model':'openai/alias','capabilities':{'vision':True}})
        calls = []
        self.controller['desired_deployments'] = lambda:{'external':result}
        self.controller['fetch_litellm_models'] = lambda:[old]
        self.controller['litellm_request'] = lambda method,path,body:calls.append((path,body))
        self.controller['sync_litellm']()
        self.assertEqual([path for path,_ in calls],['/model/'+old['model_info']['id']+'/update'])
        self.assertEqual(calls[0][1]['model_name'],old['model_name'])
        self.assertEqual(calls[0][1]['model_info']['id'],old['model_info']['id'])
        self.assertEqual(calls[0][1]['model_info']['ai_appliance_unknown_capabilities'],['vision'])
        stale = {**result,'model_info':{**result['model_info'],'supports_vision':True}}
        self.assertNotIn('capabilities',self.controller['catalog_entry'](stale))

    def test_direct_runtime_declaration_preserves_realtime_metadata(self):
        self.controller['direct_runtime_activation_ready'] = lambda activation: True
        self.controller['direct_runtime_endpoint'] = lambda activation: 'http://fixture/v1'
        self.controller['direct_runtime_backend'] = lambda activation: 'vllm-omni'
        result = self.controller['direct_runtime_deployment']({'metadata':{'name':'omni'},
            'spec':{'local':{'capabilities':{'vision':True,'tools':False}}}})
        self.assertTrue(result['model_info']['supports_audio_input'])
        self.assertEqual(self.controller['catalog_entry'](result)['capabilities'],{'vision':True,'tools':False})

    def test_exports_use_native_fields_without_changing_token_limits(self):
        info = dict(supports_function_calling=False,supports_vision=True,supports_reasoning=True,
                    max_input_tokens=8192,max_output_tokens=2048)
        data,_ = self.controller['build_catalog']([self.deployment(**info)])
        claw = json.loads(data['openclaw.json'])['models']['providers']['litellm']['models'][0]
        self.assertEqual(claw['compat'],{'supportsTools':False})
        self.assertEqual(claw['input'],['text','image']); self.assertTrue(claw['reasoning'])
        pi = json.loads(data['pi-models.json'])['providers']['litellm']['models'][0]
        self.assertEqual(pi['input'],['text','image']); self.assertTrue(pi['reasoning'])
        self.assertEqual(pi['contextWindow'],8192); self.assertEqual(pi['maxTokens'],2048)
        self.assertNotIn('tools',pi)
        for filename in ('opencode-providers.json','paperclip-opencode-providers.json'):
            entry = json.loads(data[filename])['litellm']['models']['custom-alias']
            self.assertFalse(entry['tool_call']); self.assertTrue(entry['reasoning'])
            self.assertEqual(entry['modalities']['input'],['text','image'])
            self.assertLessEqual(entry['limit']['output'],2048)
        hermes = json.loads(data['hermes.yaml'])
        for provider in ('custom','custom:litellm'):
            self.assertEqual(hermes['model_overrides'][provider]['custom-alias'],
                             {'supports_tools':False,'supports_vision':True,'supports_reasoning':True})

    def test_false_and_unknown_are_not_promoted_to_capabilities(self):
        entry = {'id':'unknown'}
        for adapter in ('openclaw_model','opencode_model'):
            result = self.controller[adapter](entry)
            self.assertNotIn('reasoning',result)
            self.assertNotIn('input',result)
            self.assertNotIn('modalities',result)
        known = {'id':'disabled','capabilities':{'tools':False,'vision':False,'reasoning':False}}
        claw = self.controller['openclaw_model'](known)
        self.assertFalse(claw['reasoning']); self.assertEqual(claw['input'],['text'])
        self.assertFalse(self.controller['opencode_model'](known)['tool_call'])

    def test_fallback_capabilities_require_all_routes_and_respect_a_denial(self):
        yes = self.deployment(supports_vision=True,supports_reasoning=True)
        unknown = self.deployment(supports_reasoning=False)
        data,_ = self.controller['build_catalog']([yes,unknown])
        entry = json.loads(data['catalog.json'])['models'][0]
        self.assertEqual(entry['capabilities'],{'reasoning':False})
        all_yes = json.loads(self.controller['build_catalog']([yes,yes])[0]['catalog.json'])['models'][0]
        self.assertEqual(all_yes['capabilities'],{'vision':True,'reasoning':True})

    def test_capability_change_updates_catalog_hash_without_renaming_model(self):
        old = json.loads(self.controller['build_catalog']([self.deployment(supports_vision=False)])[0]['catalog.json'])
        new = json.loads(self.controller['build_catalog']([self.deployment(supports_vision=True)])[0]['catalog.json'])
        self.assertNotEqual(old['hash'],new['hash'])
        self.assertEqual(old['models'][0]['id'],new['models'][0]['id'])
