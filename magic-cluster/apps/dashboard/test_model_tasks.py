import unittest
from unittest.mock import patch

from test_dashboard_api import load_server


class ModelTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def test_huggingface_tasks_use_pipeline_or_generation_head_not_names(self):
        infer = self.api['inferred_hf_model_type']
        for pipeline in ('text-generation', 'image-text-to-text', 'conversational'):
            self.assertEqual(infer({'pipeline_tag': pipeline}), 'chat')
        for pipeline in ('feature-extraction', 'sentence-similarity'):
            self.assertEqual(infer({'pipeline_tag': pipeline}), 'embedding')
        self.assertEqual(infer({}, {'architectures': ['ExampleForCausalLM']}), 'chat')
        self.assertIsNone(infer({'id': 'looks-like-an-embedding-model'}))
        self.assertIsNone(infer({'pipeline_tag': 'image-classification'}, {'architectures': ['ExampleForCausalLM']}))
        self.assertIsNone(infer({}, {'architectures': ['BertModel']}))

    def test_ollama_uses_complete_gguf_pooling_metadata_including_zero(self):
        infer = self.api['inferred_ollama_model_type']
        self.assertEqual(infer({'ggufMetadata': {'general.architecture': 'llama'}}), 'chat')
        for pooling in (0, 1, 2):
            self.assertEqual(infer({'ggufMetadata': {'general.architecture': 'bert', 'bert.pooling_type': pooling}}), 'embedding')
        self.assertIsNone(infer({'reference': {'model': 'embed'}}))
        self.assertIsNone(infer({'ggufMetadata': {'general.architecture': 'llama'}, 'ggufMetadataError': 'Incomplete header'}))

    def create(self, engine='VLLM', task='auto', metadata=None, **local):
        with patch.dict(self.api, {
            'hf_metadata': lambda _: metadata or {},
            'ollama_metadata': lambda _: metadata or {},
            'compute_target_catalog': lambda: {'targets': {'nvidia-gpu': {'kind': 'gpu'}}},
            'model_presets': lambda: {'example-preset': {'type': 'embedding'}},
        }):
            return self.api['model_activation_payload']('local', {'name': 'example-model', 'local': {
                'engine': engine, 'computeTarget': 'nvidia-gpu', 'modelType': task,
                'url': 'hf://example/model' if engine == 'VLLM' else 'ollama://example:latest', **local,
            }})

    def test_automatic_creation_persists_the_resolved_task_for_both_engines_and_presets(self):
        for engine, metadata in [('VLLM', {'modelApi': {'pipeline_tag': 'feature-extraction'}}),
                                  ('OLlama', {'ggufMetadata': {'general.architecture': 'bert', 'bert.pooling_type': 2}})]:
            with self.subTest(engine=engine):
                self.assertEqual(self.create(engine=engine, metadata=metadata)['spec']['local']['modelType'], 'embedding')
        self.assertEqual(self.create(preset='example-preset')['spec']['local']['modelType'], 'embedding')

    def test_unknown_automatic_task_is_rejected_but_explicit_choices_stay_supported(self):
        with self.assertRaisesRegex(self.api['RequestError'], 'could not be detected'):
            self.create()
        for task in ('chat', 'embedding'):
            self.assertEqual(self.create(task=task)['spec']['local']['modelType'], task)
        with self.assertRaisesRegex(ValueError, 'modelType'):
            self.create(task='invalid')

    def test_automatic_estimates_report_unknown_separately_from_conservative_memory_defaults(self):
        metadata = {'config': {'hidden_size': 64, 'num_attention_heads': 2, 'num_hidden_layers': 2},
                    'safetensorsIndex': {'metadata': {'total_size': 1024 * 1024 * 10}}}
        with patch.dict(self.api, {'hf_metadata': lambda _: metadata}):
            payload = {'url': 'hf://example/model', 'modelType': 'auto', 'contextWindow': 1024, 'maxNumSeqs': 1}
            result = self.api['estimate_vllm_memory'](payload, 'nvidia-gpu')
            self.assertIsNone(result['detectedModelType'])
            metadata['modelApi'] = {'pipeline_tag': 'feature-extraction'}
            self.assertEqual(self.api['estimate_vllm_memory'](payload, 'nvidia-gpu')['detectedModelType'], 'embedding')

    def test_automatic_discovery_keeps_chat_and_embedding_candidates(self):
        context = self.api['ollama_discovery_context']({'modelType': ['']})
        self.assertEqual(context['modelType'], '')
        for name in ('chat-example', 'example-embed'):
            self.assertEqual(self.api['ollama_model_compatibility'](name, '')[0], 'compatible')
